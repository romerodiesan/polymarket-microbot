"""Read-only MCP server over the bot's Parquet exports, process state and training runs."""

from __future__ import annotations

import argparse
import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from time import time
from typing import Any
from urllib.parse import urlparse

import duckdb
import uvicorn
from mcp.server.auth.handlers.metadata import MetadataHandler
from mcp.server.auth.routes import build_metadata, cors_middleware
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions, RevocationOptions
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse, Response
from starlette.routing import Route

from .mcp_auth import SCOPE, SingleUserOAuthProvider, install_login


def _resolve_data_dir() -> Path:
    if env := os.environ.get("MICROBOT_DATA_DIR"):
        return Path(env).resolve()
    # bot/src/microbot/mcp_server.py -> bot/data (editable installs).
    packaged = Path(__file__).resolve().parents[2] / "data"
    return packaged if packaged.is_dir() else Path("data").resolve()


DATA_DIR = _resolve_data_dir()
PARQUET_DIR = DATA_DIR / "parquet"
STATE_FILE = DATA_DIR / "bot" / "state.json"
TRAINING_DIR = DATA_DIR / "training"
ENV_FILE = DATA_DIR.parent / ".env"
# Only these .env keys are ever exposed; the file also holds wallet keys and API secrets.
PUBLIC_ENV_KEYS = ("PM_MODE", "PM_SERIES_SLUG")
RUN_ID = re.compile(r"^[\w-]+$")

MAX_ROWS = max(10, min(int(os.environ.get("MICROBOT_MCP_MAX_ROWS", "500")), 5000))

READ_ONLY = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)

NAME = "polymarket-microbot-analytics"
INSTRUCTIONS = (
    "Read-only access to Polymarket microbot snapshots, training results and strategy "
    "evaluations. Check data quality, stream health, execution quality, fees, settled P&L "
    "and temporal comparability before recommending algorithm changes. Never claim that a "
    "model is profitable based only on classification metrics; rely on settled P&L and "
    "pessimistic evaluation scenarios over many markets. P&L, execution, equity and "
    "prediction tools cover every tracked bot run by default (rows recorded before run "
    "tracking are excluded and counted in `scope`); pass run_id (see get_capture_status "
    "bot_runs, or \"latest\") to compare runs."
)


def read_json(path: Path, default: Any) -> Any:
    try:
        with path.open() as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def public_env() -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = ENV_FILE.read_text().splitlines()
    except OSError:
        return values
    for line in lines:
        key, sep, value = line.strip().partition("=")
        if sep and key.strip() in PUBLIC_ENV_KEYS:
            values[key.strip()] = value.strip().strip("'\"")
    return values


def pid_alive(pid: Any) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


TABLES = {"features", "fills", "orders", "markets", "equity", "positions", "predictions",
          "stream_events", "runs", "book_events"}


def parquet_files(table: str) -> list[Path]:
    """The bot's single atomic export, plus any per-table snapshot files."""
    if table not in TABLES:
        raise ValueError("Unknown dataset")
    single = PARQUET_DIR / f"{table}.parquet"
    files = [single] if single.is_file() else []
    return files + sorted((PARQUET_DIR / table).glob("*.parquet"))


def parquet_relation(table: str) -> str:
    files = parquet_files(table)
    if not files:
        raise RuntimeError(f"No completed {table} snapshots are available yet")
    paths = ", ".join("'" + f.as_posix().replace("'", "''") + "'" for f in files)
    return f"read_parquet([{paths}], union_by_name=true)"


def optional_relation(table: str) -> str | None:
    """The table's relation, or None when it has no snapshot or no rows yet."""
    if not parquet_files(table):
        return None
    relation = parquet_relation(table)
    return relation if query(f"SELECT count(*) AS n FROM {relation}")[0]["n"] else None


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def latest_run_id() -> str | None:
    runs = optional_relation("runs")
    if runs is None:
        return None
    rows = query(f"SELECT run_id FROM {runs} ORDER BY started_at DESC NULLS LAST LIMIT 1")
    return rows[0]["run_id"] if rows else None


def scoped(table: str, run_id: str | None = None,
           include_legacy: bool = False) -> tuple[str | None, dict[str, Any]]:
    """The table's relation restricted to one bot run (`run_id`, or "latest"), or to every
    tracked run; rows without a run_id predate run tracking (and per-fill fee records) and are
    left out unless `include_legacy`. Returns the relation (None if empty) and the scope used."""
    relation = optional_relation(table)
    scope: dict[str, Any] = {"run_id": run_id, "include_legacy": include_legacy,
                             "legacy_rows_excluded": 0}
    if relation is None or "run_id" not in columns(relation):
        return relation, scope
    if run_id == "latest":
        run_id = latest_run_id()
        scope["run_id"] = run_id
    if run_id:
        condition = f"run_id = {sql_literal(run_id)}"
    elif include_legacy:
        return relation, scope
    else:
        condition = "run_id IS NOT NULL"
        scope["legacy_rows_excluded"] = query(
            f"SELECT count(*) AS n FROM {relation} WHERE run_id IS NULL")[0]["n"]
    return f"(SELECT * FROM {relation} WHERE {condition})", scope


