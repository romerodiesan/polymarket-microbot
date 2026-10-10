import importlib
import json
import time

import pytest

from microbot.storage import Storage

NOW = time.time()
UP, DOWN = "tok-up", "tok-down"


@pytest.fixture
def server(tmp_path, monkeypatch):
    data = tmp_path / "data"
    storage = Storage(data / "microbot.duckdb", data / "parquet")
    storage.upsert("runs", {"run_id": "r1", "started_at": NOW - 600, "mode": "paper",
                            "settings_json": json.dumps({"fee_rate": 0.07, "paper_latency_ms": 120}),
                            "model_version": "heuristic"})
    storage.upsert("markets", {"slug": "btc-1", "yes_token_id": UP, "no_token_id": DOWN,
                               "start_ts": NOW - 900, "end_ts": NOW - 60, "tick_size": 0.001,
                               "fee_rate": 0.07, "fee_source": "gamma:feeSchedule",
                               "resolved": True, "winner": "YES", "payout_yes": 1.0,
                               "payout_no": 0.0, "btc_open": 1.0, "btc_close": 2.0,
                               "btc_source": "gamma"})
    storage.upsert("markets", {"slug": "btc-2", "yes_token_id": "u2", "no_token_id": "d2",
                               "end_ts": NOW + 600, "resolved": False})
    for i in range(40):
        ts = NOW - 300 + i
        for token, mid in ((UP, 0.50 + i * 0.002), (DOWN, 0.50 - i * 0.002)):
            storage.insert("features", {"ts": ts, "token_id": token, "midpoint": mid,
                                        "spread": 0.01, "market": "btc-1", "in_gap": i < 4,
                                        "outcome": "YES" if token == UP else "NO"})
        storage.insert("predictions", {"prediction_id": f"p{i}", "ts": ts, "run_id": "r1",
                                       "market": "btc-1", "token_id": UP, "outcome": "YES",
                                       "probability": 0.7, "signal": 0.4,
                                       "decision": "enter" if i == 0 else "filtered:cooldown",
                                       "model_version": "m1"})
    storage.insert("orders", {"order_id": "o1", "run_id": "r1", "mode": "paper", "market": "btc-1",
                              "token_id": UP, "side": "BUY", "reason": "entry score=0.4",
                              "signal_ts": NOW - 300, "submit_ts": NOW - 300, "ack_ts": NOW - 299.9,
                              "status": "partial", "latency_ms": 100, "requested_size": 10,
                              "filled_size": 5, "avg_price": 0.51, "fee": 0.0875,
                              "slippage_vs_touch": 0.0, "slippage_vs_mid": 0.01})
    storage.insert("orders", {"order_id": "o2", "run_id": "r1", "mode": "paper", "market": "btc-1",
                              "token_id": UP, "side": "SELL", "reason": "stop_loss score=0",
                              "submit_ts": NOW - 200, "status": "rejected",
                              "reject_reason": "no_liquidity_within_limit", "requested_size": 5,
                              "filled_size": 0})
    storage.insert("fills", {"ts": NOW - 300, "token_id": UP, "side": "BUY", "size": 5.0,
                             "price": 0.51, "fee": 0.0875, "order_id": "o1", "mode": "paper",
                             "reason": "entry", "pnl": 0.0, "market": "btc-1", "outcome": "YES",
                             "fee_rate": 0.07, "fee_source": "gamma:feeSchedule"})
    storage.insert("fills", {"ts": NOW - 250, "token_id": "u2", "side": "BUY", "size": 2.0,
                             "price": 0.40, "fee": 0.0, "order_id": "o3", "mode": "paper",
                             "reason": "entry", "pnl": 0.0, "market": "btc-2", "outcome": "YES"})
    for i, (equity, exposure) in enumerate(((1000.0, 0.0), (999.0, 2.6), (1001.0, 3.4))):
        storage.insert("equity", {"ts": NOW - 300 + i, "run_id": "r1", "starting_cash": 1000,
                                  "cash": 997, "equity": equity, "drawdown": max(0, 1000 - equity),
                                  "gross_exposure": exposure, "max_simultaneous_exposure": exposure,
                                  "max_market_exposure": exposure})
    storage.insert("positions", {"ts": NOW - 298, "run_id": "r1", "market": "btc-1",
                                 "token_id": UP, "size": 5.0, "avg_price": 0.5275})
    for kind, value, detail in (("connect", None, ""), ("rtt", 80.0, ""), ("rtt", 120.0, ""),
                                ("gap", 7.5, ""), ("disconnect", None, "timeout")):
        storage.insert("stream_events", {"ts": NOW - 100, "run_id": "r1", "kind": kind,
                                         "value": value, "detail": detail})
    storage.close()

    for evaluation_id, net in (("e1", -5.0), ("e2", 3.0)):
        folder = data / "evaluations" / evaluation_id
        folder.mkdir(parents=True)
        (folder / "report.json").write_text(json.dumps({
            "id": evaluation_id, "created_at": f"2026-10-0{evaluation_id[-1]}T00:00:00Z",
            "signal": "recorded", "baselines": {"random": {"net_pnl": -9}},
            "scenarios": {"base": {"net_pnl": net, "entries": 4,
                                   "per_market": [{"market": "btc-1", "pnl": net}]}},
        }))
    monkeypatch.setenv("MICROBOT_DATA_DIR", str(data))
    from microbot import mcp_server

    return importlib.reload(mcp_server)


