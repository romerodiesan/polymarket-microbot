import pytest

from microbot.book import OrderBook, TopOfBook
from microbot.features import (
    DecayingSum,
    FeatureEngine,
    FeatureRow,
    combine_market,
    order_flow_imbalance,
)


def make_book() -> OrderBook:
    book = OrderBook("yes")
    book.replace(
        bids=[{"price": "0.49", "size": "20"}, {"price": "0.48", "size": "15"}],
        asks=[{"price": "0.51", "size": "5"}, {"price": "0.52", "size": "5"}, {"price": "0.55", "size": "50"}],
    )
    return book


def test_book_and_positive_imbalance():
    row = FeatureEngine().calculate(make_book(), now=100.0)
    assert row is not None
    assert row.best_bid == 0.49
    assert row.best_ask == 0.51
    # Raw 3-level depth leans to asks (far 0.55 wall); decay-weighted depth leans to bids.
    assert row.book_imbalance < 0
    assert row.weighted_imbalance > 0
    assert row.microprice > row.midpoint
    assert row.spread_ticks == pytest.approx(2)
    assert row.top_ask_size == 5


def test_incremental_level_removal_invalidates_cache():
    book = OrderBook("yes")
    book.replace([{"price": "0.49", "size": "2"}], [{"price": "0.51", "size": "3"}])
    assert book.best_bid == 0.49
    book.update_level("BUY", "0.50", "4")
    assert book.best_bid == 0.50
    book.update_level("BUY", "0.50", "0")
    book.update_level("BUY", "0.49", "0")
    assert book.best_bid is None


def test_walk_partial_fill_respects_limit():
    book = make_book()
    filled, avg = book.walk("BUY", 12, limit=0.52)
    assert filled == 10
    assert avg == pytest.approx((5 * 0.51 + 5 * 0.52) / 10)
    filled, avg = book.walk("SELL", 25, limit=0.48)
    assert filled == 25
    assert avg == pytest.approx((20 * 0.49 + 5 * 0.48) / 25)
    assert book.walk("BUY", 5, limit=0.50) == (0.0, 0.0)


def test_weighted_depth_discounts_far_levels():
    book = make_book()
    assert book.weighted_depth("ask", decay=0.5) == pytest.approx(5 + 2.5 + 12.5)


def test_ofi_signs():
    prev = TopOfBook(0.49, 10, 0.51, 10)
    assert order_flow_imbalance(prev, TopOfBook(0.49, 15, 0.51, 10)) == 5
    assert order_flow_imbalance(prev, TopOfBook(0.49, 10, 0.51, 4)) == 6
    assert order_flow_imbalance(prev, TopOfBook(0.50, 3, 0.51, 10)) == 3
    assert order_flow_imbalance(prev, TopOfBook(0.49, 10, 0.50, 7)) == -7
    assert order_flow_imbalance(TopOfBook(None, 0, 0.51, 1), prev) == 0


def test_decaying_sum_halves_per_half_life():
    acc = DecayingSum(half_life=5)
    acc.add(8, t=0)
    assert acc.read(5) == pytest.approx(4)
    assert acc.read(10) == pytest.approx(2)


def test_score_needs_warmup_then_reacts_to_bid_pressure():
    engine = FeatureEngine()
    book = make_book()
    rows = [engine.calculate(book, now=float(t)) for t in range(40)]
    assert all(r.score == 0 for r in rows[:30])
    for t in range(40, 50):
        prev = book.top()
        book.update_level("BUY", "0.49", str(20 + 30 * (t - 39)))
        engine.on_book_event("yes", prev, book.top(), float(t))
        engine.on_trade("yes", "BUY", 20, float(t))
        row = engine.calculate(book, now=float(t))
    assert row.score > 0.3


def _row(token: str, score: float) -> FeatureRow:
    return FeatureRow(0, token, .49, .51, .50, .02, 20, 20, 0, .5, 0, 0, 0, score)


def test_combine_market_makes_yes_and_no_complementary():
    rows = {"yes": _row("yes", 0.6), "no": _row("no", -0.2)}
    assert combine_market(rows, "yes", "no") == pytest.approx(0.4)
    assert rows["yes"].score == pytest.approx(0.4)
    assert rows["no"].score == pytest.approx(-0.4)
    only_no = {"no": _row("no", 0.3)}
    assert combine_market(only_no, "yes", "no") == pytest.approx(-0.3)
