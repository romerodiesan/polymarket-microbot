import os
import re
import time
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

import duckdb
import pandas as pd

D, V, B, I = "DOUBLE", "VARCHAR", "BOOLEAN", "BIGINT"

SCHEMAS: dict[str, list[tuple[str, str]]] = {
    "features": [
        ("ts", D), ("token_id", V), ("best_bid", D), ("best_ask", D),
        ("midpoint", D), ("spread", D), ("bid_depth_3", D),
        ("ask_depth_3", D), ("book_imbalance", D), ("microprice", D),
        ("microprice_delta", D), ("flow_imbalance", D), ("trade_pressure", D),
        ("score", D), ("weighted_imbalance", D), ("ofi", D),
        ("volatility", D), ("spread_ticks", D), ("top_bid_size", D),
        ("top_ask_size", D), ("trade_volume", D), ("market", V),
        ("outcome", V), ("in_gap", B), ("run_id", V),
    ],
    "fills": [
        ("ts", D), ("token_id", V), ("side", V), ("size", D),
        ("price", D), ("fee", D), ("order_id", V), ("mode", V),
        ("reason", V), ("pnl", D), ("market", V), ("outcome", V),
        ("liquidity", V), ("fee_rate", D), ("fee_source", V), ("run_id", V),
    ],
    "runs": [
        ("run_id", V), ("started_at", D), ("ended_at", D), ("mode", V), ("git_commit", V),
        ("version", V), ("settings_json", V), ("features_version", V), ("model_version", V),
        ("fee_rate", D), ("starting_cash", D),
    ],
    "markets": [
        ("slug", V), ("condition_id", V), ("question", V), ("yes_token_id", V),
        ("no_token_id", V), ("start_ts", D), ("end_ts", D), ("tick_size", D),
        ("min_order_size", D), ("fee_rate_bps", D), ("fee_rate", D), ("fee_exponent", D),
        ("fee_source", V),
        ("resolution_source", V), ("description", V), ("first_seen_ts", D), ("run_id", V),
        ("resolved", B), ("winner", V), ("payout_yes", D), ("payout_no", D),
        ("resolved_ts", D), ("btc_open", D), ("btc_close", D), ("btc_source", V),
    ],
    "orders": [
        ("order_id", V), ("run_id", V), ("mode", V), ("market", V), ("token_id", V),
        ("outcome", V), ("side", V), ("order_type", V), ("reason", V), ("prediction_id", V),
        ("signal_ts", D), ("submit_ts", D), ("ack_ts", D), ("done_ts", D), ("status", V),
        ("reject_reason", V), ("latency_ms", D), ("requested_size", D), ("limit_price", D),
        ("filled_size", D), ("avg_price", D), ("fee", D), ("fee_rate", D), ("fee_source", V),
        ("liquidity", V), ("slippage_vs_mid", D), ("slippage_vs_touch", D),
        ("decision_bid", D), ("decision_ask", D), ("decision_mid", D), ("decision_top_size", D),
        ("exec_bid", D), ("exec_ask", D), ("exec_mid", D), ("exec_top_size", D),
        ("queue_ahead", D), ("queue_time_ms", D),
    ],
    "equity": [
        ("ts", D), ("run_id", V), ("starting_cash", D), ("cash", D),
        ("positions_value_mid", D), ("positions_value_bid", D), ("realized_pnl", D),
        ("unrealized_pnl", D), ("fees_paid", D), ("equity", D), ("peak", D), ("drawdown", D),
        ("gross_exposure", D), ("max_market_exposure", D), ("max_simultaneous_exposure", D),
        ("locked_in_orders", D), ("open_positions", I),
    ],
    "positions": [
        ("ts", D), ("run_id", V), ("market", V), ("token_id", V), ("outcome", V),
        ("size", D), ("avg_price", D), ("mark_mid", D), ("mark_bid", D), ("unrealized", D),
        ("opened_at", D),
    ],
    "predictions": [
        ("prediction_id", V), ("ts", D), ("run_id", V), ("market", V), ("token_id", V),
        ("outcome", V), ("model_version", V), ("features_version", V), ("probability", D),
        ("signal", D), ("decision", V), ("reason", V), ("threshold", D), ("price_at_decision", D),
        ("intended_size", D), ("in_gap", B),
    ],
    "stream_events": [
        ("ts", D), ("run_id", V), ("connection_id", I), ("kind", V), ("token_id", V),
        ("value", D), ("detail", V),
    ],
}

