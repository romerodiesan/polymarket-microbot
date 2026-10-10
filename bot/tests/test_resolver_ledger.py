import asyncio
import json

import pytest

from microbot.book import OrderBook
from microbot.broker import PaperBroker
from microbot.config import Settings
from microbot.evaluate import apply_l2
from microbot.ledger import Ledger, Mark
from microbot.main import book_rows, book_state, fee_for, snapshot_delta, write_json_atomic
from microbot.markets import Market
from microbot.resolver import Resolver
from microbot.storage import Storage
from microbot.strategy import Intent


def paper() -> PaperBroker:
    return PaperBroker(Settings(yes_token_id="up", no_token_id="down", fee_rate=0))


def book() -> OrderBook:
    b = OrderBook("up")
    b.replace([{"price": "0.49", "size": "10"}], [{"price": "0.51", "size": "10"}])
    return b


def test_resolver_settles_open_positions_once_gamma_reports_payouts(tmp_path):
    storage = Storage(tmp_path / "bot.duckdb", tmp_path / "parquet")
    storage.upsert("markets", {"slug": "btc-updown-15m-1", "yes_token_id": "up",
                               "no_token_id": "down", "start_ts": 0.0, "end_ts": 900.0})
    broker = paper()
    asyncio.run(broker.submit(Intent("up", "BUY", 4, 0.52, "entry"), book()))
    settled = []
    gamma = {"closed": False}

    async def fetch_market(slug):
        return gamma

    async def fetch_prices(data, start, end):
        return {"btc_open": 1.0, "btc_close": 2.0, "btc_source": "test"}

    resolver = Resolver(storage, broker, lambda fill, tags: settled.append((fill, tags)),
                        fetch_market, fetch_prices)
    assert asyncio.run(resolver.poll(now=100.0)) == 0  # not ended yet
    assert asyncio.run(resolver.poll(now=1000.0)) == 0  # ended, not resolved
    gamma.update(closed=True, outcomePrices='["1", "0"]')
    assert asyncio.run(resolver.poll(now=1000.0)) == 1
    [(fill, tags)] = settled
    assert (fill.reason, fill.price, fill.size) == ("settlement", 1.0, 4)
    assert fill.pnl == pytest.approx(4 * (1 - 0.51))
    assert tags == {"market": "btc-updown-15m-1", "outcome": "YES"}
    row = storage.get("markets", "btc-updown-15m-1")
    assert (row["resolved"], row["winner"], row["payout_yes"], row["btc_source"]) == (
        True, "YES", 1.0, "test")
    assert asyncio.run(resolver.poll(now=1000.0)) == 0
    storage.close()


def test_ledger_tracks_cash_equity_drawdown_and_exposure():
    broker = paper()
    ledger = Ledger(1000)
    fill = asyncio.run(broker.submit(Intent("up", "BUY", 10, 0.52, "entry"), book())).fill
    ledger.on_fill(fill)
    tags = {"up": {"market": "m", "outcome": "YES"}}
    row, positions = ledger.snapshot(1.0, broker.positions(), {"up": Mark(0.50, 0.49)}, tags, 2.0)
    assert row["cash"] == pytest.approx(1000 - 5.1)
    assert row["equity"] == pytest.approx(1000 - 5.1 + 5.0)
    assert row["positions_value_bid"] == pytest.approx(4.9)
    assert row["drawdown"] == pytest.approx(0.1)
    assert row["gross_exposure"] == pytest.approx(5.1)
    assert row["max_simultaneous_exposure"] == pytest.approx(7.1)
    assert row["max_market_exposure"] == pytest.approx(5.1)
    assert positions[0]["unrealized"] == pytest.approx(-0.1)
    sell = broker.settle("up", 1.0, 2.0, "settle")
    ledger.on_fill(sell)
    row, positions = ledger.snapshot(2.0, broker.positions(), {}, tags)
    assert row["equity"] == pytest.approx(1000 + 10 * 0.49)
    assert row["realized_pnl"] == pytest.approx(4.9)
    assert row["drawdown"] == 0 and positions == []
    assert row["max_simultaneous_exposure"] == pytest.approx(7.1)


