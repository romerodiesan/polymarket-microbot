import asyncio

import pytest

from microbot.book import OrderBook
from microbot.broker import PaperBroker
from microbot.config import Settings
from microbot.strategy import Intent


def make_book() -> OrderBook:
    book = OrderBook("yes")
    book.replace(
        bids=[{"price": "0.49", "size": "3"}, {"price": "0.47", "size": "10"}],
        asks=[{"price": "0.51", "size": "2"}, {"price": "0.52", "size": "2"}, {"price": "0.60", "size": "50"}],
    )
    return book


def test_paper_buy_walks_book_and_fills_partially():
    broker = PaperBroker(Settings(yes_token_id="yes", no_token_id="no"))
    fill = asyncio.run(broker.submit(Intent("yes", "BUY", 10, 0.52, "entry"), make_book()))
    assert fill.size == 4
    assert fill.price == pytest.approx(0.515)
    assert fill.reason == "entry"
    assert broker.position("yes") == 4
    assert broker.cash == pytest.approx(1000 - 4 * 0.515)


def test_paper_sell_realizes_pnl_against_average_entry():
    broker = PaperBroker(Settings(yes_token_id="yes", no_token_id="no"))
    book = make_book()
    asyncio.run(broker.submit(Intent("yes", "BUY", 4, 0.52, "entry"), book))
    fill = asyncio.run(broker.submit(Intent("yes", "SELL", 4, 0.48, "take_profit"), book))
    assert fill.size == 3
    assert fill.pnl == pytest.approx((0.49 - 0.515) * 3)
    assert broker.position("yes") == pytest.approx(1)
    assert broker.positions()["yes"].avg_price == pytest.approx(0.515)


def test_paper_order_outside_limit_does_not_fill():
    broker = PaperBroker(Settings(yes_token_id="yes", no_token_id="no"))
    assert asyncio.run(broker.submit(Intent("yes", "BUY", 1, 0.50, "entry"), make_book())) is None
    assert asyncio.run(broker.submit(Intent("yes", "SELL", 1, 0.40, "exit"), make_book())) is None
