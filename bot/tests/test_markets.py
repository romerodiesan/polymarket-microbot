from datetime import UTC, datetime

from microbot.markets import pick_market


def ts(hhmm: str) -> float:
    return datetime.fromisoformat(f"2026-10-08T{hhmm}:00+00:00").astimezone(UTC).timestamp()


def market(slug: str, end: str, **overrides) -> dict:
    return {
        "slug": slug, "question": slug, "endDate": f"2026-10-08T{end}:00Z", "closed": False,
        "acceptingOrders": True, "clobTokenIds": f'["{slug}-up", "{slug}-down"]',
    } | overrides


def test_picks_the_open_market_ending_soonest():
    events = [{"markets": [market("late", "22:00")]}, {"markets": [market("now", "21:45")]}]
    picked = pick_market(events, after=ts("21:35"))
    assert (picked.slug, picked.yes_token_id, picked.no_token_id) == ("now", "now-up", "now-down")
    assert picked.end_ts == ts("21:45")
    assert picked.outcome("now-down") == "NO"


def test_skips_markets_ending_before_cutoff_or_not_tradable():
    events = [{"markets": [
        market("ending", "21:45"),
        market("closed", "21:50", closed=True),
        market("paused", "21:55", acceptingOrders=False),
        market("next", "22:00"),
    ]}]
    assert pick_market(events, after=ts("21:45")).slug == "next"
    assert pick_market([], after=ts("21:45")) is None
