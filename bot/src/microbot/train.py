import argparse
import json
import pickle
import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

from .model import FEATURE_COLUMNS, CalibratedModel, features_version, short_hash

MIN_TRAINING_ROWS = 1_000
HIGH_CONFIDENCE = 0.6
RELIABILITY_BINS = 10
THRESHOLD_GRID = np.round(np.arange(0.50, 0.91, 0.01), 2)
MIN_THRESHOLD_COVERAGE = 0.05


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


# --- Splits by market --------------------------------------------------------------------------

def market_keys(frame: pd.DataFrame) -> pd.Series:
    """The market of each row; YES and NO share it. Rows without one fall back to the token."""
    if "market" not in frame:
        return frame["token_id"].astype(str)
    market = frame["market"].astype("string")
    return market.where(market.notna() & (market != ""), frame["token_id"].astype(str)).astype(str)


def market_order(frame: pd.DataFrame) -> list[str]:
    """Markets sorted by the time of their last row (their end)."""
    ends = frame.groupby(market_keys(frame))["ts"].max().sort_values(kind="stable")
    return list(ends.index)


def _embargoed(train: pd.DataFrame, after: pd.DataFrame, horizon: float) -> pd.DataFrame:
    """Drop training rows whose label window reaches the first row of `after`."""
    if after.empty:
        return train
    return train[train["ts"] + horizon < after["ts"].min()]


def market_split(frame: pd.DataFrame, horizon_seconds: float, holdout_fraction: float = 0.2,
                 embargo_markets: int = 1) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    """Development and final test blocks made of whole markets, in chronological order.

    `embargo_markets` markets between both blocks are dropped, as is any development row whose
    label window reaches the test block.
    """
    keys = market_keys(frame)
    order = market_order(frame)
    n_test = max(1, round(len(order) * holdout_fraction))
    test_markets = order[-n_test:]
    embargo = order[max(0, len(order) - n_test - embargo_markets):len(order) - n_test]
    dev_markets = order[:max(0, len(order) - n_test - embargo_markets)]
    test = frame[keys.isin(test_markets)]
    dev = _embargoed(frame[keys.isin(dev_markets)], test, horizon_seconds)
    info = {"unit": "market", "dev_markets": len(dev_markets), "test_markets": len(test_markets),
            "embargo_markets": embargo, "embargo_seconds": horizon_seconds}
    return dev, test, info


def walk_forward_folds(dev: pd.DataFrame, horizon_seconds: float, folds: int,
                       embargo_markets: int = 1) -> list[tuple[pd.DataFrame, pd.DataFrame]]:
    """Expanding-window folds: train on the first k market chunks, validate on chunk k + 1."""
    keys = market_keys(dev)
    chunks = [list(c) for c in np.array_split(np.array(market_order(dev), dtype=object), folds + 1)]
    result = []
    for i in range(1, len(chunks)):
        if not chunks[i]:
            continue
        train_markets = [m for c in chunks[:i] for m in c]
        train_markets = train_markets[:max(0, len(train_markets) - embargo_markets)]
        valid = dev[keys.isin(chunks[i])]
        train = _embargoed(dev[keys.isin(train_markets)], valid, horizon_seconds)
        result.append((train, valid))
    return result


# --- Metrics ------------------------------------------------------------------------------------

def classification_metrics(y: np.ndarray, p: np.ndarray) -> dict:
    from sklearn.metrics import log_loss, roc_auc_score

    y, p = np.asarray(y, dtype=int), np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
    if len(y) == 0:
        return {"rows": 0}
    confident = (p >= HIGH_CONFIDENCE) | (p <= 1 - HIGH_CONFIDENCE)
    predicted = (p >= 0.5).astype(int)
    two_classes = len(np.unique(y)) == 2
    return {
        "rows": len(y),
        "roc_auc": float(roc_auc_score(y, p)) if two_classes else None,
        "log_loss": float(log_loss(y, p, labels=[0, 1])),
        "brier": float(np.mean((p - y) ** 2)),
        "accuracy": float(np.mean(predicted == y)),
        "high_confidence_coverage": float(confident.mean()),
        "high_confidence_accuracy": (float(np.mean(predicted[confident] == y[confident]))
                                     if confident.any() else None),
    }


