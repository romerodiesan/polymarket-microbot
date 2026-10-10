"""Replay the strategy over recorded data with pessimistic fills and settle at the official payout."""

import argparse
import asyncio
import json
import math
import sys
from dataclasses import asdict, dataclass, field, fields
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import duckdb
import numpy as np
import pandas as pd
from pydantic import ValidationError

from .book import OrderBook
from .broker import take
from .config import Settings
from .features import FeatureRow, combine_market
from .markets import fetch_gamma_market, market_from_gamma, parse_resolution
from .model import FEATURE_COLUMNS
from .positions import PositionBook
from .strategy import MIN_LIMIT_PRICE, Intent, MicrostructureStrategy

DEFAULT_TICK = 0.01
ROW_FIELDS = {f.name for f in fields(FeatureRow)}


@dataclass(frozen=True, slots=True)
class Scenario:
    latency_multiplier: float = 1.0
    extra_slippage_ticks: float = 0.0
    fee_multiplier: float = 1.0
    fill_haircut: float = 1.0


SCENARIOS = {
    "base": Scenario(1, 0, 1.0, 1.0),
    "pessimistic": Scenario(2, 1, 1.5, 0.5),
    "stress": Scenario(4, 2, 2.0, 0.25),
}


@dataclass(slots=True)
class MarketResult:
    market: str
    end_ts: float
    fidelity: str
    settled_by: str  # payout, flat or unresolved
    pnl: float = 0.0
    fees: float = 0.0
    entries: int = 0
    orders: int = 0
    filled: int = 0
    partial: int = 0
    rejected: int = 0
    slippage: list[float] = field(default_factory=list)
    exits: list[float] = field(default_factory=list)


# --- Data loading -------------------------------------------------------------------------------

def truthy(value) -> bool:
    """Booleans read back from Parquet may be numpy values, None or NaN."""
    return value is not None and not pd.isna(value) and bool(value)


def _files(data_dir: Path, table: str) -> list[str]:
    parquet = data_dir / "parquet"
    paths = [parquet / f"{table}.parquet", *sorted((parquet / table).glob("*.parquet"))]
    return [p.as_posix() for p in paths if p.is_file()]


def read_table(data_dir: Path, table: str, where: str = "", params: list | None = None) -> pd.DataFrame:
    files = _files(data_dir, table)
    if not files:
        return pd.DataFrame()
    return duckdb.connect().execute(
        f"SELECT * FROM read_parquet(?, union_by_name=true) {where}", [files, *(params or [])]
    ).fetchdf()


def load_markets(data_dir: Path, features: pd.DataFrame) -> pd.DataFrame:
    """Market metadata from the `markets` table, or inferred from the features."""
    markets = read_table(data_dir, "markets")
    inferred = []
    for slug, group in features.groupby("market", sort=False):
        if not slug:
            continue
        outcomes = group.drop_duplicates("token_id").set_index("token_id")["outcome"]
        yes = [t for t, o in outcomes.items() if o == "YES"]
        no = [t for t, o in outcomes.items() if o == "NO"]
        inferred.append({"slug": slug, "yes_token_id": yes[0] if yes else None,
                         "no_token_id": no[0] if no else None, "end_ts": None})
    inferred = pd.DataFrame(inferred)
    if markets.empty:
        return inferred
    missing = inferred[~inferred["slug"].isin(markets["slug"])] if not inferred.empty else inferred
    return pd.concat([markets, missing], ignore_index=True)


METADATA = ("end_ts", "start_ts", "tick_size", "fee_rate", "fee_exponent", "yes_token_id",
            "no_token_id")


async def fetch_resolutions(markets: pd.DataFrame) -> pd.DataFrame:
    """Payouts and missing metadata from Gamma (for data recorded before the resolver existed)."""
    markets = markets.astype(object).copy()
    for column in ("payout_yes", "payout_no", "resolved", *METADATA):
        if column not in markets:
            markets[column] = None
    for i, row in markets.iterrows():
        if truthy(row.get("resolved")) and not any(pd.isna(row.get(c)) for c in METADATA):
            continue
        try:
            data = await fetch_gamma_market(row["slug"])
        except (OSError, ValueError):
            continue
        if not data:
            continue
        resolution = parse_resolution(data)
        if resolution:
            markets.loc[i, ["payout_yes", "payout_no", "resolved"]] = [
                resolution.payout_yes, resolution.payout_no, True]
        meta = market_from_gamma(data, (data.get("events") or [{}])[0])
        if meta:
            for column in METADATA:
                if pd.isna(row.get(column)):
                    markets.at[i, column] = getattr(meta, column)
    return markets