# The raw L2 stream is far larger than the rest; it goes to hourly Parquet files, not DuckDB.
BOOK_EVENT_COLUMNS: list[tuple[str, str]] = [
    ("recv_ts", D), ("exchange_ts", D), ("run_id", V), ("connection_id", I), ("seq", I),
    ("market", V), ("event_type", V), ("token_id", V), ("side", V), ("price", D),
    ("size", D), ("best_bid", D), ("best_ask", D), ("hash", V), ("fee_rate_bps", D),
    # Book snapshots repeat after every trade; between full ones only changed levels are kept
    # (size 0 = level removed), which replays exactly onto the previous state.
    ("is_delta", B),
]

# Tables whose rows are rewritten in place (latest value per key).
KEYS = {"runs": "run_id", "markets": "slug"}


class Storage:
    def __init__(self, db_path: Path, parquet_dir: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        parquet_dir.mkdir(parents=True, exist_ok=True)
        self.parquet_dir = parquet_dir
        self.db = duckdb.connect(str(db_path))
        for table, columns in SCHEMAS.items():
            ddl = ", ".join(f"{name} {kind}" for name, kind in columns)
            self.db.execute(f"CREATE TABLE IF NOT EXISTS {table} ({ddl})")
            # Databases created by older versions lack the newer columns.
            for name, kind in columns:
                self.db.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {name} {kind}")

    def insert(self, table: str, row: dict) -> None:
        if table not in SCHEMAS:
            raise ValueError("Invalid table")
        known = {name for name, _ in SCHEMAS[table]}
        columns = [c for c in row if c in known]
        placeholders = ",".join("?" for _ in columns)
        self.db.execute(
            f"INSERT INTO {table} ({','.join(columns)}) VALUES ({placeholders})",
            [row[c] for c in columns],
        )

    def upsert(self, table: str, row: dict) -> None:
        """Replace the row with the same key (`KEYS[table]`), keeping columns not in `row`."""
        key = KEYS[table]
        existing = self.get(table, row[key])
        self.db.execute(f"DELETE FROM {table} WHERE {key} = ?", [row[key]])
        self.insert(table, (existing or {}) | row)

    def get(self, table: str, key_value) -> dict | None:
        cursor = self.db.execute(f"SELECT * FROM {table} WHERE {KEYS[table]} = ?", [key_value])
        row = cursor.fetchone()
        if row is None:
            return None
        return dict(zip([c[0] for c in cursor.description], row, strict=True))

    def query(self, sql: str, parameters: list | None = None) -> list[dict]:
        cursor = self.db.execute(sql, parameters or [])
        names = [c[0] for c in cursor.description]
        return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]

    def export_parquet(self) -> None:
        for table in SCHEMAS:
            final = self.parquet_dir / f"{table}.parquet"
            tmp = self.parquet_dir / f".{table}.parquet.tmp"
            target = tmp.as_posix().replace("'", "''")
            # Small row groups let the dashboard decode just the newly appended tail.
            self.db.execute(
                f"COPY {table} TO '{target}' "
                "(FORMAT PARQUET, ROW_GROUP_SIZE 16384, OVERWRITE_OR_IGNORE true)"
            )
            # Atomic swap so readers (the dashboard) never see a half-written file.
            os.replace(tmp, final)

    def close(self) -> None:
        self.export_parquet()
        self.db.close()


def hour_key(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).strftime("%Y%m%d-%H")


PART = re.compile(r"^(\d{8}-\d{2})-(\d+)\.parquet$")
HOUR = re.compile(r"^(\d{8}-\d{2})\.parquet$")


