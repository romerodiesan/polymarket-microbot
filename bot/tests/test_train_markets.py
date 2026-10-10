import json

import numpy as np
import pandas as pd
import pytest

from microbot.model import FEATURE_COLUMNS, ModelPredictor
from microbot.storage import write_frame
from microbot.train import (
    choose_threshold,
    fit_calibrated,
    market_keys,
    market_split,
    reliability,
    train,
    walk_forward_folds,
)

MARKET_SECONDS = 100


def synthetic(markets: int = 12, rows: int = 60, seed: int = 0) -> pd.DataFrame:
    """Labelled rows for `markets` consecutive markets, YES and NO tokens interleaved."""
    rng = np.random.default_rng(seed)
    parts = []
    for m in range(markets):
        for token in ("yes", "no"):
            ts = m * MARKET_SECONDS + np.arange(rows) * (MARKET_SECONDS / rows)
            signal = rng.normal(size=rows)
            frame = pd.DataFrame({
                "ts": ts, "token_id": f"{token}-{m}", "market": f"m{m:02d}",
                "midpoint": 0.5, "spread": 0.01, "score": np.tanh(signal),
                "target": (signal + rng.normal(scale=0.8, size=rows) > 0).astype(int),
            })
            for i, column in enumerate(FEATURE_COLUMNS):
                frame[column] = signal * (i == 1) + rng.normal(scale=0.1, size=rows)
            parts.append(frame)
    return pd.concat(parts).sort_values("ts").reset_index(drop=True)


def test_market_split_keeps_markets_and_both_tokens_on_one_side():
    frame = synthetic()
    dev, test, info = market_split(frame, horizon_seconds=15, holdout_fraction=0.25)
    dev_markets, test_markets = set(market_keys(dev)), set(market_keys(test))
    assert not dev_markets & test_markets
    assert info["embargo_markets"] == ["m08"]
    assert test_markets == {"m09", "m10", "m11"}
    # Each market keeps its YES and NO rows together.
    for side in (dev, test):
        tokens = side.groupby(market_keys(side))["token_id"].nunique()
        assert (tokens == 2).all()
    assert dev["ts"].max() + 15 < test["ts"].min()


def test_walk_forward_folds_expand_and_never_look_ahead():
    dev, _, _ = market_split(synthetic(), 15)
    folds = walk_forward_folds(dev, 15, folds=3)
    assert len(folds) == 3
    sizes = [market_keys(t).nunique() for t, _ in folds]
    assert sizes == sorted(sizes)
    for train_df, valid in folds:
        assert not set(market_keys(train_df)) & set(market_keys(valid))
        assert train_df["ts"].max() + 15 < valid["ts"].min()


def test_threshold_and_calibration_come_from_validation_only():
    dev, test, _ = market_split(synthetic(), 15)
    _, validation, folds = fit_calibrated(dev, 15, folds=3, embargo_markets=1)
    valid_markets = set(market_keys(walk_forward_folds(dev, 15, 3)[-1][1]))
    assert validation["markets"] == len(valid_markets)
    assert not valid_markets & set(market_keys(test))
    assert all(f.get("roc_auc", 0) > 0.6 for f in folds)
    assert validation["calibrated"]["ece"] <= validation["raw"]["ece"] + 1e-9


def test_reliability_and_threshold_helpers():
    y = np.array([0, 0, 1, 1])
    p = np.array([0.1, 0.2, 0.8, 0.9])
    curve = reliability(y, p, bins=2)
    assert [b["rows"] for b in curve["bins"]] == [2, 2]
    assert curve["ece"] == pytest.approx(0.15)
    choice = choose_threshold(np.array([0.95, 0.05, 0.55, 0.45]), np.array([1, 0, 0, 1]))
    assert choice["accuracy"] == 1.0 and choice["coverage"] == 0.5


def test_train_writes_market_level_metrics_and_versions(tmp_path):
    frame = synthetic(markets=12, rows=120)
    frame = frame.drop(columns=["target"])
    # Mids that move with the signal so labels exist after label_frame.
    frame["midpoint"] = 0.5 + 0.02 * np.sign(frame["weighted_imbalance"]).shift(-1).fillna(0)
    features = tmp_path / "features.parquet"
    write_frame(frame, features)
    output, metrics_path = tmp_path / "model.joblib", tmp_path / "metrics.json"
    train(tmp_path / "none.duckdb", output, horizon_seconds=1, min_move=0, features_path=features,
          metrics_path=metrics_path, folds=3, bootstrap=50)
    metrics = json.loads(metrics_path.read_text())
    for key in ("roc_auc", "rows_total", "train_rows", "test_rows", "class_counts",
                "high_confidence", "coefficients", "report"):
        assert key in metrics
    assert metrics["split"]["unit"] == "market"
    assert metrics["split"]["test_markets"] == 2
    assert len(metrics["walk_forward"]) == 3
    assert {"prior", "score_sign", "momentum"} <= set(metrics["baselines"])
    assert metrics["per_market"]["markets"] == 2
    assert metrics["bootstrap"]["markets"] == 2
    predictor = ModelPredictor(output)
    assert predictor.version == metrics["model_version"]