def base_latency_ms(data_dir: Path, settings: Settings) -> float:
    if settings.paper_latency_ms is not None:
        return settings.paper_latency_ms
    events = read_table(data_dir, "stream_events", "WHERE kind = 'rtt' AND value IS NOT NULL")
    return float(events["value"].median()) if not events.empty else 0.0


# --- Signals ------------------------------------------------------------------------------------

def model_probabilities(model_path: Path, features: pd.DataFrame) -> np.ndarray:
    import joblib

    payload = joblib.load(model_path)
    columns = payload.get("columns", FEATURE_COLUMNS)
    probs = np.full(len(features), np.nan)
    usable = features[columns].notna().all(axis=1).to_numpy()
    if usable.any():
        probs[usable] = payload["model"].predict_proba(features.loc[usable, columns])[:, 1]
    return probs


def momentum_scores(features: pd.DataFrame, horizon: float = 15.0) -> np.ndarray:
    """Per-token score in the direction of the midpoint move over the last `horizon` seconds."""
    frame = features[["token_id", "ts", "midpoint"]].reset_index()
    frame["past_ts"] = frame["ts"] - horizon
    past = features[["token_id", "ts", "midpoint"]].rename(columns={"ts": "h_ts", "midpoint": "past"})
    merged = pd.merge_asof(frame.sort_values("past_ts"), past.sort_values("h_ts"),
                           left_on="past_ts", right_on="h_ts", by="token_id", direction="backward")
    merged = merged.set_index("index").loc[features.index]
    return np.clip(((merged["midpoint"] - merged["past"]) / 0.02).fillna(0).to_numpy(), -1, 1)


def with_signal(features: pd.DataFrame, source: str, model_path: Path | None,
                seed: int = 0) -> pd.DataFrame:
    """Features whose `score` is the per-token signal of `source` (before combining YES/NO)."""
    frame = features.copy()
    if source == "model":
        probs = model_probabilities(model_path, frame)
        frame["score"] = np.where(np.isnan(probs), 0.0, 2 * probs - 1)
        frame["combine"] = True
    elif source == "momentum":
        frame["score"] = momentum_scores(frame)
        frame["combine"] = True
    elif source == "random":
        frame["score"] = np.random.default_rng(seed).uniform(-1, 1, len(frame))
        frame["combine"] = True
    else:  # recorded: the stored score was already combined by the bot
        frame["combine"] = False
    return frame


# --- Replay -------------------------------------------------------------------------------------

def synthetic_book(book: OrderBook, row: dict, tick: float) -> None:
    """Approximate a book from top of book and three-level depth."""
    bids = [{"price": row["best_bid"], "size": row.get("top_bid_size") or 0}]
    asks = [{"price": row["best_ask"], "size": row.get("top_ask_size") or 0}]
    rest_bid = (row.get("bid_depth_3") or 0) - (row.get("top_bid_size") or 0)
    rest_ask = (row.get("ask_depth_3") or 0) - (row.get("top_ask_size") or 0)
    if rest_bid > 0 and row["best_bid"] - tick > 0:
        bids.append({"price": row["best_bid"] - tick, "size": rest_bid})
    if rest_ask > 0 and row["best_ask"] + tick < 1:
        asks.append({"price": row["best_ask"] + tick, "size": rest_ask})
    book.replace(bids, asks, int(row["ts"] * 1000))
    book.tick_size = tick


def l2_items(events: pd.DataFrame) -> list[tuple[float, int, str, list[dict]]]:
    """Raw L2 rows grouped into exchange messages: (ts, order, "book", rows)."""
    items = []
    if events.empty:
        return items
    events = events.sort_values(["recv_ts", "connection_id", "seq"], kind="stable")
    for _, group in events.groupby(["connection_id", "seq"], sort=False):
        rows = group.to_dict("records")
        items.append((float(rows[0]["recv_ts"]), 0, "book", rows))
    return items


