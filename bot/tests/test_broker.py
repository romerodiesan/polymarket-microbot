import asyncio

import pytest

from microbot.book import OrderBook
from microbot.broker import OrderContext, PaperBroker, polymarket_fee
from microbot.config import Settings
from microbot.strategy import Intent


def make_book() -> OrderBook:
    book = OrderBook("yes")
    book.replace(
        bids=[{"price": "0.49", "size": "3"}, {"price": "0.47", "size": "10"}],
        asks=[{"price": "0.51", "size": "2"}, {"price": "0.52", "size": "2"}, {"price": "0.60", "size": "50"}],
    )
    return book


def broker(**overrides) -> PaperBroker:
    return PaperBroker(Settings(yes_token_id="yes", no_token_id="no", fee_rate=0, **overrides))


def submit(b: PaperBroker, intent: Intent, book: OrderBook, context=None):
    return asyncio.run(b.submit(intent, book, context))


def test_paper_buy_walks_book_and_fills_partially():
    b = broker()
    execution = submit(b, Intent("yes", "BUY", 10, 0.52, "entry"), make_book())
    fill, order = execution.fill, execution.order
    assert fill.size == 4
    assert fill.price == pytest.approx(0.515)
    assert fill.reason == "entry"
    assert b.position("yes") == 4
    assert b.cash == pytest.approx(1000 - 4 * 0.515)
    assert order.status == "partial"
    assert order.filled_size == 4 and order.requested_size == 10
    assert order.decision_ask == 0.51 and order.decision_mid == pytest.approx(0.50)
    assert order.slippage_vs_touch == pytest.approx(0.005)
    assert order.slippage_vs_mid == pytest.approx(0.015)


def test_paper_sell_realizes_pnl_against_average_entry():
    b = broker()
    book = make_book()
    submit(b, Intent("yes", "BUY", 4, 0.52, "entry"), book)
    fill = submit(b, Intent("yes", "SELL", 4, 0.48, "take_profit"), book).fill
    assert fill.size == 3
    assert fill.pnl == pytest.approx((0.49 - 0.515) * 3)
    assert b.position("yes") == pytest.approx(1)
    assert b.positions()["yes"].avg_price == pytest.approx(0.515)


def test_paper_order_outside_limit_is_rejected_with_reason():
    b = broker()
    buy = submit(b, Intent("yes", "BUY", 1, 0.50, "entry"), make_book())
    assert buy.fill is None
    assert (buy.order.status, buy.order.reject_reason) == ("rejected", "no_liquidity_within_limit")
    sell = submit(b, Intent("yes", "SELL", 1, 0.40, "exit"), make_book())
    assert sell.fill is None and sell.order.reject_reason == "no_position"


def test_fee_uses_token_rate_and_rounds_to_five_decimals():
    assert polymarket_fee(0.07, 10, 0.5) == pytest.approx(0.175)
    assert polymarket_fee(0.07, 0.001, 0.99) == 0.0
    b = broker()
    b.fees.set("yes", 0.07, "clob:base_fee=1000")
    execution = submit(b, Intent("yes", "BUY", 2, 0.51, "entry"), make_book())
    assert execution.fill.fee == pytest.approx(round(2 * 0.07 * 0.51 * 0.49, 5))
    assert execution.fill.fee_source == execution.order.fee_source == "clob:base_fee=1000"
    assert b.cash == pytest.approx(1000 - 2 * 0.51 - execution.fill.fee)


def test_haircut_and_extra_slippage_make_fills_worse():
    b = broker(paper_fill_haircut=0.5, paper_extra_slippage_ticks=1)
    fill = submit(b, Intent("yes", "BUY", 10, 0.53, "entry"), make_book()).fill
    # Half of each level, one tick worse: 1 @ 0.52 and 1 @ 0.53.
    assert fill.size == pytest.approx(2)
    assert fill.price == pytest.approx(0.525)


def test_latency_executes_against_the_book_after_the_delay():
    b = broker(paper_latency_ms=20)
    book = make_book()

    async def scenario():
        task = asyncio.create_task(
            b.submit(Intent("yes", "BUY", 2, 0.52, "entry"), book, OrderContext(signal_ts=1.0)))
        await asyncio.sleep(0)
        book.update_level("SELL", "0.51", "0")  # the best ask disappears while in flight
        return await task

    execution = asyncio.run(scenario())
    assert execution.order.decision_ask == 0.51
    assert execution.order.exec_ask == 0.52
    assert execution.fill.price == pytest.approx(0.52)
    assert execution.order.latency_ms == 20
    assert execution.order.signal_ts == 1.0


def test_settlement_pays_out_and_closes_the_position():
    b = broker()
    submit(b, Intent("yes", "BUY", 2, 0.51, "entry"), make_book())
    fill = b.settle("yes", 1.0, 100.0, "settle-x-YES")
    assert fill.reason == "settlement" and fill.price == 1.0
    assert fill.pnl == pytest.approx((1 - 0.51) * 2)
    assert b.position("yes") == 0
    assert b.cash == pytest.approx(1000 + 2 * (1 - 0.51))
    assert b.settle("yes", 1.0, 100.0, "again") is None