def test_paper_performance_separates_settled_and_marked(server):
    perf = server.get_paper_performance(lookback_hours=1)
    tokens = {t["token_id"]: t for t in perf["tokens"]}
    assert tokens[UP]["valuation"] == "payout"
    assert tokens["u2"]["valuation"] == "midpoint"
    # Resolved YES: 5 shares bought at 0.51 plus fees pay out 1 each.
    assert perf["totals"]["settled_pnl"] == pytest.approx(5 * (1 - 0.51) - 0.0875)
    assert perf["totals"]["marked_pnl"] == pytest.approx(-0.8)  # no midpoint recorded for u2
    assert perf["totals"]["max_capital_committed"] == pytest.approx(3.4)
    assert perf["totals"]["roi_on_max_committed"] == pytest.approx(perf["totals"]["net_pnl"] / 3.4)
    sources = {s["fee_source"] for s in perf["fee_sources"]}
    assert sources == {"gamma:feeSchedule", "unknown"}


def test_execution_quality(server):
    quality = server.get_execution_quality(lookback_hours=1)
    assert quality["totals"]["orders"] == 2
    assert quality["totals"]["partial"] == 1 and quality["totals"]["rejected"] == 1
    assert quality["totals"]["size_fill_ratio"] == pytest.approx(5 / 15)
    assert quality["reject_reasons"] == [{"reject_reason": "no_liquidity_within_limit", "orders": 1}]
    assert {r["reason_kind"] for r in quality["by_reason"]} == {"entry", "stop_loss"}


def test_market_resolutions_and_equity(server):
    resolutions = server.get_market_resolutions()
    assert resolutions["summary"]["resolved"] == 1 and resolutions["summary"]["pending"] == 1
    resolved = next(m for m in resolutions["markets"] if m["slug"] == "btc-1")
    assert (resolved["winner"], resolved["btc_source"], resolved["fills"]) == ("YES", "gamma", 1)

    risk = server.get_equity_and_risk(lookback_hours=1, points=10)
    assert risk["stats"]["max_drawdown"] == pytest.approx(1.0)
    assert risk["stats"]["max_capital_committed"] == pytest.approx(3.4)
    assert len(risk["curve"]) == 3
    assert risk["latest_positions"][0]["token_id"] == UP


def test_prediction_calibration_and_stream_health(server):
    calibration = server.get_prediction_calibration(horizon_seconds=5, lookback_hours=1)
    assert calibration["labelled_predictions"] > 0
    assert calibration["reliability"][0]["observed_rate"] == pytest.approx(1.0)
    assert {r["decision"] for r in calibration["by_decision"]} == {"enter", "filtered:cooldown"}
    assert calibration["final_resolution"][0]["won_share"] == pytest.approx(1.0)

    health = server.get_stream_health(lookback_hours=1)
    kinds = {k["kind"]: k for k in health["kinds"]}
    assert kinds["rtt"]["avg_value"] == pytest.approx(100)
    assert kinds["gap"]["max_value"] == pytest.approx(7.5)
    assert health["disconnect_reasons"] == [{"detail": "timeout", "events": 1}]
    assert health["features_in_gap"]["share"] == pytest.approx(0.1)


def test_cost_config_and_evaluations(server):
    costs = server.get_cost_config()
    assert costs["settings"]["fee_rate"] == 0.07
    assert costs["settings"]["paper_latency_ms"] == 120
    by_slug = {m["slug"]: m for m in costs["markets"]}
    assert by_slug["btc-1"]["fee_source"] == "gamma:feeSchedule"
    assert by_slug["btc-1"]["tick_size"] == 0.001

    listed = server.list_evaluations()
    assert [e["id"] for e in listed["evaluations"]] == ["e2", "e1"]
    assert listed["evaluations"][0]["scenarios"]["base"]["net_pnl"] == 3.0
    report = server.get_evaluation("e1")
    assert "per_market" not in report["scenarios"]["base"]
    assert server.get_evaluation("e1", include_markets=True)["scenarios"]["base"]["per_market"]
    assert "error" in server.get_evaluation("../x")
    compared = server.compare_evaluations(["e1", "e2"])
    assert compared["evaluations"][0]["baselines"] == {"random": {"net_pnl": -9}}
    assert "error" in server.compare_evaluations(["e1"])


def test_new_tools_without_data(tmp_path, monkeypatch):
    monkeypatch.setenv("MICROBOT_DATA_DIR", str(tmp_path))
    from microbot import mcp_server

    server = importlib.reload(mcp_server)
    for tool in (server.get_execution_quality, server.get_market_resolutions,
                 server.get_equity_and_risk, server.get_prediction_calibration,
                 server.get_stream_health):
        assert tool()["available"] is False
    assert server.get_cost_config()["run"] is None
    assert server.list_evaluations() == {"count": 0, "evaluations": []}
    assert server.get_paper_performance()["totals"]["settled_pnl"] == 0.0