def apply_l2(books: dict[str, OrderBook], rows: list[dict]) -> None:
    kind = rows[0]["event_type"]
    if kind == "book" and truthy(rows[0].get("is_delta")):
        for r in rows:
            if r["token_id"] in books:
                books[r["token_id"]].update_level(r["side"], r["price"], r["size"],
                                                  int(r["recv_ts"] * 1000))
    elif kind == "book":
        token = rows[0]["token_id"]
        if token in books:
            levels = [r for r in rows if r.get("side") in ("BUY", "SELL")]
            books[token].replace(
                [{"price": r["price"], "size": r["size"]} for r in levels if r["side"] == "BUY"],
                [{"price": r["price"], "size": r["size"]} for r in levels if r["side"] == "SELL"],
                int(rows[0]["recv_ts"] * 1000),
            )
    elif kind == "price_change":
        for r in rows:
            if r["token_id"] in books and r.get("side"):
                books[r["token_id"]].update_level(r["side"], r["price"], r["size"],
                                                  int(r["recv_ts"] * 1000))
    elif kind == "tick_size_change":
        for r in rows:
            if r["token_id"] in books and r.get("price"):
                books[r["token_id"]].tick_size = float(r["price"])


@dataclass(slots=True)
class Portfolio:
    cash: float
    positions: PositionBook = field(default_factory=PositionBook)


def replay_market(meta: dict, rows: pd.DataFrame, l2: pd.DataFrame, settings: Settings,
                  scenario: Scenario, latency_ms: float, portfolio: Portfolio) -> MarketResult:
    yes, no = meta["yes_token_id"], meta["no_token_id"]
    ms = settings.model_copy(update={"yes_token_id": yes, "no_token_id": no})
    strategy = MicrostructureStrategy(ms)
    tick = float(meta.get("tick_size") or DEFAULT_TICK)
    fee_rate = float(meta.get("fee_rate") if pd.notna(meta.get("fee_rate")) else settings.fee_rate)
    fee_rate *= scenario.fee_multiplier
    exponent = meta.get("fee_exponent")
    fee_exponent = float(exponent) if exponent is not None and pd.notna(exponent) else 1.0
    latency = latency_ms * scenario.latency_multiplier / 1000
    end_ts = meta.get("end_ts")
    deadline = (float(end_ts) - settings.rollover_seconds
                if end_ts is not None and pd.notna(end_ts) else math.inf)
    books = {t: OrderBook(t, tick_size=tick) for t in (yes, no)}
    fidelity = "l2" if not l2.empty and set(l2.loc[l2["event_type"] == "book", "token_id"]) >= {yes, no} else "features"
    result = MarketResult(meta["slug"], float(rows["ts"].max()), fidelity, "unresolved")
    held = portfolio.positions

    items = l2_items(l2) if fidelity == "l2" else []
    for ts, group in rows.groupby("ts", sort=True):
        records = group.to_dict("records")
        if fidelity == "features":
            items.append((float(ts), 0, "rows", records))
        items.append((float(ts), 1, "tick", records))
    items.sort(key=lambda item: (item[0], item[1]))

    pending: list[tuple[float, Intent, float | None]] = []

    def execute(intent: Intent, touch: float | None) -> None:
        book = books[intent.token_id]
        filled, price, fee, reject = take(
            book, intent.side, intent.size, intent.limit_price, cash=portfolio.cash,
            held=held.size(intent.token_id), fee_rate=fee_rate, haircut=scenario.fill_haircut,
            shift=scenario.extra_slippage_ticks * book.tick_size, fee_exponent=fee_exponent,
        )
        result.orders += 1
        if reject:
            result.rejected += 1
            return
        result.filled += 1
        result.partial += filled < intent.size - 1e-9
        pnl = held.apply(intent.token_id, intent.side, filled, price, fee, current["ts"])
        portfolio.cash += -(filled * price + fee) if intent.side == "BUY" else filled * price - fee
        result.pnl += pnl
        result.fees += fee
        if intent.side == "BUY":
            result.entries += 1
            if touch is not None:
                result.slippage.append(price - touch)
        else:
            result.exits.append(pnl)

    def run_pending(until: float) -> None:
        while pending and pending[0][0] <= until:
            _, intent, touch = pending.pop(0)
            execute(intent, touch)

    current = {"ts": 0.0}
    closed = False
    for ts, _, kind, payload in items:
        run_pending(ts)
        current["ts"] = ts
        if kind == "book":
            apply_l2(books, payload)
            continue
        if kind == "rows":
            for r in payload:
                if r["token_id"] in books:
                    synthetic_book(books[r["token_id"]], r, books[r["token_id"]].tick_size)
            continue
        if ts >= deadline:
            if not closed:
                closed = True
                for token in (yes, no):
                    bid = books[token].best_bid
                    if held.get(token).open and bid is not None:
                        limit = max(MIN_LIMIT_PRICE, bid - settings.max_slippage)
                        pending.append((ts + latency, Intent(token, "SELL", held.size(token), limit,
                                                             "rollover"), None))
            continue
        if pending:
            continue
        feature_rows = {}
        for r in payload:
            if r["token_id"] in books:
                feature_rows[r["token_id"]] = FeatureRow(**{
                    k: (0.0 if pd.isna(v) else v) for k, v in r.items() if k in ROW_FIELDS})
        if payload and payload[0].get("combine"):
            combine_market(feature_rows, yes, no)
        for intent in strategy.decide(feature_rows, held.positions, ts):
            touch = feature_rows[intent.token_id].best_ask if intent.side == "BUY" else None
            pending.append((ts + latency, intent, touch))

    # Recordings stop at the rollover (the bot moves on), so data ending just before the deadline
    # means the bot closed there; data ending earlier means it stopped and the position settles.
    if not closed and current["ts"] >= deadline - settings.stale_book_seconds:
        for token in (yes, no):
            bid = books[token].best_bid
            if held.get(token).open and bid is not None:
                pending.append((current["ts"] + latency, Intent(
                    token, "SELL", held.size(token), max(MIN_LIMIT_PRICE, bid - settings.max_slippage),
                    "rollover"), None))
    run_pending(math.inf)

    open_tokens = [t for t in (yes, no) if held.get(t).open]
    if truthy(meta.get("resolved")):
        for token, payout in ((yes, meta["payout_yes"]), (no, meta["payout_no"])):
            if held.get(token).open:
                size = held.size(token)
                pnl = held.apply(token, "SELL", size, float(payout), 0.0, result.end_ts)
                portfolio.cash += size * float(payout)
                result.pnl += pnl
                result.exits.append(pnl)
        result.settled_by = "payout"
    elif not open_tokens:
        result.settled_by = "flat"
    else:
        # Unresolved with inventory: excluded from the metrics; drop the position.
        for token in open_tokens:
            held.positions.pop(token, None)
    return result


