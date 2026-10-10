import asyncio

import pandas as pd
import pytest

from microbot.book import OrderBook
from microbot.broker import PaperBroker
from microbot.config import Settings
from microbot.evaluate import SCENARIOS, Scenario, evaluate, synthetic_book
from microbot.features import FeatureRow
from microbot.storage import BOOK_EVENT_COLUMNS, PartitionedWriter
from microbot.strategy import MicrostructureStrategy

SECONDS = 60
SPACING = 100


def settings(**overrides) -> Settings:
    base = {"yes_token_id": "yes", "no_token_id": "no", "cooldown_seconds": 0,
            "signal_threshold": 0.2, "spread_penalty": 0.0, "min_top_depth": 1,
            "order_size_shares": 4, "max_spread": 0.1, "rollover_seconds": 30, "fee_rate": 0.07,
            "paper_starting_cash": 1000, "take_profit": 0.05, "stop_loss": 0.1}
    return Settings(**(base | overrides))


def yes_path(m: int, t: int) -> tuple[float, float]:
    """(midpoint, score) of YES: an early winning trade, then a late entry held to settlement."""
    mid = 0.50 if t < 10 else min(0.60, 0.50 + 0.005 * (t - 10))
    score = 0.6 if 5 <= t <= 26 or t >= 50 else 0.0
    return mid, score


def row(m: int, t: int, token: str) -> dict:
    mid, score = yes_path(m, t)
    if token == "no":
        mid, score = 1 - mid, -score
    return {
        "ts": float(m * SPACING + t), "token_id": f"{token}{m}", "best_bid": round(mid - 0.01, 4),
        "best_ask": round(mid + 0.01, 4), "midpoint": mid, "spread": 0.02, "bid_depth_3": 30.0,
        "ask_depth_3": 30.0, "book_imbalance": 0.0, "microprice": mid, "microprice_delta": 0.0,
        "flow_imbalance": 0.0, "trade_pressure": 0.0, "score": score, "weighted_imbalance": 0.0,
        "ofi": 0.0, "volatility": 0.0, "spread_ticks": 2.0, "top_bid_size": 10.0,
        "top_ask_size": 10.0, "trade_volume": 0.0, "market": f"m{m}",
        "outcome": "YES" if token == "yes" else "NO",
    }


def fixture(markets: int = 3) -> tuple[pd.DataFrame, pd.DataFrame]:
    features = pd.DataFrame([row(m, t, token) for m in range(markets) for t in range(SECONDS)
                             for token in ("yes", "no")])
    meta = pd.DataFrame([{
        "slug": f"m{m}", "yes_token_id": f"yes{m}", "no_token_id": f"no{m}",
        "end_ts": float(m * SPACING + SECONDS + 40), "tick_size": 0.01, "fee_rate": 0.07,
        # The last market is still unresolved.
        "resolved": m < markets - 1, "payout_yes": 1.0 if m < markets - 1 else None,
        "payout_no": 0.0 if m < markets - 1 else None,
    } for m in range(markets)])
    return features, meta


def paper_pnl(features: pd.DataFrame, meta: pd.DataFrame, s: Settings) -> dict[str, float]:
    """What the live paper loop would book with zero latency, per resolved market."""
    broker = PaperBroker(s)
    pnl = {}
    for market in meta.to_dict("records"):
        if not market["resolved"]:
            continue
        ms = s.model_copy(update={"yes_token_id": market["yes_token_id"],
                                  "no_token_id": market["no_token_id"]})
        strategy = MicrostructureStrategy(ms)
        books = {t: OrderBook(t) for t in (ms.yes_token_id, ms.no_token_id)}
        total = 0.0
        rows = features[features["market"] == market["slug"]]
        for ts, group in rows.groupby("ts"):
            records = group.to_dict("records")
            for r in records:
                synthetic_book(books[r["token_id"]], r, 0.01)
            feature_rows = {r["token_id"]: FeatureRow(**{
                k: v for k, v in r.items() if k not in ("market", "outcome")}) for r in records}
            for intent in strategy.decide(feature_rows, broker.positions(), ts):
                execution = asyncio.run(broker.submit(intent, books[intent.token_id]))
                total += execution.fill.pnl if execution.fill else 0.0
        for token, payout in ((ms.yes_token_id, market["payout_yes"]),
                              (ms.no_token_id, market["payout_no"])):
            fill = broker.settle(token, payout, 0.0, "settle")
            total += fill.pnl if fill else 0.0
        pnl[market["slug"]] = total
    return pnl


