from dataclasses import dataclass
from time import time

from .config import Settings
from .features import FeatureRow
from .positions import Position

MAX_LIMIT_PRICE = 0.99
MIN_LIMIT_PRICE = 0.01


@dataclass(slots=True)
class Intent:
    token_id: str
    side: str
    size: float
    limit_price: float
    reason: str


@dataclass(slots=True)
class Decision:
    """Why the last `decide` call did (or did not) trade."""

    action: str = "skip"  # enter, exit, hold or skip
    reason: str = ""
    token_id: str = ""
    threshold: float | None = None
    intended_size: float = 0.0


class MicrostructureStrategy:
    """Directional taker strategy that holds at most one side of a binary market."""

    def __init__(self, settings: Settings) -> None:
        self.s = settings
        self.yes = settings.yes_token_id
        self.no = settings.no_token_id
        self.last_action_at = 0.0
        self.last_decision = Decision()

    def market_signal(self, rows: dict[str, FeatureRow]) -> float:
        if self.yes in rows:
            return rows[self.yes].score
        if self.no in rows:
            return -rows[self.no].score
        return 0.0

    def decide(self, rows: dict[str, FeatureRow], positions: dict[str, Position],
               now: float | None = None) -> list[Intent]:
        now = now or time()
        signal = self.market_signal(rows)

        for token in (self.yes, self.no):
            pos = positions.get(token)
            if pos and pos.open:
                exit_intent = self._exit(token, pos, rows.get(token), signal, now)
                if exit_intent:
                    self.last_action_at = now
                    self.last_decision = Decision("exit", exit_intent.reason, token,
                                                  self.s.exit_threshold, exit_intent.size)
                    return [exit_intent]
                # Never add to or flip an open position in the same decision.
                self.last_decision = Decision("hold", "position_open", token,
                                              self.s.exit_threshold)
                return []

        entry = self._entry(rows, signal, now)
        if entry:
            self.last_action_at = now
            self.last_decision.action = "enter"
            self.last_decision.intended_size = entry.size
            return [entry]
        return []

    def _exit(self, token: str, pos: Position, row: FeatureRow | None, signal: float,
              now: float) -> Intent | None:
        if row is None:
            return None
        favour = signal if token == self.yes else -signal
        age = now - pos.opened_at
        if row.midpoint >= pos.avg_price + self.s.take_profit:
            reason = "take_profit"
        elif row.midpoint <= pos.avg_price - self.s.stop_loss:
            reason = "stop_loss"
        elif age >= self.s.max_hold_seconds:
            reason = "max_hold"
        elif favour <= -self.s.exit_threshold:
            reason = "signal_reversal"
        elif age >= self.s.min_hold_seconds and abs(favour) <= self.s.exit_threshold:
            reason = "signal_faded"
        else:
            return None
        limit = max(MIN_LIMIT_PRICE, row.best_bid - self.s.max_slippage)
        return Intent(token, "SELL", pos.size, limit, f"{reason} score={favour:.3f}")

    def _skip(self, reason: str, token: str = "", threshold: float | None = None) -> None:
        self.last_decision = Decision("skip", reason, token, threshold)

    def _entry(self, rows: dict[str, FeatureRow], signal: float, now: float) -> Intent | None:
        token = self.yes if signal > 0 else self.no
        if now - self.last_action_at < self.s.cooldown_seconds:
            self._skip("cooldown", token)
            return None
        row = rows.get(token)
        if row is None:
            self._skip("no_book", token)
            return None
        strength = abs(signal)
        required = self.s.signal_threshold + self.s.spread_penalty * row.spread_ticks
        if row.spread > self.s.max_spread:
            self._skip("spread", token, required)
            return None
        if min(row.bid_depth_3, row.ask_depth_3) < self.s.min_top_depth:
            self._skip("depth", token, required)
            return None
        if not self.s.min_price <= row.best_ask <= self.s.max_price:
            self._skip("price_range", token, required)
            return None
        if row.volatility > self.s.max_volatility:
            self._skip("volatility", token, required)
            return None
        if strength < required or required >= 1:
            self._skip("below_threshold", token, required)
            return None

        # Scale between half and full order size with how far the signal clears the bar.
        conviction = min(1.0, (strength - required) / (1 - required))
        size = self.s.order_size_shares * (0.5 + 0.5 * conviction)
        size = min(size, self.s.max_position_shares)
        size = min(size, row.top_ask_size * self.s.max_top_participation)
        size = round(size, 2)
        if size < self.s.min_order_shares:
            self._skip("min_size", token, required)
            return None
        limit = min(MAX_LIMIT_PRICE, row.best_ask + self.s.max_slippage)
        self._skip("entry", token, required)
        return Intent(token, "BUY", size, limit, f"entry score={strength:.3f} req={required:.3f}")