def replay(features: pd.DataFrame, markets: pd.DataFrame, data_dir: Path | None,
           settings: Settings, scenario: Scenario, latency_ms: float,
           use_l2: bool = True) -> tuple[list[MarketResult], float]:
    """Replay every market in chronological order with a shared portfolio."""
    portfolio = Portfolio(settings.paper_starting_cash)
    results = []
    meta_by_slug = {m["slug"]: m for m in markets.to_dict("records")}
    order = features.groupby("market")["ts"].max().sort_values().index
    for slug in order:
        meta = meta_by_slug.get(slug)
        if not slug or not meta or not meta.get("yes_token_id") or not meta.get("no_token_id"):
            continue
        rows = features[features["market"] == slug]
        l2 = pd.DataFrame()
        if use_l2 and data_dir is not None:
            l2 = read_table(data_dir, "book_events",
                            "WHERE token_id IN (?, ?) AND recv_ts BETWEEN ? AND ?",
                            [meta["yes_token_id"], meta["no_token_id"],
                             float(rows["ts"].min()) - 60, float(rows["ts"].max()) + 60])
        results.append(replay_market(meta, rows, l2, settings, scenario, latency_ms, portfolio))
    return results, portfolio.positions.max_committed


# --- Metrics ------------------------------------------------------------------------------------