def test_base_scenario_matches_the_paper_broker():
    features, meta = fixture()
    s = settings()
    report = evaluate(features, meta, s, latency_ms=0, scenarios={"base": SCENARIOS["base"]},
                      baselines=(), bootstrap=50)
    base = report["scenarios"]["base"]
    paper = paper_pnl(features, meta, s)
    assert base["net_pnl"] == pytest.approx(sum(paper.values()))
    assert base["net_pnl"] > 0
    per_market = {r["market"]: r["pnl"] for r in base["per_market"] if r["settled_by"] == "payout"}
    assert per_market == pytest.approx(paper)
    assert base["markets"]["excluded_unresolved"] == 1
    assert base["markets"]["settled_by_payout"] == 2
    assert base["markets"]["fidelity"] == {"l2": 0, "features": 2}
    assert base["entries"] == 4
    assert base["fees"] > 0


def test_pessimistic_scenarios_never_beat_base():
    features, meta = fixture()
    report = evaluate(features, meta, settings(), latency_ms=500, baselines=("momentum", "random"),
                      bootstrap=50)
    nets = {name: s["net_pnl"] for name, s in report["scenarios"].items()}
    assert nets["pessimistic"] <= nets["base"]
    # Two extra ticks exceed the strategy's slippage allowance: stress cannot trade at all.
    assert report["scenarios"]["stress"]["entries"] == 0
    assert set(report["baselines"]) == {"momentum", "random"}
    base = report["scenarios"]["base"]
    for key in ("expectancy_per_trade", "roi_on_max_committed", "profit_factor", "drawdown",
                "weekly", "concentration", "bootstrap", "execution"):
        assert key in base
    assert base["max_capital_committed"] > 0


def test_replay_uses_recorded_l2_books(tmp_path):
    features, meta = fixture(markets=2)
    data = tmp_path / "data"
    writer = PartitionedWriter(data / "parquet" / "book_events", BOOK_EVENT_COLUMNS, "recv_ts")
    # The real book for market 0 is one tick worse than the features suggest.
    for token, side_rows in (("yes0", ("0.49", "0.52")), ("no0", ("0.49", "0.52"))):
        bid, ask = side_rows
        for side, price in (("BUY", bid), ("SELL", ask)):
            writer.append({"recv_ts": 0.0, "seq": 1 if token == "yes0" else 2, "connection_id": 1,
                           "event_type": "book", "token_id": token, "side": side,
                           "price": float(price), "size": 100.0})
    writer.flush(now=1.0)
    report = evaluate(features, meta, settings(), data_dir=data, latency_ms=0,
                      scenarios={"base": Scenario()}, baselines=(), bootstrap=10)
    rows = {r["market"]: r for r in report["scenarios"]["base"]["per_market"]}
    assert rows["m0"]["fidelity"] == "l2"
    assert rows["m1"]["fidelity"] == "features"
    # Market 0 buys at the recorded 0.52 ask; its exits are rejected against the recorded 0.49
    # bid (below the strategy's limit), so the position is held until it settles at 1.
    entry_fee = round(3 * 0.07 * 0.52 * 0.48, 5)
    assert rows["m0"]["pnl"] == pytest.approx(3 * (1 - 0.52) - entry_fee)
    assert rows["m0"]["pnl"] != pytest.approx(rows["m1"]["pnl"])
    assert report["paper_vs_replay"] == {"markets": 0}
