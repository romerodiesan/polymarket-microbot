import pandas as pd

from microbot.train import _embargoed, label_frame, temporal_split


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


def test_embargo_uses_the_observation_actually_used_for_the_label():
    # A sparse stream can assign the t+15 label from t+30, inside the next block.
    train = pd.DataFrame({"ts": [1.0, 2.0], "future_ts": [16.0, 31.0]})
    after = pd.DataFrame({"ts": [25.0]})
    assert _embargoed(train, after, 15)["ts"].tolist() == [1.0]


def test_temporal_split_purges_delayed_labels_too():
    frame = pd.DataFrame({"ts": [float(i) for i in range(100)],
                          "future_ts": [float(i + 30) for i in range(100)]})
    train, test = temporal_split(frame, horizon_seconds=15)
    assert train["future_ts"].max() < test["ts"].min()


def test_labels_do_not_bridge_a_capture_gap_or_restart():
    frame = frame_from([0.5, 0.5, 0.6, 0.6])
    frame["run_id"] = ["a", "a", "b", "b"]
    assert label_frame(frame, horizon_seconds=2, min_move=0).empty
    frame["run_id"] = "a"
    frame["in_gap"] = [False, True, False, False]
    assert label_frame(frame, horizon_seconds=2, min_move=0).empty
    frame = frame_from([0.5, 0.6], step=6)
    assert label_frame(frame, horizon_seconds=3, min_move=0).empty


def test_all_gap_rows_produce_an_empty_label_frame():
    frame = frame_from([0.5, 0.6, 0.7])
    frame["in_gap"] = True
    assert label_frame(frame, horizon_seconds=1, min_move=0).empty