def reliability(y: np.ndarray, p: np.ndarray, bins: int = RELIABILITY_BINS) -> dict:
    """Reliability curve (equal-width bins) and expected calibration error."""
    y, p = np.asarray(y, dtype=float), np.asarray(p, dtype=float)
    edges = np.linspace(0, 1, bins + 1)
    index = np.clip(np.digitize(p, edges[1:-1]), 0, bins - 1)
    rows, ece = [], 0.0
    for b in range(bins):
        mask = index == b
        if not mask.any():
            continue
        mean_p, rate = float(p[mask].mean()), float(y[mask].mean())
        ece += mask.mean() * abs(mean_p - rate)
        rows.append({"low": float(edges[b]), "high": float(edges[b + 1]), "rows": int(mask.sum()),
                     "mean_probability": mean_p, "observed_rate": rate})
    return {"bins": rows, "ece": float(ece)}


def fit_platt(p: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    """Sigmoid map from the raw logit to a calibrated probability."""
    from sklearn.linear_model import LogisticRegression

    p = np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
    logit = np.log(p / (1 - p)).reshape(-1, 1)
    model = LogisticRegression(C=1e6, max_iter=1_000).fit(logit, np.asarray(y, dtype=int))
    return float(model.coef_[0][0]), float(model.intercept_[0])


def choose_threshold(p: np.ndarray, y: np.ndarray,
                     min_coverage: float = MIN_THRESHOLD_COVERAGE) -> dict:
    """Confidence threshold with the best accuracy among those covering `min_coverage` rows."""
    p, y = np.asarray(p, dtype=float), np.asarray(y, dtype=int)
    best = {"threshold": 0.5, "coverage": 1.0, "accuracy": float(np.mean((p >= 0.5) == y))}
    for t in THRESHOLD_GRID[1:]:
        mask = (p >= t) | (p <= 1 - t)
        if mask.mean() < min_coverage:
            break
        accuracy = float(np.mean((p[mask] >= 0.5) == y[mask]))
        if accuracy > best["accuracy"]:
            best = {"threshold": float(t), "coverage": float(mask.mean()), "accuracy": accuracy}
    return best


def apply_threshold(p: np.ndarray, y: np.ndarray, threshold: float) -> dict:
    p, y = np.asarray(p, dtype=float), np.asarray(y, dtype=int)
    mask = (p >= threshold) | (p <= 1 - threshold)
    return {"threshold": threshold, "coverage": float(mask.mean()),
            "accuracy": float(np.mean((p[mask] >= 0.5) == y[mask])) if mask.any() else None}


def momentum_probability(frame: pd.DataFrame, history: pd.DataFrame, horizon: float) -> np.ndarray:
    """0.75/0.25 in the direction of the midpoint move over the previous `horizon` seconds."""
    left = frame[["token_id", "ts", "midpoint"]].reset_index().assign(past_ts=lambda f: f["ts"] - horizon)
    past = history[["token_id", "ts", "midpoint"]].rename(columns={"ts": "hist_ts", "midpoint": "past_mid"})
    merged = pd.merge_asof(left.sort_values("past_ts"), past.sort_values("hist_ts"),
                           left_on="past_ts", right_on="hist_ts", by="token_id",
                           direction="backward", tolerance=horizon)
    merged = merged.set_index("index").loc[frame.index]
    move = np.sign((merged["midpoint"] - merged["past_mid"]).fillna(0).to_numpy())
    return 0.5 + 0.25 * move


def baselines(train: pd.DataFrame, test: pd.DataFrame, history: pd.DataFrame,
              horizon: float) -> dict:
    y = test["target"].to_numpy()
    result = {"prior": classification_metrics(y, np.full(len(y), train["target"].mean()))}
    if "score" in test:
        score = test["score"].fillna(0).clip(-1, 1).to_numpy()
        result["score_sign"] = classification_metrics(y, (score + 1) / 2)
    result["momentum"] = classification_metrics(y, momentum_probability(test, history, horizon))
    return result


def per_market(test: pd.DataFrame, p: np.ndarray) -> dict:
    frame = pd.DataFrame({"market": market_keys(test).to_numpy(), "y": test["target"].to_numpy(),
                          "p": p})
    rows = []
    for market, group in frame.groupby("market", sort=False):
        m = classification_metrics(group["y"].to_numpy(), group["p"].to_numpy())
        rows.append({"market": market, "rows": m["rows"], "accuracy": m["accuracy"],
                     "brier": m["brier"], "roc_auc": m["roc_auc"]})
    accuracy = np.array([r["accuracy"] for r in rows])
    return {
        "markets": len(rows),
        "accuracy": {"mean": float(accuracy.mean()), "median": float(np.median(accuracy)),
                     "p10": float(np.quantile(accuracy, 0.1)),
                     "p90": float(np.quantile(accuracy, 0.9)),
                     "share_above_half": float(np.mean(accuracy > 0.5))} if rows else None,
        "rows": rows,
    }


def bootstrap_markets(test: pd.DataFrame, p: np.ndarray, samples: int = 1_000,
                      seed: int = 0) -> dict:
    """95 % intervals of pooled AUC, accuracy and Brier, resampling whole markets."""
    from sklearn.metrics import roc_auc_score

    keys = market_keys(test).to_numpy()
    y = test["target"].to_numpy()
    groups = [np.flatnonzero(keys == m) for m in pd.unique(keys)]
    rng = np.random.default_rng(seed)
    stats: dict[str, list[float]] = {"roc_auc": [], "accuracy": [], "brier": []}
    for _ in range(samples):
        idx = np.concatenate([groups[i] for i in rng.integers(0, len(groups), len(groups))])
        ys, ps = y[idx], p[idx]
        if len(np.unique(ys)) == 2:
            stats["roc_auc"].append(roc_auc_score(ys, ps))
        stats["accuracy"].append(np.mean((ps >= 0.5) == ys))
        stats["brier"].append(np.mean((ps - ys) ** 2))
    return {"markets": len(groups), "samples": samples, **{
        name: ({"low": float(np.quantile(v, 0.025)), "high": float(np.quantile(v, 0.975))}
               if v else None)
        for name, v in stats.items()
    }}


# --- Training -----------------------------------------------------------------------------------

def fit_model(frame: pd.DataFrame):
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    model = make_pipeline(StandardScaler(),
                          LogisticRegression(max_iter=1_000, class_weight="balanced"))
    return model.fit(frame[FEATURE_COLUMNS], frame["target"])


def predict(model, frame: pd.DataFrame) -> np.ndarray:
    return model.predict_proba(frame[FEATURE_COLUMNS])[:, 1]


def fit_calibrated(dev: pd.DataFrame, horizon: float, folds: int,
                   embargo_markets: int) -> tuple[CalibratedModel, dict, list[dict]]:
    """Walk-forward metrics on `dev`, then a model whose calibration and threshold come from the
    last validation block only."""
    splits = walk_forward_folds(dev, horizon, folds, embargo_markets)
    fold_metrics = []
    for i, (train, valid) in enumerate(splits, 1):
        entry = {"fold": i, "train_markets": int(market_keys(train).nunique()),
                 "valid_markets": int(market_keys(valid).nunique()),
                 "train_rows": len(train), "valid_rows": len(valid)}
        if train["target"].nunique() == 2 and len(valid):
            entry |= classification_metrics(valid["target"].to_numpy(), predict(fit_model(train), valid))
        fold_metrics.append(entry)
    if not splits:
        raise RuntimeError("Not enough markets for walk-forward validation")
    train, valid = splits[-1]
    if train["target"].nunique() < 2 or valid["target"].nunique() < 2:
        raise RuntimeError("Need both upward and downward examples in train and validation")
    base = fit_model(train)
    raw = predict(base, valid)
    slope, intercept = fit_platt(raw, valid["target"].to_numpy())
    model = CalibratedModel(base, slope, intercept)
    calibrated = model.predict_proba(valid[FEATURE_COLUMNS])[:, 1]
    y = valid["target"].to_numpy()
    validation = {
        "markets": int(market_keys(valid).nunique()), "rows": len(valid),
        "train_rows": len(train), "method": "platt", "slope": slope, "intercept": intercept,
        "raw": reliability(y, raw), "calibrated": reliability(y, calibrated),
        "threshold": choose_threshold(calibrated, y),
    }
    return model, validation, fold_metrics


def train(db_path: Path, output: Path, horizon_seconds: float, min_move: float,
          features_path: Path | None = None, metrics_path: Path | None = None,
          holdout_fraction: float = 0.2, folds: int = 4, embargo_markets: int = 1,
          bootstrap: int = 1_000, seed: int = 0) -> None:
    import joblib
    from sklearn.metrics import classification_report

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
    markets = market_order(labelled)
    if len(markets) < folds + 3:
        raise RuntimeError(
            f"Need at least {folds + 3} markets with labelled rows for a market split "
            f"(have {len(markets)})"
        )
    dev, test, split = market_split(labelled, horizon_seconds, holdout_fraction, embargo_markets)
    print(f"Labelled rows: {len(labelled)} in {len(markets)} markets "
          f"(dev {split['dev_markets']} markets/{len(dev)} rows, "
          f"test {split['test_markets']} markets/{len(test)} rows)", flush=True)
    if dev["target"].nunique() < 2 or test["target"].nunique() < 2:
        raise RuntimeError("Need both upward and downward examples in development and test sets")

    print(f"Walk-forward over {folds} folds...", flush=True)
    model, validation, fold_metrics = fit_calibrated(dev, horizon_seconds, folds, embargo_markets)
    for f in fold_metrics:
        auc = f.get("roc_auc")
        print(f"  fold {f['fold']}: {f['valid_markets']} markets, AUC "
              f"{'n/a' if auc is None else f'{auc:.4f}'}", flush=True)

    y = test["target"].to_numpy()
    raw = predict(model.model, test)
    probs = model.predict_proba(test[FEATURE_COLUMNS])[:, 1]
    predictions = (probs >= 0.5).astype(int)
    metrics_test = classification_metrics(y, probs)
    threshold = validation["threshold"]["threshold"]
    print(f"Test ROC-AUC: {metrics_test['roc_auc']:.4f}  Brier: {metrics_test['brier']:.4f}  "
          f"log loss: {metrics_test['log_loss']:.4f}")
    print(classification_report(y, predictions, digits=4, zero_division=0))

    model_version = short_hash(pickle.dumps(model))
    feat_version = features_version()
    output.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": model, "columns": FEATURE_COLUMNS, "model_version": model_version,
                 "features_version": feat_version, "threshold": threshold}, output)
    print(f"Saved model: {output} (version {model_version})")

    if metrics_path:
        confident = (probs >= HIGH_CONFIDENCE) | (probs <= 1 - HIGH_CONFIDENCE)
        metrics = {
            "roc_auc": metrics_test["roc_auc"],
            "rows_total": rows_total,
            "rows_usable": len(frame),
            "rows_labelled": len(labelled),
            "train_rows": validation["train_rows"],
            "test_rows": len(test),
            "positive_rate": float(labelled["target"].mean()),
            "class_counts": {
                "train": {str(k): int(v) for k, v in dev["target"].value_counts().items()},
                "test": {str(k): int(v) for k, v in test["target"].value_counts().items()},
            },
            "high_confidence": {
                "threshold": HIGH_CONFIDENCE,
                "coverage": float(confident.mean()),
                "accuracy": metrics_test["high_confidence_accuracy"],
            },
            "horizon_seconds": horizon_seconds,
            "embargo_seconds": horizon_seconds,
            "min_move": min_move,
            "model_path": str(output),
            "report": classification_report(y, predictions, output_dict=True, zero_division=0),
            "coefficients": dict(zip(FEATURE_COLUMNS, map(float, model.model[-1].coef_[0]))),
            "model_version": model_version,
            "features_version": feat_version,
            "split": split | {"markets_total": len(markets), "dev_rows": len(dev)},
            "walk_forward": fold_metrics,
            "validation": validation,
            "test": {
                "raw": classification_metrics(y, raw),
                "calibrated": metrics_test,
                "reliability_raw": reliability(y, raw),
                "reliability": reliability(y, probs),
                "threshold": apply_threshold(probs, y, threshold),
            },
            "baselines": baselines(dev, test, labelled, horizon_seconds),
            "per_market": per_market(test, probs),
            "bootstrap": bootstrap_markets(test, probs, bootstrap, seed),
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
    parser.add_argument("--holdout-markets", type=float, default=0.2,
                        help="Fraction of the latest markets kept as the untouched test block")
    parser.add_argument("--folds", type=int, default=4, help="Walk-forward folds")
    parser.add_argument("--embargo-markets", type=int, default=1,
                        help="Markets dropped between training and evaluation blocks")
    parser.add_argument("--bootstrap", type=int, default=1_000,
                        help="Bootstrap samples of test markets for confidence intervals")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    if args.horizon_seconds <= 0:
        parser.error("--horizon-seconds must be positive")
    if not 0 < args.holdout_markets < 1:
        parser.error("--holdout-markets must be between 0 and 1")
    if args.folds < 1:
        parser.error("--folds must be at least 1")
    try:
        train(args.db, args.output, args.horizon_seconds, args.min_move, args.features,
              args.metrics, args.holdout_markets, args.folds, args.embargo_markets,
              args.bootstrap, args.seed)
    except RuntimeError as exc:
        sys.exit(f"Error: {exc}")


if __name__ == "__main__":
    main()