def test_fee_prefers_gamma_schedule_then_clob_then_config():
    plain = Market("m", "", "up", "down")
    scheduled = Market("m", "", "up", "down", fee_rate=0.07)
    assert fee_for(scheduled, 1000, 0.05) == (0.07, "gamma:feeSchedule base_fee=1000")
    assert fee_for(plain, None, 0.07) == (0.07, "config:lookup_failed")
    assert fee_for(plain, 0, 0.07) == (0.0, "clob:base_fee=0")
    assert fee_for(plain, 1000, 0.07) == (0.07, "config:clob_base_fee=1000")


def test_snapshot_delta_replays_exactly_onto_the_previous_book():
    before = OrderBook("up")
    before.replace([{"price": "0.49", "size": "10"}, {"price": "0.48", "size": "5"}],
                   [{"price": "0.51", "size": "7"}])
    snapshot = {"event_type": "book", "asset_id": "up", "timestamp": "1000",
                "bids": [{"price": "0.49", "size": "4"}, {"price": "0.47", "size": "9"}],
                "asks": [{"price": "0.51", "size": "7"}, {"price": "0.52", "size": "3"}]}
    rows = snapshot_delta(before, snapshot, 2.0, 5, 1)
    assert {(r["side"], r["price"], r["size"]) for r in rows} == {
        ("BUY", 0.49, 4.0), ("BUY", 0.48, 0.0), ("BUY", 0.47, 9.0), ("SELL", 0.52, 3.0)}
    assert all(r["is_delta"] for r in rows)
    replayed = OrderBook("up")
    replayed.replace([{"price": "0.49", "size": "10"}, {"price": "0.48", "size": "5"}],
                     [{"price": "0.51", "size": "7"}])
    apply_l2({"up": replayed}, rows)
    before.replace(snapshot["bids"], snapshot["asks"])
    assert (replayed.bids, replayed.asks) == (before.bids, before.asks)


def test_book_rows_flatten_raw_l2_events():
    snapshot = {"event_type": "book", "asset_id": "up", "market": "0xm", "timestamp": "1000",
                "hash": "h", "bids": [{"price": "0.49", "size": "5"}],
                "asks": [{"price": "0.51", "size": "6"}]}
    rows = book_rows(snapshot, 2.0, 7, 1)
    assert [(r["side"], r["price"], r["size"]) for r in rows] == [("BUY", 0.49, 5.0),
                                                                  ("SELL", 0.51, 6.0)]
    assert rows[0]["exchange_ts"] == 1.0 and rows[0]["seq"] == 7
    change = {"event_type": "price_change", "timestamp": "1000", "price_changes": [
        {"asset_id": "up", "side": "BUY", "price": "0.5", "size": "0", "best_bid": "0.49",
         "best_ask": "0.51"}]}
    [row] = book_rows(change, 2.0, 8, 1)
    assert (row["token_id"], row["size"], row["best_ask"]) == ("up", 0.0, 0.51)
    trade = {"event_type": "last_trade_price", "asset_id": "up", "side": "BUY", "price": "0.51",
             "size": "3", "fee_rate_bps": "1000"}
    assert book_rows(trade, 2.0, 9, 1)[0]["fee_rate_bps"] == 1000.0


def test_book_state_keeps_best_levels_first(tmp_path):
    book = OrderBook("yes", tick_size=0.001)
    book.replace([{"price": "0.40", "size": "5"}, {"price": "0.42", "size": "3"},
                  {"price": "0.41", "size": "1"}],
                 [{"price": "0.45", "size": "2"}, {"price": "0.44", "size": "7"}], 1_000)
    state = book_state({"yes": book}, {"yes": {"market": "m", "outcome": "YES"}}, 2, 10.0, 3)
    token = state["tokens"]["yes"]
    assert state["ts"] == 10.0 and state["connection_id"] == 3
    assert token["bids"] == [[0.42, 3.0], [0.41, 1.0]]
    assert token["asks"] == [[0.44, 7.0], [0.45, 2.0]]
    assert token["outcome"] == "YES" and token["tick_size"] == 0.001 and token["updated_at"] == 1.0

    path = tmp_path / "bot" / "book.json"
    write_json_atomic(path, state)
    assert json.loads(path.read_text()) == state
    assert not list(path.parent.glob(".*.tmp"))