def columns(relation: str) -> set[str]:
    return {row["column_name"] for row in query(f"DESCRIBE SELECT * FROM {relation}")}


def rows_to_dicts(cursor) -> list[dict[str, Any]]:
    columns = [column[0] for column in cursor.description]
    return [
        {col: float(v) if isinstance(v, Decimal) else v for col, v in zip(columns, row, strict=True)}
        for row in cursor.fetchall()
    ]


def query(sql: str, parameters: list[Any] | None = None) -> list[dict[str, Any]]:
    connection = duckdb.connect()
    try:
        return rows_to_dicts(connection.execute(sql, parameters or []))
    finally:
        connection.close()


def clamp_hours(value: float, maximum: float) -> float:
    return max(0.05, min(float(value), maximum))


def load_runs() -> list[dict[str, Any]]:
    """Training runs from data/training/<id>/ (meta.json + metrics.json), oldest first."""
    if not TRAINING_DIR.is_dir():
        return []
    runs = []
    for run_dir in TRAINING_DIR.iterdir():
        meta = read_json(run_dir / "meta.json", None)
        if not RUN_ID.match(run_dir.name) or not isinstance(meta, dict):
            continue
        metrics = read_json(run_dir / "metrics.json", {}) or {}
        report = metrics.get("report") or {}
        runs.append({
            "run_id": meta.get("id", run_dir.name),
            "created_at": meta.get("startedAt"),
            "ended_at": meta.get("endedAt"),
            "status": meta.get("status"),
            "algorithm": "logistic_regression",
            "parameters": {
                **(meta.get("params") or {}),
                "horizon_seconds": metrics.get("horizon_seconds"),
                "embargo_seconds": metrics.get("embargo_seconds"),
                "min_move": metrics.get("min_move"),
            },
            "data": {
                key: metrics.get(key)
                for key in ("rows_total", "rows_usable", "rows_labelled", "train_rows",
                            "test_rows", "positive_rate", "class_counts")
            },
            "metrics": {
                "roc_auc": metrics.get("roc_auc"),
                "accuracy": report.get("accuracy"),
                "high_confidence": metrics.get("high_confidence"),
                "report": report,
            },
            "feature_coefficients": metrics.get("coefficients"),
            "model_path": meta.get("modelPath"),
        })
    return sorted(runs, key=lambda r: r.get("created_at") or 0)


def find_run(run_id: str) -> dict[str, Any] | None:
    if not RUN_ID.match(run_id):
        return None
    return next((run for run in load_runs() if run["run_id"] == run_id), None)


def get_capture_status() -> dict[str, Any]:
    """Get capture health, freshness, row counts and snapshot information."""
    state = read_json(STATE_FILE, {}) or {}
    features = PARQUET_DIR / "features.parquet"
    updated_at = features.stat().st_mtime if features.is_file() else None

    snapshots = {}
    for table in sorted(TABLES):
        files = parquet_files(table)
        rows = None
        if files:
            rows = query(f"SELECT count(*) AS n FROM {parquet_relation(table)}")[0]["n"]
        snapshots[table] = {
            "files": len(files),
            "bytes": sum(file.stat().st_size for file in files),
            "rows": rows,
        }

    runs = optional_relation("runs")
    bot_runs = query(
        f"SELECT run_id, started_at, ended_at, mode, git_commit, version, features_version, "
        f"model_version, fee_rate, starting_cash FROM {runs} "
        "ORDER BY started_at DESC NULLS LAST LIMIT 20"
    ) if runs else []

    pid = state.get("pid")
    return {
        **public_env(),
        "data_dir": str(DATA_DIR),
        "bot_runs": bot_runs,
        "updated_at": updated_at,
        "status_age_seconds": None if updated_at is None else max(0, time() - updated_at),
        "process": {
            "pid": pid,
            "running": pid_alive(pid),
            "started_at": state.get("startedAt"),
            "ended_at": state.get("endedAt"),
            "exit_code": state.get("exitCode"),
            "note": "Only tracks bots started from the dashboard; status_age_seconds "
                    "shows whether any bot is still exporting.",
        },
        "snapshots": snapshots,
        "training_runs": len(load_runs()),
        "read_only": True,
    }


def get_market_summary(lookback_hours: float = 24, token_id: str | None = None) -> dict[str, Any]:
    """Summarize spread, depth and microstructure signals."""
    lookback_hours = clamp_hours(lookback_hours, 24 * 31)
    where = "ts >= ?"
    parameters: list[Any] = [time() - lookback_hours * 3600]
    if token_id:
        where += " AND token_id = ?"
        parameters.append(token_id)

    rows = query(
        f"""
        SELECT
            token_id,
            any_value(market) AS market,
            any_value(outcome) AS outcome,
            count(*) AS samples,
            min(ts) AS first_ts,
            max(ts) AS last_ts,
            avg(midpoint) AS avg_midpoint,
            min(midpoint) AS min_midpoint,
            max(midpoint) AS max_midpoint,
            avg(spread) AS avg_spread,
            quantile_cont(spread, 0.95) AS p95_spread,
            avg(bid_depth_3) AS avg_bid_depth,
            avg(ask_depth_3) AS avg_ask_depth,
            avg(abs(book_imbalance)) AS avg_abs_book_imbalance,
            avg(abs(flow_imbalance)) AS avg_abs_flow_imbalance,
            avg(abs(trade_pressure)) AS avg_abs_trade_pressure,
            avg(abs(score)) AS avg_abs_score
        FROM {parquet_relation("features")}
        WHERE {where}
        GROUP BY token_id
        ORDER BY last_ts DESC
        """,
        parameters,
    )
    return {"lookback_hours": lookback_hours, "tokens": rows}


