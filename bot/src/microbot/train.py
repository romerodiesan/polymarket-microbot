import argparse
import json
import sys
from pathlib import Path

import duckdb
import pandas as pd

from .model import FEATURE_COLUMNS

MIN_TRAINING_ROWS = 1_000
HIGH_CONFIDENCE = 0.6


def load_features(db_path: Path, features_path: Path | None) -> pd.DataFrame:
    if features_path:
        # Reading the Parquet export avoids the DuckDB lock held by a running bot.
        return duckdb.connect().execute(
            "SELECT * FROM read_parquet(?) ORDER BY token_id, ts", [str(features_path)]
        ).fetchdf()
    return duckdb.connect(str(db_path), read_only=True).execute(
        "SELECT * FROM features ORDER BY token_id, ts"
    ).fetchdf()


def label_frame(frame: pd.DataFrame, horizon_seconds: float, min_move: float) -> pd.DataFrame:
    """Attach the midpoint `horizon_seconds` later and keep moves that beat crossing costs.

    A move counts only if it exceeds half the spread plus `min_move`; target is 1 for up moves.
    Rows without a future observation within twice the horizon are dropped.
    """
    frame = frame.sort_values("ts").copy()
    frame["target_ts"] = frame["ts"] + horizon_seconds
    future = frame[["token_id", "ts", "midpoint"]].rename(
        columns={"ts": "future_ts", "midpoint": "future_mid"}
    )
    merged = pd.merge_asof(
        frame.sort_values("target_ts"), future.sort_values("future_ts"),
        left_on="target_ts", right_on="future_ts", by="token_id",
        direction="forward", tolerance=horizon_seconds,
    )
    merged = merged.dropna(subset=["future_mid"])
    merged["move"] = merged["future_mid"] - merged["midpoint"]
    threshold = merged["spread"] / 2 + min_move
    merged = merged[merged["move"].abs() > threshold].copy()
    merged["target"] = (merged["move"] > 0).astype(int)
    return merged.sort_values("ts").reset_index(drop=True)


def temporal_split(frame: pd.DataFrame, horizon_seconds: float, test_fraction: float = 0.2):
    """Split by time, dropping training rows whose label window reaches into the test period."""
    split_ts = frame["ts"].quantile(1 - test_fraction)
    train_df = frame[frame["ts"] + horizon_seconds < split_ts]
    test_df = frame[frame["ts"] >= split_ts]
    return train_df, test_df


def train(db_path: Path, output: Path, horizon_seconds: float, min_move: float,
          features_path: Path | None = None, metrics_path: Path | None = None) -> None:
    import joblib
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import classification_report, roc_auc_score
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    print(f"Loading features from {features_path or db_path}", flush=True)
    frame = load_features(db_path, features_path)
    rows_total = len(frame)
    for column in FEATURE_COLUMNS:
        if column not in frame:
            frame[column] = float("nan")
    frame = frame.dropna(subset=FEATURE_COLUMNS)
    print(f"Loaded {rows_total} rows, {len(frame)} with the current feature set", flush=True)
    if len(frame) < MIN_TRAINING_ROWS:
        raise RuntimeError(
            f"Collect at least {MIN_TRAINING_ROWS:,} feature rows with the current feature set "
            f"before training (have {len(frame):,})"
        )
    labelled = label_frame(frame, horizon_seconds, min_move)
    train_df, test_df = temporal_split(labelled, horizon_seconds)
    print(f"Labelled rows: {len(labelled)} (train {len(train_df)}, test {len(test_df)}, "
          f"embargo {horizon_seconds:g}s)", flush=True)
    if train_df["target"].nunique() < 2 or test_df["target"].nunique() < 2:
        raise RuntimeError("Need both upward and downward examples in train and test sets")

    model = make_pipeline(StandardScaler(), LogisticRegression(max_iter=1_000, class_weight="balanced"))
    print("Fitting logistic regression...", flush=True)
    model.fit(train_df[FEATURE_COLUMNS], train_df["target"])
    probs = model.predict_proba(test_df[FEATURE_COLUMNS])[:, 1]
    predictions = (probs >= 0.5).astype(int)
    auc = roc_auc_score(test_df["target"], probs)
    confident = (probs >= HIGH_CONFIDENCE) | (probs <= 1 - HIGH_CONFIDENCE)
    confident_accuracy = (
        float((predictions[confident] == test_df["target"].to_numpy()[confident]).mean())
        if confident.any() else None
    )
    print(f"Temporal test ROC-AUC: {auc:.4f}")
    print(classification_report(test_df["target"], predictions, digits=4))
    if confident_accuracy is not None:
        print(f"High-confidence accuracy (p>={HIGH_CONFIDENCE} or p<={1 - HIGH_CONFIDENCE:.1f}): "
              f"{confident_accuracy:.4f} on {confident.mean():.1%} of test rows")
    output.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": model, "columns": FEATURE_COLUMNS}, output)
    print(f"Saved model: {output}")

    if metrics_path:
        metrics = {
            "roc_auc": float(auc),
            "rows_total": rows_total,
            "rows_usable": len(frame),
            "rows_labelled": len(labelled),
            "train_rows": len(train_df),
            "test_rows": len(test_df),
            "positive_rate": float(labelled["target"].mean()),
            "class_counts": {
                "train": {str(k): int(v) for k, v in train_df["target"].value_counts().items()},
                "test": {str(k): int(v) for k, v in test_df["target"].value_counts().items()},
            },
            "high_confidence": {
                "threshold": HIGH_CONFIDENCE,
                "coverage": float(confident.mean()),
                "accuracy": confident_accuracy,
            },
            "horizon_seconds": horizon_seconds,
            "embargo_seconds": horizon_seconds,
            "min_move": min_move,
            "model_path": str(output),
            "report": classification_report(test_df["target"], predictions, output_dict=True),
            "coefficients": dict(zip(FEATURE_COLUMNS, map(float, model[-1].coef_[0]))),
        }
        metrics_path.parent.mkdir(parents=True, exist_ok=True)
        metrics_path.write_text(json.dumps(metrics, indent=2))
        print(f"Saved metrics: {metrics_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a leakage-resistant baseline classifier")
    parser.add_argument("--db", type=Path, default=Path("data/microbot.duckdb"))
    parser.add_argument("--features", type=Path, default=None,
                        help="Read features from this Parquet file instead of the DuckDB database")
    parser.add_argument("--output", type=Path, default=Path("data/model.joblib"))
    parser.add_argument("--metrics", type=Path, default=None, help="Write metrics JSON here")
    parser.add_argument("--horizon-seconds", type=float, default=15.0,
                        help="Label with the midpoint this many seconds ahead")
    parser.add_argument("--min-move", type=float, default=0.002,
                        help="Extra move required beyond half the spread to count as a label")
    args = parser.parse_args()
    if args.horizon_seconds <= 0:
        parser.error("--horizon-seconds must be positive")
    try:
        train(args.db, args.output, args.horizon_seconds, args.min_move, args.features, args.metrics)
    except RuntimeError as exc:
        sys.exit(f"Error: {exc}")


if __name__ == "__main__":
    main()
