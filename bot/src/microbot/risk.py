"""Entry pauses shared by online trading and chronological replay."""

from collections.abc import Iterable
from datetime import UTC, datetime

from .config import Settings


def day_start(ts: float) -> float:
    return datetime.fromtimestamp(ts, UTC).replace(hour=0, minute=0, second=0,
                                                  microsecond=0).timestamp()


class EntryRisk:
    """Limits use realized net P&L, not the signal. Exits are always permitted.

    Restore with today's fills of the same trading mode, including previous run IDs.
    The daily pause and loss streak reset at midnight UTC; market counts do not.
    """

    def __init__(self, settings: Settings, history: Iterable[dict] = ()) -> None:
        self.s = settings
        self.day: float | None = None
        self.realized = 0.0
        self.loss_streak = 0
        self.entries: dict[str, int] = {}
        self.last_loss: dict[str, float] = {}
        for fill in history:
            self.on_fill(fill)

    def _roll_day(self, ts: float) -> None:
        day = day_start(ts)
        if self.day != day:
            self.day, self.realized, self.loss_streak = day, 0.0, 0

    def on_fill(self, fill: dict) -> None:
        self._roll_day(float(fill["ts"]))
        market = fill.get("market") or self.s.yes_token_id or fill.get("token_id", "")
        if fill["side"] == "BUY":
            self.entries[market] = self.entries.get(market, 0) + 1
            return
        pnl = float(fill.get("pnl") or 0.0)
        self.realized += pnl
        if pnl < 0:
            self.loss_streak += 1
            self.last_loss[market] = float(fill["ts"])
        elif pnl > 0:
            self.loss_streak = 0

    def block_reason(self, market: str, now: float) -> str | None:
        self._roll_day(now)
        if self.s.max_daily_loss and self.realized <= -self.s.max_daily_loss:
            return "daily_loss_limit"
        if self.s.max_consecutive_losses and self.loss_streak >= self.s.max_consecutive_losses:
            return "consecutive_loss_limit"
        if (self.s.max_entries_per_market
                and self.entries.get(market, 0) >= self.s.max_entries_per_market):
            return "market_entry_limit"
        last_loss = self.last_loss.get(market)
        if last_loss is not None and now - last_loss < self.s.loss_cooldown_seconds:
            return "loss_cooldown"
        return None
