import importlib
import json
import os
import time

import duckdb
import pytest

pytest.importorskip("mcp")

TOKEN = "tok-up"


def write_parquet(path, sql):
    con = duckdb.connect()
    try:
        con.execute(f"COPY ({sql}) TO '{path.as_posix()}' (FORMAT parquet)")
    finally:
        con.close()


@pytest.fixture
def server(tmp_path, monkeypatch):
    data = tmp_path / "data"
    parquet = data / "parquet"
    parquet.mkdir(parents=True)
    now = time.time()

    write_parquet(
        parquet / "features.parquet",
        f"""
        SELECT
            {now} - 100 + i AS ts, '{TOKEN}' AS token_id,
            0.49 AS best_bid, 0.51 AS best_ask, 0.50 + i / 1000 AS midpoint, 0.02 AS spread,
            100.0 AS bid_depth_3, 80.0 AS ask_depth_3, 0.1 AS book_imbalance,
            0.5 AS microprice, 0.0 AS microprice_delta, -0.2 AS flow_imbalance,
            0.3 AS trade_pressure, 0.4 AS score, 0.1 AS weighted_imbalance, 0.0 AS ofi,
            0.01 AS volatility, 2.0 AS spread_ticks, 10.0 AS top_bid_size,
            12.0 AS top_ask_size, 1.0 AS trade_volume, 'btc-updown' AS market,
            'Up' AS outcome
        FROM range(0, 100, 2) t(i)
        """,
    )
    write_parquet(
        parquet / "fills.parquet",
        f"""
        SELECT
            ts::DOUBLE AS ts, token_id, side, size::DOUBLE AS size, price::DOUBLE AS price,
            fee::DOUBLE AS fee, order_id, mode, reason, pnl::DOUBLE AS pnl, market, outcome
        FROM (VALUES
            ({now} - 50, '{TOKEN}', 'BUY', 10.0, 0.50, 0.01, 'o1', 'paper', 'entry',
             NULL, 'btc-updown', 'Up'),
            ({now} - 20, '{TOKEN}', 'SELL', 4.0, 0.55, 0.01, 'o2', 'paper', 'take_profit',
             0.2, 'btc-updown', 'Up'),
            ({now} - 10, '{TOKEN}', 'BUY', 1.0, 0.50, 0.0, 'o3', 'live', 'entry',
             NULL, 'btc-updown', 'Up')
        ) t(ts, token_id, side, size, price, fee, order_id, mode, reason, pnl, market, outcome)
        """,
    )

    (data / "bot").mkdir()
    (data / "bot" / "state.json").write_text(
        json.dumps({"pid": os.getpid(), "startedAt": now - 200, "endedAt": None, "exitCode": None})
    )
    (tmp_path / ".env").write_text("PM_MODE=paper\nPM_SERIES_SLUG=btc-up-or-down\nPM_SECRET=nope\n")

    for idx, (run_id, auc) in enumerate((("run-a", 0.55), ("run-b", 0.61))):
        run = data / "training" / run_id
        run.mkdir(parents=True)
        (run / "meta.json").write_text(json.dumps({
            "id": run_id, "status": "completed", "startedAt": now - 1000 + idx,
            "params": {"horizonSeconds": 30, "minMove": 0.01},
        }))
        (run / "metrics.json").write_text(json.dumps({
            "roc_auc": auc, "rows_total": 100, "train_rows": 70, "test_rows": 30,
            "horizon_seconds": 30, "embargo_seconds": 30, "min_move": 0.01,
            "report": {"accuracy": 0.6}, "coefficients": {"score": 0.5},
        }))
    (data / "training" / "broken").mkdir()

    monkeypatch.setenv("MICROBOT_DATA_DIR", str(data))
    from microbot import mcp_server

    return importlib.reload(mcp_server)


def test_capture_status(server):
    status = server.get_capture_status()
    assert status["read_only"] is True
    assert status["PM_MODE"] == "paper"
    assert "PM_SECRET" not in status
    assert status["process"]["running"] is True
    assert status["snapshots"]["features"]["rows"] == 50
    assert status["snapshots"]["fills"]["rows"] == 3
    assert status["training_runs"] == 2
    assert status["status_age_seconds"] < 60


def test_market_summary_and_recent(server):
    summary = server.get_market_summary(lookback_hours=1)
    assert len(summary["tokens"]) == 1
    token = summary["tokens"][0]
    assert token["samples"] == 50
    assert token["avg_spread"] == pytest.approx(0.02)
    assert server.get_market_summary(token_id="missing")["tokens"] == []

    recent = server.get_recent_features(token_id=TOKEN, limit=5)
    assert recent["count"] == 5
    assert recent["rows"][0]["ts"] > recent["rows"][-1]["ts"]


def test_data_quality(server):
    token = server.get_data_quality(lookback_hours=1)["tokens"][0]
    assert token["distinct_timestamps"] == 50
    assert token["max_gap_seconds"] == pytest.approx(2)
    assert token["gaps_over_5_seconds"] == 0


def test_paper_performance(server):
    perf = server.get_paper_performance(lookback_hours=1)
    token = perf["tokens"][0]
    assert token["fills"] == 2
    assert token["position"] == pytest.approx(6)
    assert token["cash_flow"] == pytest.approx(-5 + 2.2)
    assert perf["totals"]["realized_pnl"] == pytest.approx(0.2)
    assert perf["totals"]["marked_pnl"] == pytest.approx(-2.8 - 0.02 + 6 * 0.598)
    assert {r["reason"] for r in perf["reasons"]} == {"entry", "take_profit"}


def test_training_runs(server):
    listed = server.list_training_runs()
    assert [r["run_id"] for r in listed["runs"]] == ["run-b", "run-a"]
    run = server.get_training_run("run-b")
    assert run["metrics"]["roc_auc"] == 0.61
    assert run["parameters"]["horizon_seconds"] == 30
    assert "error" in server.get_training_run("../etc")

    compared = server.compare_training_runs(["run-a", "run-b"])
    assert len(compared["runs"]) == 2
    assert "error" in server.compare_training_runs(["run-a"])
    assert "error" in server.compare_training_runs(["run-a", "nope"])


def test_missing_data(tmp_path, monkeypatch):
    monkeypatch.setenv("MICROBOT_DATA_DIR", str(tmp_path))
    from microbot import mcp_server

    server = importlib.reload(mcp_server)
    status = server.get_capture_status()
    assert status["snapshots"]["features"]["files"] == 0
    assert status["process"]["running"] is False
    assert server.get_paper_performance()["tokens"] == []
    assert server.list_training_runs()["runs"] == []
    with pytest.raises(RuntimeError):
        server.get_market_summary()
