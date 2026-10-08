import os
from pathlib import Path

import duckdb

SCHEMAS: dict[str, list[tuple[str, str]]] = {
    "features": [
        ("ts", "DOUBLE"), ("token_id", "VARCHAR"), ("best_bid", "DOUBLE"), ("best_ask", "DOUBLE"),
        ("midpoint", "DOUBLE"), ("spread", "DOUBLE"), ("bid_depth_3", "DOUBLE"),
        ("ask_depth_3", "DOUBLE"), ("book_imbalance", "DOUBLE"), ("microprice", "DOUBLE"),
        ("microprice_delta", "DOUBLE"), ("flow_imbalance", "DOUBLE"), ("trade_pressure", "DOUBLE"),
        ("score", "DOUBLE"), ("weighted_imbalance", "DOUBLE"), ("ofi", "DOUBLE"),
        ("volatility", "DOUBLE"), ("spread_ticks", "DOUBLE"), ("top_bid_size", "DOUBLE"),
        ("top_ask_size", "DOUBLE"), ("trade_volume", "DOUBLE"), ("market", "VARCHAR"),
        ("outcome", "VARCHAR"),
    ],
    "fills": [
        ("ts", "DOUBLE"), ("token_id", "VARCHAR"), ("side", "VARCHAR"), ("size", "DOUBLE"),
        ("price", "DOUBLE"), ("fee", "DOUBLE"), ("order_id", "VARCHAR"), ("mode", "VARCHAR"),
        ("reason", "VARCHAR"), ("pnl", "DOUBLE"), ("market", "VARCHAR"), ("outcome", "VARCHAR"),
    ],
}


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
        columns = list(row)
        placeholders = ",".join("?" for _ in columns)
        self.db.execute(f"INSERT INTO {table} ({','.join(columns)}) VALUES ({placeholders})",
                        [row[c] for c in columns])

    def export_parquet(self) -> None:
        for table in SCHEMAS:
            final = self.parquet_dir / f"{table}.parquet"
            tmp = self.parquet_dir / f".{table}.parquet.tmp"
            target = tmp.as_posix().replace("'", "''")
            self.db.execute(f"COPY {table} TO '{target}' (FORMAT PARQUET, OVERWRITE_OR_IGNORE true)")
            # Atomic swap so readers (the dashboard) never see a half-written file.
            os.replace(tmp, final)

    def close(self) -> None:
        self.export_parquet()
        self.db.close()