def get_recent_features(token_id: str | None = None, limit: int = 100) -> dict[str, Any]:
    """Return recent microstructure observations."""
    limit = max(1, min(int(limit), MAX_ROWS))
    where = ""
    parameters: list[Any] = []
    if token_id:
        where = "WHERE token_id = ?"
        parameters.append(token_id)

    rows = query(
        f"""
        SELECT *
        FROM {parquet_relation("features")}
        {where}
        ORDER BY ts DESC
        LIMIT {limit}
        """,
        parameters,
    )
    return {"count": len(rows), "limit": limit, "rows": rows}


def get_data_quality(lookback_hours: float = 24) -> dict[str, Any]:
    """Measure sampling intervals, gaps and duplicate timestamps."""
    lookback_hours = clamp_hours(lookback_hours, 24 * 31)
    rows = query(
        f"""
        WITH ordered AS (
            SELECT
                token_id,
                ts,
                ts - lag(ts) OVER (PARTITION BY token_id ORDER BY ts) AS gap
            FROM {parquet_relation("features")}
            WHERE ts >= ?
        )
        SELECT
            token_id,
            count(*) AS samples,
            count(DISTINCT ts) AS distinct_timestamps,
            avg(gap) AS avg_gap_seconds,
            quantile_cont(gap, 0.95) AS p95_gap_seconds,
            max(gap) AS max_gap_seconds,
            sum(CASE WHEN gap > 5 THEN 1 ELSE 0 END) AS gaps_over_5_seconds
        FROM ordered
        GROUP BY token_id
        ORDER BY token_id
        """,
        [time() - lookback_hours * 3600],
    )
    return {"lookback_hours": lookback_hours, "tokens": rows}


def payouts_sql() -> str:
    """token_id -> payout (0/1) for every resolved market, or an empty relation."""
    markets = optional_relation("markets")
    if markets is None or "payout_yes" not in columns(markets):
        return "SELECT NULL::VARCHAR AS token_id, NULL::DOUBLE AS payout WHERE false"
    return f"""
        SELECT yes_token_id AS token_id, payout_yes AS payout FROM {markets} WHERE resolved
        UNION ALL
        SELECT no_token_id AS token_id, payout_no AS payout FROM {markets} WHERE resolved
    """


