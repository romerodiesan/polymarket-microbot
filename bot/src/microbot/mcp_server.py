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
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions, RevocationOptions
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from starlette.requests import Request
from starlette.responses import PlainTextResponse, Response

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
    "Read-only access to Polymarket microbot snapshots and training results. "
    "Check data quality, spread, fees, P&L and temporal comparability before "
    "recommending algorithm changes. Never claim that a model is profitable "
    "based only on classification metrics."
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


def parquet_files(table: str) -> list[Path]:
    """The bot's single atomic export, plus any per-table snapshot files."""
    if table not in {"features", "fills"}:
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
    for table in ("features", "fills"):
        files = parquet_files(table)
        rows = None
        if files:
            rows = query(f"SELECT count(*) AS n FROM {parquet_relation(table)}")[0]["n"]
        snapshots[table] = {
            "files": len(files),
            "bytes": sum(file.stat().st_size for file in files),
            "rows": rows,
        }

    pid = state.get("pid")
    return {
        **public_env(),
        "data_dir": str(DATA_DIR),
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


def get_paper_performance(lookback_hours: float = 168) -> dict[str, Any]:
    """Calculate paper fills, positions, fees, realized and marked P&L."""
    lookback_hours = clamp_hours(lookback_hours, 24 * 365)
    empty_totals = {"fills": 0, "fees": 0.0, "realized_pnl": 0.0, "marked_pnl": 0.0}
    if not parquet_files("fills"):
        return {"lookback_hours": lookback_hours, "tokens": [], "reasons": [], "totals": empty_totals}

    cutoff = time() - lookback_hours * 3600
    fills = parquet_relation("fills")
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
        marks AS ({marks})
        SELECT
            positions.*,
            marks.mark_price,
            marks.mark_ts,
            cash_flow - fees + position * coalesce(mark_price, 0) AS marked_pnl
        FROM positions
        LEFT JOIN marks USING (token_id)
        ORDER BY first_fill_ts
        """,
        [cutoff],
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
    return {
        "lookback_hours": lookback_hours,
        "tokens": rows,
        "reasons": reasons,
        "totals": {
            "fills": sum(int(row.get("fills") or 0) for row in rows),
            "fees": sum(float(row.get("fees") or 0) for row in rows),
            "realized_pnl": sum(float(row.get("realized_pnl") or 0) for row in rows),
            "marked_pnl": sum(float(row.get("marked_pnl") or 0) for row in rows),
        },
        "methodology": (
            "marked_pnl = cash flow minus fees plus the open position marked at the token's "
            "latest midpoint; tokens of closed markets keep their last recorded midpoint, "
            "not the settlement price. realized_pnl sums fills.pnl as recorded by the broker."
        ),
    }


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
    create_server(config).run(transport="streamable-http")


if __name__ == "__main__":
    main()
