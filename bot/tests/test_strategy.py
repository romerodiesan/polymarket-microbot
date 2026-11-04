import pytest

from microbot.config import Settings
from microbot.features import FeatureRow
from microbot.positions import Position, PositionBook
from microbot.strategy import MicrostructureStrategy


def settings(**overrides) -> Settings:
    base = {
        "yes_token_id": "yes", "no_token_id": "no", "cooldown_seconds": 0, "signal_threshold": 0.2,
        "spread_penalty": 0.02, "min_top_depth": 1, "order_size_shares": 4, "take_profit": 0.03,
        "stop_loss": 0.02, "min_hold_seconds": 10, "max_hold_seconds": 600, "max_slippage": 0.01,
    }
    return Settings(**(base | overrides))


def market(signal: float, yes_mid: float = 0.50, **row_overrides) -> dict[str, FeatureRow]:
    def row(token: str, mid: float, score: float) -> FeatureRow:
        values = {
            "ts": 0, "token_id": token, "best_bid": mid - 0.01, "best_ask": mid + 0.01,
            "midpoint": mid, "spread": 0.02, "bid_depth_3": 50, "ask_depth_3": 50,
            "book_imbalance": 0, "microprice": mid, "microprice_delta": 0, "flow_imbalance": 0,
            "trade_pressure": 0, "score": score, "spread_ticks": 2, "top_bid_size": 20,
            "top_ask_size": 20,
        }
        return FeatureRow(**(values | row_overrides))
    return {"yes": row("yes", yes_mid, signal), "no": row("no", 1 - yes_mid, -signal)}


def test_buys_the_favoured_side_only():
    strategy = MicrostructureStrategy(settings())
    [intent] = strategy.decide(market(0.6), {}, now=100)
    assert (intent.token_id, intent.side) == ("yes", "BUY")
    assert intent.limit_price == pytest.approx(0.52)
    [intent] = MicrostructureStrategy(settings()).decide(market(-0.6), {}, now=100)
    assert intent.token_id == "no"


def test_requires_signal_above_spread_adjusted_threshold():
    strategy = MicrostructureStrategy(settings())
    assert strategy.decide(market(0.23), {}, now=100) == []
    assert strategy.decide(market(0.25), {}, now=100)


def test_size_scales_with_conviction_and_top_participation():
    strategy = MicrostructureStrategy(settings(max_top_participation=0.1))
    [intent] = strategy.decide(market(0.9, top_ask_size=10), {}, now=100)
    assert intent.size == 1.0
    [weak] = MicrostructureStrategy(settings()).decide(market(0.25), {}, now=100)
    [strong] = MicrostructureStrategy(settings()).decide(market(0.95), {}, now=100)
    assert weak.size < strong.size <= 4


def test_never_opens_opposite_side_while_holding():
    strategy = MicrostructureStrategy(settings())
    held = {"yes": Position(size=4, avg_price=0.51, opened_at=95)}
    [intent] = strategy.decide(market(-0.6), held, now=100)
    assert (intent.token_id, intent.side) == ("yes", "SELL")
    assert intent.reason.startswith("signal_reversal")


@pytest.mark.parametrize(
    ("yes_mid", "signal", "age", "reason"),
    [
        (0.59, 0.5, 5, "take_profit"),
        (0.48, 0.5, 5, "stop_loss"),
        (0.50, 0.5, 700, "max_hold"),
        (0.50, 0.01, 20, "signal_faded"),
    ],
)
def test_exit_reasons(yes_mid, signal, age, reason):
    strategy = MicrostructureStrategy(settings())
    held = {"yes": Position(size=4, avg_price=0.51, opened_at=1000)}
    [intent] = strategy.decide(market(signal, yes_mid=yes_mid), held, now=1000 + age)
    assert intent.side == "SELL"
    assert intent.reason.startswith(reason)


def test_holds_neutral_signal_before_min_hold():
    strategy = MicrostructureStrategy(settings())
    held = {"yes": Position(size=4, avg_price=0.51, opened_at=1000)}
    assert strategy.decide(market(0.01), held, now=1005) == []


def test_rejects_extreme_prices_and_high_volatility():
    strategy = MicrostructureStrategy(settings())
    assert strategy.decide(market(0.9, yes_mid=0.97), {}, now=100) == []
    assert strategy.decide(market(0.9, volatility=0.2), {}, now=100) == []