def get_paper_performance(lookback_hours: float = 168, run_id: str | None = None,
                          include_legacy: bool = False) -> dict[str, Any]:
    """Paper P&L split into settled (resolved markets at their 0/1 payout) and marked (pending
    markets at the latest midpoint), with fees, their source and ROI on committed capital.
    `run_id` limits it to one bot run ("latest" for the last); fills recorded before run
    tracking are excluded unless `include_legacy`."""
    lookback_hours = clamp_hours(lookback_hours, 24 * 365)
    empty_totals = {"fills": 0, "fees": 0.0, "realized_pnl": 0.0, "settled_pnl": 0.0,
                    "marked_pnl": 0.0, "net_pnl": 0.0}
    fills, scope = scoped("fills", run_id, include_legacy)
    if fills is None:
        return {"lookback_hours": lookback_hours, "scope": scope, "tokens": [], "reasons": [],
                "totals": empty_totals}

    cutoff = time() - lookback_hours * 3600
    features = parquet_relation("features") if parquet_files("features") else None
    marks = (
        f"SELECT token_id, arg_max(midpoint, ts) AS mark_price, max(ts) AS mark_ts "
        f"FROM {features} GROUP BY token_id"
        if features
        else "SELECT NULL::VARCHAR AS token_id, NULL::DOUBLE AS mark_price, NULL::DOUBLE AS mark_ts"
    )
    rows = query(
        f"""
        WITH selected_fills AS (
            SELECT * FROM {fills} WHERE ts >= ? AND mode = 'paper'
        ),
        positions AS (
            SELECT
                token_id,
                any_value(market) AS market,
                any_value(outcome) AS outcome,
                count(*) AS fills,
                sum(CASE WHEN side = 'BUY' THEN size ELSE -size END) AS position,
                sum(CASE WHEN side = 'SELL' THEN size * price ELSE -size * price END) AS cash_flow,
                sum(fee) AS fees,
                sum(coalesce(pnl, 0)) AS realized_pnl,
                min(ts) AS first_fill_ts,
                max(ts) AS last_fill_ts
            FROM selected_fills
            GROUP BY token_id
        ),
        marks AS ({marks}),
        payouts AS ({payouts_sql()})
        SELECT
            positions.*,
            marks.mark_price,
            marks.mark_ts,
            payouts.payout,
            CASE WHEN payouts.payout IS NULL THEN 'midpoint' ELSE 'payout' END AS valuation,
            cash_flow - fees + position * coalesce(payouts.payout, mark_price, 0) AS marked_pnl
        FROM positions
        LEFT JOIN marks USING (token_id)
        LEFT JOIN payouts USING (token_id)
        ORDER BY first_fill_ts
        """,
        [cutoff],
    )
    fee_sources = []
    if "fee_source" in columns(fills):
        fee_sources = query(
            f"""
            SELECT coalesce(fee_source, 'unknown') AS fee_source, count(*) AS fills,
                   sum(fee) AS fees, avg(fee_rate) AS avg_fee_rate
            FROM {fills} WHERE ts >= ? AND mode = 'paper'
            GROUP BY 1 ORDER BY fills DESC
            """,
            [cutoff],
        )
    equity, _ = scoped("equity", scope["run_id"], include_legacy)
    committed = (
        query(f"SELECT max(max_simultaneous_exposure) AS c FROM {equity} WHERE ts >= ?",
              [cutoff])[0]["c"]
        if equity else None
    )
    reasons = query(
        f"""
        SELECT reason, count(*) AS fills, sum(coalesce(pnl, 0)) AS realized_pnl
        FROM {fills}
        WHERE ts >= ? AND mode = 'paper'
        GROUP BY reason
        ORDER BY fills DESC
        """,
        [cutoff],
    )
    settled = sum(float(r["marked_pnl"] or 0) for r in rows if r["valuation"] == "payout")
    marked = sum(float(r["marked_pnl"] or 0) for r in rows if r["valuation"] == "midpoint")
    return {
        "lookback_hours": lookback_hours,
        "scope": scope,
        "tokens": rows,
        "reasons": reasons,
        "fee_sources": fee_sources,
        "totals": {
            "fills": sum(int(row.get("fills") or 0) for row in rows),
            "fees": sum(float(row.get("fees") or 0) for row in rows),
            "realized_pnl": sum(float(row.get("realized_pnl") or 0) for row in rows),
            "settled_pnl": settled,
            "marked_pnl": marked,
            "net_pnl": settled + marked,
            "max_capital_committed": committed,
            "roi_on_max_committed": (settled + marked) / committed if committed else None,
        },
        "methodology": (
            "Per token: cash flow minus fees plus the open position valued at the official 0/1 "
            "payout when its market is resolved (settled_pnl) or at its latest midpoint "
            "otherwise (marked_pnl, provisional). realized_pnl sums fills.pnl as recorded. "
            "ROI uses the peak cost basis held at once (equity.max_simultaneous_exposure)."
        ),
    }


def unavailable(table: str) -> dict[str, Any]:
    return {"available": False,
            "note": f"No {table} recorded yet; they are written by bots started after this upgrade."}


def get_execution_quality(lookback_hours: float = 168, run_id: str | None = None,
                          include_legacy: bool = False) -> dict[str, Any]:
    """Fill rate, partial fills, rejections, slippage, latency and fees by market, reason and
    fee source. `run_id` limits it to one bot run ("latest" for the last)."""
    lookback_hours = clamp_hours(lookback_hours, 24 * 365)
    orders, scope = scoped("orders", run_id, include_legacy)
    if orders is None:
        return unavailable("orders")
    cutoff = time() - lookback_hours * 3600
    aggregate = """
        count(*) AS orders,
        sum(CASE WHEN status = 'filled' THEN 1 ELSE 0 END) AS filled,
        sum(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
        sum(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        avg(CASE WHEN status <> 'rejected' THEN 1.0 ELSE 0.0 END) AS fill_rate,
        sum(filled_size) / nullif(sum(requested_size), 0) AS size_fill_ratio,
        avg(slippage_vs_mid) AS avg_slippage_vs_mid,
        avg(slippage_vs_touch) AS avg_slippage_vs_touch,
        quantile_cont(slippage_vs_touch, 0.95) AS p95_slippage_vs_touch,
        avg(latency_ms) AS avg_latency_ms,
        quantile_cont(latency_ms, 0.95) AS p95_latency_ms,
        avg((ack_ts - signal_ts) * 1000) AS avg_signal_to_ack_ms,
        sum(fee) AS fees
    """
    selected = f"SELECT *, split_part(reason, ' ', 1) AS reason_kind FROM {orders} WHERE submit_ts >= ?"
    return {
        "lookback_hours": lookback_hours,
        "scope": scope,
        "totals": query(f"SELECT {aggregate} FROM ({selected})", [cutoff])[0],
        "by_fee_source": query(
            f"SELECT coalesce(fee_source, 'unknown') AS fee_source, count(*) AS orders, "
            "sum(fee) AS fees, avg(fee_rate) AS avg_fee_rate "
            f"FROM ({selected}) WHERE filled_size > 0 GROUP BY 1 ORDER BY 2 DESC", [cutoff]),
        "by_reason": query(
            f"SELECT mode, side, reason_kind, {aggregate} FROM ({selected}) "
            "GROUP BY ALL ORDER BY orders DESC", [cutoff]),
        "by_market": query(
            f"SELECT market, {aggregate} FROM ({selected}) GROUP BY market "
            f"ORDER BY max(submit_ts) DESC LIMIT {MAX_ROWS}", [cutoff]),
        "reject_reasons": query(
            f"SELECT reject_reason, count(*) AS orders FROM ({selected}) "
            "WHERE status = 'rejected' GROUP BY 1 ORDER BY 2 DESC", [cutoff]),
        "note": "Taker FAK orders only: queue_ahead/queue_time_ms are null by design. "
                "fee_source 'venue:…' = fee from the trades the CLOB matched (each at its own "
                "price, 0 where the venue applied 0 bps); '…:estimated' = trades unreadable, "
                "computed on the average price; paper fills use the market's fee schedule.",
    }


