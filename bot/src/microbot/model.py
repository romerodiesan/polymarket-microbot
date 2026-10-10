import hashlib
import json
from pathlib import Path

import joblib
import numpy as np

from .features import FeatureRow

FEATURE_COLUMNS = [
    "spread_ticks", "weighted_imbalance", "book_imbalance", "microprice_delta",
    "ofi", "flow_imbalance", "trade_pressure", "volatility",
]

SIGNAL_SETTINGS = (
    "signal_half_life_seconds", "zscore_half_life_seconds", "zscore_warmup_samples",
    "weight_imbalance", "weight_ofi", "weight_pressure", "weight_microprice",
    "feature_interval_ms",
)


def short_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


def features_version(settings=None) -> str:
    """Identifies the feature definitions (and, given settings, the signal parameters)."""
    spec: dict = {"columns": FEATURE_COLUMNS}
    if settings is not None:
        spec["signal"] = {name: getattr(settings, name) for name in SIGNAL_SETTINGS}
    return short_hash(json.dumps(spec, sort_keys=True).encode())


def file_version(path: Path) -> str:
    return short_hash(path.read_bytes())


class CalibratedModel:
    """A fitted classifier followed by a Platt (sigmoid) map fitted on held-out predictions."""

    def __init__(self, model, slope: float = 1.0, intercept: float = 0.0) -> None:
        self.model = model
        self.slope = slope
        self.intercept = intercept

    def predict_proba(self, values) -> np.ndarray:
        raw = np.clip(self.model.predict_proba(values)[:, 1], 1e-6, 1 - 1e-6)
        logit = np.log(raw / (1 - raw))
        p = 1 / (1 + np.exp(-(self.slope * logit + self.intercept)))
        return np.column_stack([1 - p, p])


class ModelPredictor:
    def __init__(self, path: Path) -> None:
        payload = joblib.load(path)
        self.model = payload["model"]
        self.columns = payload.get("columns", FEATURE_COLUMNS)
        self.version = payload.get("model_version") or file_version(path)

    def probability(self, row: FeatureRow) -> float:
        values = [[getattr(row, name) for name in self.columns]]
        return float(self.model.predict_proba(values)[0][1])

    def score(self, row: FeatureRow) -> float:
        return max(-1.0, min(1.0, 2 * self.probability(row) - 1))
