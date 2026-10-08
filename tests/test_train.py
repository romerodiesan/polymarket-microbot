import pandas as pd

from microbot.train import label_frame, temporal_split


def frame_from(mids: list[float], token: str = "yes", step: float = 1.0) -> pd.DataFrame:
    return pd.DataFrame({
        "ts": [i * step for i in range(len(mids))],
        "token_id": token,
        "midpoint": mids,
        "spread": 0.02,
    })


def test_labels_use_time_horizon_and_cost_threshold():
    mids = [0.50, 0.50, 0.50, 0.53, 0.50, 0.505]
    labelled = label_frame(frame_from(mids), horizon_seconds=3, min_move=0.005)
    # ts=0 -> ts=3: +0.03 beats 0.01 + 0.005; ts=1 -> ts=4: 0; ts=2 -> ts=5: +0.005 (too small)
    assert labelled["ts"].tolist() == [0.0]
    assert labelled["target"].tolist() == [1]


def test_labels_drop_rows_without_future_data_inside_tolerance():
    frame = pd.DataFrame({"ts": [0.0, 10.0], "token_id": "yes", "midpoint": [0.5, 0.6], "spread": 0.01})
    assert label_frame(frame, horizon_seconds=3, min_move=0).empty


def test_labels_do_not_mix_tokens():
    yes = frame_from([0.50, 0.50, 0.60], token="yes")
    no = frame_from([0.50, 0.50, 0.40], token="no")
    labelled = label_frame(pd.concat([yes, no]), horizon_seconds=2, min_move=0)
    assert dict(zip(labelled["token_id"], labelled["target"])) == {"yes": 1, "no": 0}


def test_temporal_split_applies_embargo():
    frame = pd.DataFrame({"ts": [float(i) for i in range(100)], "target": [i % 2 for i in range(100)]})
    train_df, test_df = temporal_split(frame, horizon_seconds=5)
    assert train_df["ts"].max() + 5 < test_df["ts"].min()
    assert len(test_df) == 20