def get_market_resolutions(limit: int = 50, run_id: str | None = None,
                           include_legacy: bool = False) -> dict[str, Any]:
    """Official resolutions (0/1 payouts), BTC start/end prices and the bot's P&L per market.
    `run_id` limits the P&L to one bot run ("latest" for the last)."""
    limit = max(1, min(int(limit), MAX_ROWS))
    markets = optional_relation("markets")
    if markets is None:
        return unavailable("markets")
    fills, scope = scoped("fills", run_id, include_legacy)
    pnl = (f"SELECT market AS slug, sum(coalesce(pnl, 0)) AS pnl, sum(fee) AS fees, "
           f"count(*) AS fills FROM {fills} WHERE mode = 'paper' GROUP BY market"
           if fills else "SELECT NULL::VARCHAR AS slug, 0.0 AS pnl, 0.0 AS fees, 0 AS fills WHERE false")
    rows = query(
        f"""
        SELECT m.slug, m.question, m.start_ts, m.end_ts, m.resolved, m.winner, m.payout_yes,
               m.payout_no, m.resolved_ts, m.btc_open, m.btc_close, m.btc_source,
               m.tick_size, m.min_order_size, m.fee_rate, m.fee_source, m.resolution_source,
               p.pnl, p.fees, p.fills
        FROM {markets} m LEFT JOIN ({pnl}) p USING (slug)
        ORDER BY m.end_ts DESC NULLS LAST
        LIMIT {limit}
        """
    )
    summary = query(
        f"""
        SELECT count(*) AS markets,
               sum(CASE WHEN resolved THEN 1 ELSE 0 END) AS resolved,
               sum(CASE WHEN resolved THEN 0 ELSE 1 END) AS pending,
               avg(CASE WHEN resolved THEN CASE WHEN winner = 'YES' THEN 1.0 ELSE 0.0 END END)
                   AS yes_share
        FROM {markets}
        """
    )[0]
    return {"scope": scope, "summary": summary, "markets": rows}


def get_equity_and_risk(lookback_hours: float = 168, points: int = 200,
                        run_id: str | None = None) -> dict[str, Any]:
    """Equity curve (subsampled), drawdown, exposure, max capital committed at once and open
    positions. `run_id` limits it to one bot run ("latest" for the last)."""
    lookback_hours = clamp_hours(lookback_hours, 24 * 365)
    points = max(10, min(int(points), MAX_ROWS))
    equity, scope = scoped("equity", run_id)
    if equity is None:
        return unavailable("equity snapshots")
    cutoff = time() - lookback_hours * 3600
    curve = query(
        f"""
        WITH e AS (
            SELECT *, row_number() OVER (ORDER BY ts) AS n, count(*) OVER () AS total
            FROM {equity} WHERE ts >= ?
        )
        SELECT ts, run_id, cash, equity, realized_pnl, unrealized_pnl, fees_paid, drawdown,
               gross_exposure, locked_in_orders, open_positions
        FROM e WHERE (n - 1) % greatest(1, total // ?) = 0 OR n = total
        ORDER BY ts
        """,
        [cutoff, points],
    )
    stats = query(
        f"""
        SELECT count(*) AS snapshots, max(drawdown) AS max_drawdown,
               max(gross_exposure) AS max_gross_exposure,
               max(max_market_exposure) AS max_market_exposure,
               max(max_simultaneous_exposure) AS max_capital_committed,
               max(locked_in_orders) AS max_locked_in_orders,
               arg_max(equity, ts) AS latest_equity, arg_max(starting_cash, ts) AS starting_cash
        FROM {equity} WHERE ts >= ?
        """,
        [cutoff],
    )[0]
    positions, _ = scoped("positions", scope["run_id"])
    open_positions = (
        query(f"SELECT * FROM {positions} WHERE ts = (SELECT max(ts) FROM {positions})")
        if positions else []
    )
    return {"lookback_hours": lookback_hours, "scope": scope, "stats": stats, "curve": curve,
            "latest_positions": open_positions,
            "note": "equity = cash + positions at midpoint; drawdown is from the running peak "
                    "within each bot run (snapshots restart with each run_id)."}


