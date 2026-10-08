import asyncio
import json
import math
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlencode
from urllib.request import Request, urlopen

GAMMA_HOST = "https://gamma-api.polymarket.com"


@dataclass(frozen=True, slots=True)
class Market:
    """A binary market; YES is the first outcome (e.g. "Up"), NO the second."""

    slug: str
    question: str
    yes_token_id: str
    no_token_id: str
    end_ts: float = math.inf

    def outcome(self, token_id: str) -> str:
        return "YES" if token_id == self.yes_token_id else "NO"


def _parse_ts(value: str | None) -> float | None:
    if not value:
        return None
    return datetime.fromisoformat(value).timestamp()


def pick_market(events: list[dict], after: float) -> Market | None:
    """The market ending soonest after `after` that still accepts orders."""
    candidates = []
    for event in events:
        for m in event.get("markets", []):
            end = _parse_ts(m.get("endDate"))
            if end is None or end <= after or m.get("closed") or not m.get("acceptingOrders"):
                continue
            tokens = json.loads(m.get("clobTokenIds") or "[]")
            if len(tokens) != 2:
                continue
            candidates.append(Market(m["slug"], m.get("question", ""), tokens[0], tokens[1], end))
    return min(candidates, key=lambda c: c.end_ts, default=None)


def _get_json(url: str) -> list[dict]:
    request = Request(url, headers={"User-Agent": "polymarket-microbot"})
    with urlopen(request, timeout=10) as response:
        return json.load(response)


async def find_series_market(series_slug: str, after: float) -> Market | None:
    """Current market of a rolling series such as `btc-up-or-down-15m`."""
    query = urlencode({
        "series_slug": series_slug, "active": "true", "closed": "false", "order": "endDate",
        "ascending": "true", "limit": 10,
        "end_date_min": datetime.fromtimestamp(after, UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    events = await asyncio.to_thread(_get_json, f"{GAMMA_HOST}/events?{query}")
    return pick_market(events, after)