def drawdown(pnl: np.ndarray, ends: np.ndarray) -> dict:
    if len(pnl) == 0:
        return {"max": 0.0, "duration_seconds": 0.0, "duration_markets": 0}
    curve = np.cumsum(pnl)
    peak_curve = np.maximum.accumulate(np.concatenate([[0.0], curve]))[1:]
    dd = peak_curve - curve
    worst = int(np.argmax(dd))
    longest_s, longest_n, start = 0.0, 0, None
    for i in range(len(curve)):
        if dd[i] > 1e-12:
            start = i if start is None else start
            longest_n = max(longest_n, i - start + 1)
            longest_s = max(longest_s, float(ends[i] - ends[max(start - 1, 0)]))
        else:
            start = None
    return {"max": float(dd[worst]), "duration_seconds": longest_s, "duration_markets": longest_n}


def summarize(results: list[MarketResult], max_committed: float, bootstrap: int = 1_000,
              seed: int = 0) -> dict:
    included = [r for r in results if r.settled_by != "unresolved"]
    pnl = np.array([r.pnl for r in included])
    ends = np.array([r.end_ts for r in included])
    traded = [r for r in included if r.entries]
    exits = np.array([p for r in included for p in r.exits])
    total = float(pnl.sum()) if len(pnl) else 0.0
    entries = sum(r.entries for r in included)
    gains, losses = pnl[pnl > 0].sum(), -pnl[pnl < 0].sum()
    downside = pnl[pnl < 0]
    orders = sum(r.orders for r in included)
    slippage = [s for r in included for s in r.slippage]
    weekly: dict[str, dict] = {}
    for r in included:
        week = datetime.fromtimestamp(r.end_ts, UTC).strftime("%G-W%V")
        w = weekly.setdefault(week, {"markets": 0, "pnl": 0.0, "fees": 0.0, "entries": 0})
        w["markets"] += 1
        w["pnl"] += r.pnl
        w["fees"] += r.fees
        w["entries"] += r.entries
    top5 = float(np.sort(pnl)[::-1][:5].sum()) if len(pnl) else 0.0
    ci = None
    if len(pnl) >= 2:
        rng = np.random.default_rng(seed)
        samples = pnl[rng.integers(0, len(pnl), (bootstrap, len(pnl)))]
        ci = {"total_pnl": {"low": float(np.quantile(samples.sum(1), 0.025)),
                            "high": float(np.quantile(samples.sum(1), 0.975))},
              "mean_market_pnl": {"low": float(np.quantile(samples.mean(1), 0.025)),
                                  "high": float(np.quantile(samples.mean(1), 0.975))},
              "samples": bootstrap}
    std = float(pnl.std(ddof=1)) if len(pnl) > 1 else 0.0
    downside_std = float(np.sqrt(np.mean(np.minimum(pnl, 0) ** 2))) if len(pnl) else 0.0
    return {
        "markets": {
            "total": len(results), "included": len(included),
            "settled_by_payout": sum(r.settled_by == "payout" for r in results),
            "flat_without_resolution": sum(r.settled_by == "flat" for r in results),
            "excluded_unresolved": sum(r.settled_by == "unresolved" for r in results),
            "traded": len(traded),
            "fidelity": {f: sum(r.fidelity == f for r in included) for f in ("l2", "features")},
        },
        "net_pnl": total,
        "fees": float(sum(r.fees for r in included)),
        "entries": entries,
        "expectancy_per_trade": total / entries if entries else None,
        "expectancy_per_market": float(pnl.mean()) if len(pnl) else None,
        "expectancy_per_traded_market": (float(np.mean([r.pnl for r in traded]))
                                         if traded else None),
        "max_capital_committed": max_committed,
        "roi_on_max_committed": total / max_committed if max_committed else None,
        "sharpe_per_market": float(pnl.mean() / std) if std > 0 else None,
        "sortino_per_market": (float(pnl.mean() / downside_std)
                               if len(downside) and downside_std > 0 else None),
        "profit_factor": float(gains / losses) if losses > 0 else None,
        "win_rate_markets": float(np.mean([r.pnl > 0 for r in traded])) if traded else None,
        "win_rate_trades": float(np.mean(exits > 0)) if len(exits) else None,
        "drawdown": drawdown(pnl, ends),
        "weekly": weekly,
        "concentration": {"top5_pnl": top5,
                          "top5_share_of_net": top5 / total if total else None},
        "execution": {
            "orders": orders,
            "fill_rate": sum(r.filled for r in included) / orders if orders else None,
            "partial_rate": sum(r.partial for r in included) / orders if orders else None,
            "reject_rate": sum(r.rejected for r in included) / orders if orders else None,
            "mean_entry_slippage_vs_touch": float(np.mean(slippage)) if slippage else None,
        },
        "bootstrap": ci,
    }