def get_prediction_calibration(horizon_seconds: float = 15, lookback_hours: float = 168,
                               bins: int = 10, run_id: str | None = None) -> dict[str, Any]:
    """Reliability of logged predictions against the midpoint `horizon_seconds` later, by
    decision, plus how often entered tokens resolved to 1. `run_id` limits it to one bot run
    ("latest" for the last)."""
    lookback_hours = clamp_hours(lookback_hours, 24 * 365)
    horizon_seconds = max(1.0, min(float(horizon_seconds), 3600.0))
    bins = max(2, min(int(bins), 20))
    predictions, scope = scoped("predictions", run_id)
    if predictions is None or not parquet_files("features"):
        return unavailable("predictions")
    features = parquet_relation("features")
    cutoff = time() - lookback_hours * 3600
    labelled = f"""
        WITH p AS (
            SELECT *, CASE WHEN outcome = 'NO' THEN -signal ELSE signal END AS token_signal
            FROM {predictions} WHERE ts >= ?
        ),
        now_mid AS (
            SELECT p.*, f.midpoint AS mid_now
            FROM p ASOF JOIN {features} f ON p.token_id = f.token_id AND p.ts >= f.ts
        ),
        later AS (
            SELECT n.*, f.midpoint AS mid_later, f.ts AS later_ts
            FROM (SELECT *, ts + {horizon_seconds} AS target_ts FROM now_mid) n
            ASOF JOIN {features} f ON n.token_id = f.token_id AND f.ts >= n.target_ts
        )
        SELECT *,
               coalesce(probability, (token_signal + 1) / 2) AS p_up,
               CASE WHEN mid_later > mid_now THEN 1.0 ELSE 0.0 END AS went_up
        FROM later
        WHERE later_ts - target_ts <= {horizon_seconds} AND mid_later <> mid_now
    """
    reliability = query(
        f"""
        SELECT least(floor(p_up * {bins}), {bins - 1}) / {bins} AS bin_low,
               count(*) AS predictions, avg(p_up) AS mean_probability, avg(went_up) AS observed_rate
        FROM ({labelled}) GROUP BY 1 ORDER BY 1
        """,
        [cutoff],
    )
    total = sum(r["predictions"] for r in reliability)
    ece = sum(r["predictions"] / total * abs(r["mean_probability"] - r["observed_rate"])
              for r in reliability) if total else None
    by_decision = query(
        f"""
        SELECT decision, count(*) AS predictions, avg(p_up) AS mean_probability,
               avg(went_up) AS observed_rate, avg((p_up - went_up) ^ 2) AS brier,
               any_value(model_version) AS model_version
        FROM ({labelled}) GROUP BY decision ORDER BY predictions DESC
        """,
        [cutoff],
    )
    resolution = []
    markets = optional_relation("markets")
    if markets is not None and "payout_yes" in columns(markets):
        resolution = query(
            f"""
            WITH payouts AS ({payouts_sql()})
            SELECT p.decision, count(*) AS predictions, avg(payouts.payout) AS won_share,
                   avg(coalesce(p.probability, (CASE WHEN p.outcome = 'NO' THEN -p.signal
                       ELSE p.signal END + 1) / 2)) AS mean_probability
            FROM {predictions} p JOIN payouts USING (token_id)
            WHERE p.ts >= ? AND p.decision IN ('enter', 'exit')
            GROUP BY p.decision
            """,
            [cutoff],
        )
    return {
        "horizon_seconds": horizon_seconds,
        "scope": scope,
        "labelled_predictions": total,
        "brier": (sum(r["brier"] * r["predictions"] for r in by_decision) / total) if total else None,
        "ece": ece,
        "reliability": reliability,
        "by_decision": by_decision,
        "final_resolution": resolution,
        "note": "p_up is the model probability, or (signal + 1) / 2 from the token's side for the "
                "heuristic score. Rows whose midpoint did not change are excluded.",
    }


def get_stream_health(lookback_hours: float = 24) -> dict[str, Any]:
    """WebSocket connects/disconnects, gaps, resyncs, stale books and REST round-trip times."""
    lookback_hours = clamp_hours(lookback_hours, 24 * 31)
    events = optional_relation("stream_events")
    if events is None:
        return unavailable("stream events")
    cutoff = time() - lookback_hours * 3600
    kinds = query(
        f"""
        SELECT kind, count(*) AS events, avg(value) AS avg_value,
               quantile_cont(value, 0.5) AS p50_value, quantile_cont(value, 0.95) AS p95_value,
               max(value) AS max_value
        FROM {events} WHERE ts >= ? GROUP BY kind ORDER BY events DESC
        """,
        [cutoff],
    )
    disconnects = query(
        f"SELECT detail, count(*) AS events FROM {events} WHERE ts >= ? AND kind = 'disconnect' "
        "GROUP BY detail ORDER BY events DESC LIMIT 20",
        [cutoff],
    )
    in_gap = None
    if parquet_files("features"):
        features = parquet_relation("features")
        if "in_gap" in columns(features):
            in_gap = query(
                f"SELECT avg(CASE WHEN in_gap THEN 1.0 ELSE 0.0 END) AS share, "
                f"count(in_gap) AS rows FROM {features} WHERE ts >= ?",
                [cutoff],
            )[0]
    return {
        "lookback_hours": lookback_hours,
        "kinds": kinds,
        "disconnect_reasons": disconnects,
        "features_in_gap": in_gap,
        "units": {"rtt": "ms", "gap": "seconds without events", "resync": "seconds to snapshot",
                  "stale_book": "book age in seconds"},
    }


