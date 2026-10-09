from pathlib import Path

import joblib

from .features import FeatureRow

FEATURE_COLUMNS = [
    "spread_ticks", "weighted_imbalance", "book_imbalance", "microprice_delta",
    "ofi", "flow_imbalance", "trade_pressure", "volatility",
]


class ModelPredictor:
    def __init__(self, path: Path) -> None:
        payload = joblib.load(path)
        self.model = payload["model"]
        self.columns = payload.get("columns", FEATURE_COLUMNS)

    def score(self, row: FeatureRow) -> float:
        values = [[getattr(row, name) for name in self.columns]]
        probability_up = float(self.model.predict_proba(values)[0][1])
        return max(-1.0, min(1.0, 2 * probability_up - 1))