def paper_pnl_by_market(data_dir: Path) -> dict[str, float]:
    fills = read_table(data_dir, "fills", "WHERE mode = 'paper'")
    if fills.empty or "market" not in fills:
        return {}
    return fills.groupby("market")["pnl"].sum().to_dict()


def degradation(paper: dict[str, float], results: dict[str, list[MarketResult]]) -> dict:
    """Paper PnL against the replay scenarios over the markets they share."""
    by_scenario = {name: {r.market: r.pnl for r in rs if r.settled_by != "unresolved"}
                   for name, rs in results.items()}
    common = set(paper)
    for pnl in by_scenario.values():
        common &= set(pnl)
    if not common:
        return {"markets": 0}
    out = {"markets": len(common), "paper": float(sum(paper[m] for m in common))}
    for name, pnl in by_scenario.items():
        out[name] = float(sum(pnl[m] for m in common))
    if "pessimistic" in out:
        out["paper_minus_pessimistic"] = out["paper"] - out["pessimistic"]
    return out


# --- Entry points -------------------------------------------------------------------------------

def default_settings() -> Settings:
    """Strategy settings from the environment; replays always trade, whatever PM_MODE says."""
    try:
        settings = Settings()
    except ValidationError:
        settings = Settings(yes_token_id="yes", no_token_id="no")
    return settings.model_copy(update={"mode": "paper"})


def evaluate(features: pd.DataFrame, markets: pd.DataFrame, settings: Settings,
             data_dir: Path | None = None, latency_ms: float = 0.0,
             model_path: Path | None = None, scenarios: dict[str, Scenario] = SCENARIOS,
             baselines: tuple[str, ...] = ("recorded", "momentum", "random"),
             bootstrap: int = 1_000, seed: int = 0, use_l2: bool = True) -> dict:
    source = "model" if model_path else "recorded"
    frame = with_signal(features, source, model_path, seed)
    results = {}
    report: dict = {"signal": source, "latency_ms": latency_ms, "scenarios": {}}
    for name, scenario in scenarios.items():
        markets_results, committed = replay(frame, markets, data_dir, settings, scenario,
                                            latency_ms, use_l2)
        results[name] = markets_results
        report["scenarios"][name] = asdict(scenario) | summarize(markets_results, committed,
                                                                 bootstrap, seed)
        report["scenarios"][name]["per_market"] = [
            {"market": r.market, "end_ts": r.end_ts, "pnl": r.pnl, "fees": r.fees, "entries": r.entries,
             "settled_by": r.settled_by, "fidelity": r.fidelity} for r in markets_results]
    report["baselines"] = {}
    for baseline in baselines:
        if baseline == source:
            continue
        base_frame = with_signal(features, baseline, None, seed)
        base_results, committed = replay(base_frame, markets, data_dir, settings,
                                         scenarios.get("base", Scenario()), latency_ms, use_l2)
        summary = summarize(base_results, committed, bootstrap, seed)
        report["baselines"][baseline] = {k: summary[k] for k in (
            "net_pnl", "entries", "expectancy_per_trade", "win_rate_trades", "fees")}
    if data_dir is not None:
        report["paper_vs_replay"] = degradation(paper_pnl_by_market(data_dir), results)
    return report