def get_cost_config() -> dict[str, Any]:
    """Fee model and paper execution settings of the latest run, and fees per market."""
    runs = optional_relation("runs")
    latest = query(f"SELECT * FROM {runs} ORDER BY started_at DESC LIMIT 1")[0] if runs else None
    settings = json.loads(latest.get("settings_json") or "{}") if latest else {}
    keys = ("fee_rate", "paper_latency_ms", "paper_extra_slippage_ticks", "paper_fill_haircut",
            "paper_starting_cash", "max_slippage", "order_size_shares", "max_position_shares",
            "rollover_seconds", "mode")
    markets = optional_relation("markets")
    per_market = (
        query(f"SELECT slug, tick_size, min_order_size, fee_rate, fee_rate_bps, fee_source "
              f"FROM {markets} ORDER BY end_ts DESC NULLS LAST LIMIT 20")
        if markets else []
    )
    return {
        "fee_formula": "fee = shares * fee_rate * (p * (1 - p)) ** exponent, rounded to 5 "
                       "decimals; takers only (docs.polymarket.com/trading/fees)",
        "run": {k: latest.get(k) for k in ("run_id", "started_at", "mode", "git_commit",
                                            "features_version", "model_version")} if latest else None,
        "settings": {k: settings.get(k) for k in keys},
        "markets": per_market,
    }


EVALUATIONS_DIR = DATA_DIR / "evaluations"
SUMMARY_KEYS = ("net_pnl", "fees", "entries", "expectancy_per_trade", "expectancy_per_market",
                "roi_on_max_committed", "sharpe_per_market", "profit_factor", "win_rate_markets",
                "markets")


def load_evaluation(evaluation_id: str) -> dict[str, Any] | None:
    if not RUN_ID.match(evaluation_id):
        return None
    report = read_json(EVALUATIONS_DIR / evaluation_id / "report.json", None)
    return report if isinstance(report, dict) else None


def evaluation_summary(evaluation_id: str, report: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": evaluation_id,
        "created_at": report.get("created_at"),
        "model": report.get("model"),
        "signal": report.get("signal"),
        "latency_ms": report.get("latency_ms"),
        "scenarios": {name: {k: s.get(k) for k in SUMMARY_KEYS}
                      for name, s in (report.get("scenarios") or {}).items()},
    }


def list_evaluations(limit: int = 20) -> dict[str, Any]:
    """Strategy replays from microbot-evaluate, newest first, with scenario summaries."""
    limit = max(1, min(int(limit), 100))
    if not EVALUATIONS_DIR.is_dir():
        return {"count": 0, "evaluations": []}
    found = []
    for path in EVALUATIONS_DIR.iterdir():
        report = load_evaluation(path.name)
        if report is not None:
            found.append(evaluation_summary(path.name, report))
    found.sort(key=lambda e: e.get("created_at") or "", reverse=True)
    return {"count": len(found[:limit]), "evaluations": found[:limit]}


def get_evaluation(evaluation_id: str, include_markets: bool = False) -> dict[str, Any]:
    """Full report of one evaluation; per-market rows only when `include_markets` is true."""
    report = load_evaluation(evaluation_id)
    if report is None:
        return {"error": f"Evaluation not found: {evaluation_id}"}
    if not include_markets:
        report = report | {"scenarios": {
            name: {k: v for k, v in s.items() if k != "per_market"}
            for name, s in (report.get("scenarios") or {}).items()}}
    return report


def compare_evaluations(evaluation_ids: list[str]) -> dict[str, Any]:
    """Compare scenario summaries of explicitly selected evaluations."""
    if not 2 <= len(evaluation_ids) <= 10:
        return {"error": "Provide between 2 and 10 evaluation IDs"}
    selected = []
    for evaluation_id in evaluation_ids:
        report = load_evaluation(evaluation_id)
        if report is None:
            return {"error": f"Evaluation not found: {evaluation_id}"}
        selected.append(evaluation_summary(evaluation_id, report)
                        | {"baselines": report.get("baselines"),
                           "paper_vs_replay": report.get("paper_vs_replay")})
    return {"evaluations": selected,
            "warning": "Compare only evaluations over the same markets and cost settings."}


def list_training_runs(limit: int = 20) -> dict[str, Any]:
    """List registered model-training results, newest first."""
    limit = max(1, min(int(limit), 100))
    runs = list(reversed(load_runs()))[:limit]
    return {"count": len(runs), "runs": runs}


def get_training_run(run_id: str) -> dict[str, Any]:
    """Get complete results for one training run."""
    run = find_run(run_id)
    return run if run else {"error": f"Training run not found: {run_id}"}