@pytest.mark.parametrize(
    ("signal", "overrides", "action", "reason"),
    [
        (0.23, {}, "skip", "below_threshold"),
        (0.9, {"volatility": 0.2}, "skip", "volatility"),
        (0.9, {"spread": 0.5}, "skip", "spread"),
        (0.9, {}, "enter", "entry"),
    ],
)
def test_last_decision_explains_the_filter(signal, overrides, action, reason):
    strategy = MicrostructureStrategy(settings())
    strategy.decide(market(signal, **overrides), {}, now=100)
    decision = strategy.last_decision
    assert (decision.action, decision.reason, decision.token_id) == (action, reason, "yes")
    assert decision.threshold == pytest.approx(0.2 + 0.02 * 2)
    assert (decision.intended_size > 0) == (action == "enter")


def test_last_decision_reports_hold_and_exit():
    strategy = MicrostructureStrategy(settings())
    held = {"yes": Position(size=4, avg_price=0.51, opened_at=1000)}
    strategy.decide(market(0.01), held, now=1005)
    assert (strategy.last_decision.action, strategy.last_decision.reason) == ("hold", "position_open")
    strategy.decide(market(-0.6), held, now=1005)
    assert strategy.last_decision.action == "exit"
    assert strategy.last_decision.intended_size == 4


def test_profit_target_requires_net_proceeds_at_the_order_limit():
    strategy = MicrostructureStrategy(settings())
    # This midpoint cleared the old target, but sale fee + spread + slippage consume the gain.
    held = {"yes": Position(size=4, avg_price=0.51, opened_at=1000)}
    assert strategy.decide(market(0.5, yes_mid=0.55), held, now=1005) == []
    [intent] = strategy.decide(market(0.5, yes_mid=0.59), held, now=1006)
    from microbot.fees import polymarket_fee

    net = intent.limit_price - polymarket_fee(0.07, 4, intent.limit_price) / 4 - 0.51
    assert net >= strategy.s.take_profit


def test_uses_the_markets_actual_fee_schedule_for_profit_target():
    held = {"yes": Position(size=4, avg_price=0.51, opened_at=1000)}
    free = MicrostructureStrategy(settings(), lambda token: (0, "venue:free", 1))
    charged = MicrostructureStrategy(settings(), lambda token: (0.14, "stress", 1))
    assert free.decide(market(0.5, yes_mid=0.57), held, now=1005)
    assert charged.decide(market(0.5, yes_mid=0.57), held, now=1005) == []


def test_entry_commission_does_not_move_the_price_stop_closer():
    book = PositionBook()
    book.apply("yes", "BUY", 2, 0.51, 0.035, 1000)
    strategy = MicrostructureStrategy(settings())
    # The entry fee is part of net P&L, not an adverse price movement.
    assert strategy.decide(market(0.5), book.positions, now=1001) == []
    [intent] = strategy.decide(market(0.5, yes_mid=0.48), book.positions, now=1002)
    assert intent.reason.startswith("stop_loss")


def test_gap_blocks_entries_but_allows_exits():
    strategy = MicrostructureStrategy(settings())
    assert strategy.decide(market(0.9), {}, now=100, entry_block_reason="data_gap") == []
    assert strategy.last_decision.reason == "data_gap"
    held = {"yes": Position(size=4, avg_price=0.51, opened_at=95)}
    [intent] = strategy.decide(market(-0.6), held, now=100, entry_block_reason="data_gap")
    assert intent.side == "SELL"


def test_needs_both_sides_and_rejects_an_unreachable_net_target():
    strategy = MicrostructureStrategy(settings())
    assert strategy.decide({"yes": market(0.9)["yes"]}, {}, now=100) == []
    assert strategy.last_decision.reason == "incomplete_market"
    expensive = MicrostructureStrategy(settings(max_price=0.99, max_slippage=0.03,
                                               take_profit=0.1))
    assert expensive.decide(market(0.9, yes_mid=0.94), {}, now=100) == []
    assert expensive.last_decision.reason == "net_target_unreachable"


def test_zero_is_a_valid_replay_timestamp():
    strategy = MicrostructureStrategy(settings())
    strategy.decide(market(0.9), {}, now=0.0)
    assert strategy.last_action_at == 0.0