def walk_forward(features: pd.DataFrame, markets: pd.DataFrame, settings: Settings,
                 data_dir: Path | None, latency_ms: float, folds: int, horizon: float,
                 min_move: float, holdout: float, bootstrap: int, seed: int) -> dict:
    """Retrain on each expanding block of markets and replay the next; the holdout stays untouched."""
    import tempfile

    import joblib

    from .train import fit_model, label_frame, market_keys, market_split, walk_forward_folds

    usable = features.dropna(subset=FEATURE_COLUMNS)
    labelled = label_frame(usable, horizon, min_move)
    dev, _, split = market_split(labelled, horizon, holdout)
    out = {"split": split, "folds": []}
    for i, (train_rows, valid) in enumerate(walk_forward_folds(dev, horizon, folds), 1):
        valid_markets = set(market_keys(valid))
        entry = {"fold": i, "train_markets": int(market_keys(train_rows).nunique()),
                 "valid_markets": len(valid_markets)}
        if train_rows.empty or train_rows["target"].nunique() < 2:
            reason = "no training markets" if train_rows.empty else "single class in training block"
            out["folds"].append(entry | {"error": reason})
            continue
        model = fit_model(train_rows)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "model.joblib"
            joblib.dump({"model": model, "columns": FEATURE_COLUMNS}, path)
            fold_features = features[features["market"].isin(valid_markets)]
            report = evaluate(fold_features, markets, settings, data_dir, latency_ms, path,
                              {k: SCENARIOS[k] for k in ("base", "pessimistic")}, (),
                              bootstrap, seed)
        entry["scenarios"] = {k: {m: v[m] for m in ("net_pnl", "entries", "expectancy_per_trade",
                                                     "roi_on_max_committed")}
                              for k, v in report["scenarios"].items()}
        out["folds"].append(entry)
    nets = [f["scenarios"]["pessimistic"]["net_pnl"] for f in out["folds"] if "scenarios" in f]
    out["pessimistic_positive_folds"] = sum(n > 0 for n in nets)
    out["pessimistic_net_pnl"] = float(sum(nets))
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Replay the strategy with pessimistic fills")
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--model", type=Path, default=None,
                        help="Score features with this model instead of the recorded score")
    parser.add_argument("--latency-ms", type=float, default=None,
                        help="Base latency (default: PM_PAPER_LATENCY_MS or the median measured RTT)")
    parser.add_argument("--fetch-resolutions", action="store_true",
                        help="Look up payouts of unresolved markets in Gamma")
    parser.add_argument("--no-l2", action="store_true", help="Ignore recorded book events")
    parser.add_argument("--walk-forward", action="store_true")
    parser.add_argument("--folds", type=int, default=4)
    parser.add_argument("--horizon-seconds", type=float, default=15.0)
    parser.add_argument("--min-move", type=float, default=0.002)
    parser.add_argument("--holdout-markets", type=float, default=0.2)
    parser.add_argument("--bootstrap", type=int, default=1_000)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--output", type=Path, default=None,
                        help="Report directory (default: <data-dir>/evaluations/<id>)")
    args = parser.parse_args()

    settings = default_settings()
    features = read_table(args.data_dir, "features", "ORDER BY ts")
    if features.empty:
        sys.exit("Error: no features recorded")
    features["market"] = features["market"].fillna("")
    markets = load_markets(args.data_dir, features)
    if args.fetch_resolutions:
        markets = asyncio.run(fetch_resolutions(markets))
    latency = args.latency_ms if args.latency_ms is not None else base_latency_ms(args.data_dir, settings)
    report = evaluate(features, markets, settings, args.data_dir, latency, args.model,
                      bootstrap=args.bootstrap, seed=args.seed, use_l2=not args.no_l2)
    if args.walk_forward:
        report["walk_forward"] = walk_forward(
            features, markets, settings, args.data_dir, latency, args.folds,
            args.horizon_seconds, args.min_move, args.holdout_markets, args.bootstrap, args.seed)
    evaluation_id = datetime.now(UTC).strftime("%Y%m%d-%H%M%S") + "-" + uuid4().hex[:4]
    output = args.output or args.data_dir / "evaluations" / evaluation_id
    output.mkdir(parents=True, exist_ok=True)
    report = {"id": evaluation_id, "created_at": datetime.now(UTC).isoformat(),
              "model": str(args.model) if args.model else None,
              "fee_rate": settings.fee_rate, "rollover_seconds": settings.rollover_seconds} | report
    (output / "report.json").write_text(json.dumps(report, indent=2, default=float))
    for name, s in report["scenarios"].items():
        print(f"{name:12s} net={s['net_pnl']:+.4f} entries={s['entries']} "
              f"markets={s['markets']['included']} (excluded {s['markets']['excluded_unresolved']})")
    print(f"Saved report: {output / 'report.json'}")


if __name__ == "__main__":
    main()