def compare_training_runs(run_ids: list[str]) -> dict[str, Any]:
    """Compare explicitly selected training runs."""
    if not 2 <= len(run_ids) <= 10:
        return {"error": "Provide between 2 and 10 run IDs"}

    indexed = {run["run_id"]: run for run in load_runs()}
    selected = []
    for run_id in run_ids:
        run = indexed.get(run_id) if RUN_ID.match(run_id) else None
        if not run:
            return {"error": f"Training run not found: {run_id}"}
        selected.append({
            key: run.get(key)
            for key in ("run_id", "created_at", "algorithm", "parameters", "data", "metrics",
                        "feature_coefficients")
        })

    return {
        "runs": selected,
        "warning": "Compare only runs with compatible labels, horizons and temporal test periods.",
    }


TOOLS = (
    get_capture_status,
    get_market_summary,
    get_recent_features,
    get_data_quality,
    get_paper_performance,
    list_training_runs,
    get_training_run,
    compare_training_runs,
    get_execution_quality,
    get_market_resolutions,
    get_equity_and_risk,
    get_prediction_calibration,
    get_stream_health,
    get_cost_config,
    list_evaluations,
    get_evaluation,
    compare_evaluations,
)

MIN_PASSWORD_LENGTH = 16


@dataclass(frozen=True)
class HttpConfig:
    public_url: str
    password: str
    host: str = "127.0.0.1"
    port: int = 8765

    @classmethod
    def from_env(cls, environ: Mapping[str, str] = os.environ) -> HttpConfig:
        public_url = environ.get("MICROBOT_MCP_PUBLIC_URL", "").strip().rstrip("/")
        parsed = urlparse(public_url)
        if parsed.scheme != "https" or not parsed.netloc or parsed.path:
            raise ValueError(
                "MICROBOT_MCP_PUBLIC_URL must be the public https origin, e.g. https://mcp.example.com"
            )
        password = environ.get("MICROBOT_MCP_PASSWORD", "")
        if len(password) < MIN_PASSWORD_LENGTH:
            raise ValueError(
                f"MICROBOT_MCP_PASSWORD must have at least {MIN_PASSWORD_LENGTH} characters"
            )
        return cls(
            public_url=public_url,
            password=password,
            host=environ.get("MICROBOT_MCP_HOST", "127.0.0.1"),
            port=int(environ.get("MICROBOT_MCP_PORT", "8765")),
        )


def create_server(http: HttpConfig | None = None, state_file: Path | None = None) -> FastMCP:
    """stdio when `http` is None; otherwise Streamable HTTP behind the built-in OAuth server."""
    if http is None:
        server = FastMCP(NAME, instructions=INSTRUCTIONS)
    else:
        provider = SingleUserOAuthProvider(
            http.public_url, http.password, state_file or DATA_DIR / "mcp" / "oauth.json"
        )
        server = FastMCP(
            NAME,
            instructions=INSTRUCTIONS,
            host=http.host,
            port=http.port,
            auth_server_provider=provider,
            auth=AuthSettings(
                issuer_url=http.public_url,
                resource_server_url=f"{http.public_url}/mcp",
                client_registration_options=ClientRegistrationOptions(
                    enabled=True, valid_scopes=[SCOPE], default_scopes=[SCOPE]
                ),
                revocation_options=RevocationOptions(enabled=True),
                required_scopes=[SCOPE],
                validate_token_resource=False,
            ),
            transport_security=TransportSecuritySettings(
                allowed_hosts=[urlparse(http.public_url).netloc, "127.0.0.1:*", "localhost:*"],
                allowed_origins=[http.public_url, "https://chatgpt.com", "https://chat.openai.com"],
            ),
        )
        install_login(server, provider)

        @server.custom_route("/healthz", methods=["GET"])
        async def healthz(_: Request) -> Response:
            return PlainTextResponse("ok")

    for tool in TOOLS:
        server.add_tool(tool, annotations=READ_ONLY, structured_output=True)
    return server


def http_app(server: FastMCP) -> Starlette:
    """The Streamable HTTP app, advertising public PKCE clients (ChatGPT registers with `none`).

    The SDK accepts `token_endpoint_auth_method: none` at /register and /token but leaves it out of
    its metadata, so clients that require it never register; this route takes precedence.
    """
    app = server.streamable_http_app()
    auth = server.settings.auth
    if auth and auth.client_registration_options and auth.revocation_options:
        metadata = build_metadata(
            auth.issuer_url,
            auth.service_documentation_url,
            auth.client_registration_options,
            auth.revocation_options,
        )
        metadata.token_endpoint_auth_methods_supported = [
            "none",
            "client_secret_post",
            "client_secret_basic",
        ]
        app.router.routes.insert(
            0,
            Route(
                "/.well-known/oauth-authorization-server",
                endpoint=cors_middleware(MetadataHandler(metadata).handle, ["GET", "OPTIONS"]),
                methods=["GET", "OPTIONS"],
            ),
        )
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--http",
        action="store_true",
        help="Serve Streamable HTTP with OAuth (MICROBOT_MCP_PUBLIC_URL, MICROBOT_MCP_PASSWORD).",
    )
    args = parser.parse_args()
    if not args.http:
        create_server().run(transport="stdio")
        return
    try:
        config = HttpConfig.from_env()
    except ValueError as exc:
        parser.exit(2, f"microbot-mcp: {exc}\n")
    uvicorn.run(http_app(create_server(config)), host=config.host, port=config.port)


if __name__ == "__main__":
    main()
