from microbot.config import Settings
from microbot.risk import EntryRisk


def settings(**overrides):
    return Settings(yes_token_id="yes", no_token_id="no", **overrides)


def fill(ts, side="SELL", pnl=-1.0, market="m"):
    return {"ts": ts, "market": market, "side": side, "pnl": pnl}


def test_daily_net_loss_and_streak_survive_restart():
    history = [fill(100 + i) for i in range(5)]
    guard = EntryRisk(settings(), history)
    assert guard.block_reason("another-market", 200) == "consecutive_loss_limit"
    budget = EntryRisk(settings(max_consecutive_losses=0, max_daily_loss=4), history)
    assert budget.block_reason("another-market", 200) == "daily_loss_limit"


def test_cooldown_and_market_cap_use_recorded_fills():
    history = [fill(100, "BUY"), fill(105), fill(140, "BUY"), fill(145), fill(180, "BUY")]
    guard = EntryRisk(settings(), history)
    assert guard.block_reason("m", 190) == "market_entry_limit"
    guard = EntryRisk(settings(max_entries_per_market=0), history)
    assert guard.block_reason("m", 160) == "loss_cooldown"
    assert guard.block_reason("m", 200) is None


def test_midnight_rolls_daily_budget_and_a_win_resets_the_streak():
    guard = EntryRisk(settings(max_consecutive_losses=2), [fill(100), fill(101)])
    assert guard.block_reason("other", 200) == "consecutive_loss_limit"
    assert guard.block_reason("other", 86400) is None
    guard.on_fill(fill(86401))
    guard.on_fill(fill(86402, pnl=2.0))
    assert guard.realized == 1.0 and guard.loss_streak == 0


def test_fixed_tokens_share_one_risk_budget():
    guard = EntryRisk(settings(max_entries_per_market=1), [
        {"ts": 100, "side": "BUY", "market": "", "token_id": "no"}])
    assert guard.block_reason("yes", 101) == "market_entry_limit"