def write_frame(frame: pd.DataFrame, path: Path, row_group_size: int | None = None) -> None:
    """Atomically write `frame` as zstd Parquet."""
    tmp = path.with_name(f".{path.name}.tmp")
    con = duckdb.connect()
    try:
        con.register("frame", frame)
        target = tmp.as_posix().replace("'", "''")
        groups = f", ROW_GROUP_SIZE {int(row_group_size)}" if row_group_size else ""
        con.execute(f"COPY frame TO '{target}' (FORMAT PARQUET, COMPRESSION ZSTD{groups})")
    finally:
        con.close()
    os.replace(tmp, path)


class PartitionedWriter:
    """Buffers rows in memory and writes them to `<dir>/<YYYYMMDD-HH>-<n>.parquet` (UTC hours).

    Parts of past hours are compacted into a single `<YYYYMMDD-HH>.parquet`; files older than
    `retention_days` (0 keeps everything) are deleted. Files are sorted by `ts_column` in small
    row groups, so a reader can fetch a time window using only the row-group statistics.
    """

    ROW_GROUP_SIZE = 32_768

    def __init__(
        self,
        directory: Path,
        columns: list[tuple[str, str]],
        ts_column: str,
        flush_seconds: float = 60.0,
        retention_days: float = 0.0,
    ) -> None:
        self.directory = directory
        self.columns = columns
        self.names = [name for name, _ in columns]
        self.ts_column = ts_column
        self.flush_seconds = flush_seconds
        self.retention_days = retention_days
        self.buffer: list[dict] = []
        self.last_flush = time.time()
        directory.mkdir(parents=True, exist_ok=True)
        self.sequence = 1 + max(
            (int(m.group(2)) for p in directory.iterdir() if (m := PART.match(p.name))), default=0
        )

    def append(self, row: dict) -> None:
        self.buffer.append(row)

    def extend(self, rows: Iterable[dict]) -> None:
        self.buffer.extend(rows)

    def maybe_flush(self, now: float | None = None) -> None:
        now = now or time.time()
        if now - self.last_flush >= self.flush_seconds:
            self.flush(now)

    def flush(self, now: float | None = None) -> None:
        now = now or time.time()
        self.last_flush = now
        if self.buffer:
            frame = pd.DataFrame(self.buffer, columns=self.names)
            self.buffer = []
            for name, kind in self.columns:
                if kind in (D, I):
                    frame[name] = pd.to_numeric(frame[name], errors="coerce")
                    if kind == I:
                        frame[name] = frame[name].astype("Int64")
                elif kind == B:
                    frame[name] = frame[name].astype("boolean")
                else:
                    frame[name] = frame[name].astype("string")
            hours = frame[self.ts_column].map(hour_key)
            for hour, part in frame.groupby(hours, sort=True):
                path = self.directory / f"{hour}-{self.sequence}.parquet"
                self.sequence += 1
                write_frame(part.sort_values(self.ts_column, kind="stable").reset_index(drop=True),
                            path, self.ROW_GROUP_SIZE)
        self.compact(before=hour_key(now))
        self.prune(now)

    def compact(self, before: str) -> None:
        """Merge the parts (and any earlier compacted file) of every hour older than `before`."""
        parts: dict[str, list[Path]] = {}
        for path in self.directory.iterdir():
            if (m := PART.match(path.name)) and m.group(1) < before:
                parts.setdefault(m.group(1), []).append(path)
        for hour, files in parts.items():
            final = self.directory / f"{hour}.parquet"
            sources = ([final] if final.exists() else []) + sorted(files)
            listing = ", ".join("'" + p.as_posix().replace("'", "''") + "'" for p in sources)
            con = duckdb.connect()
            try:
                frame = con.execute(
                    f"SELECT * FROM read_parquet([{listing}], union_by_name=true) "
                    f"ORDER BY {self.ts_column}"
                ).fetchdf()
            finally:
                con.close()
            write_frame(frame, final, self.ROW_GROUP_SIZE)
            for path in files:
                path.unlink(missing_ok=True)

    def prune(self, now: float) -> None:
        if self.retention_days <= 0:
            return
        oldest = hour_key(now - self.retention_days * 86400)
        for path in self.directory.iterdir():
            m = HOUR.match(path.name) or PART.match(path.name)
            if m and m.group(1) < oldest:
                path.unlink(missing_ok=True)

    def close(self) -> None:
        self.flush()
