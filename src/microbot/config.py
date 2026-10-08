from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="PM_", extra="ignore")

    yes_token_id: str = ""
    no_token_id: str = ""
    mode: Literal["record", "paper", "live"] = "paper"
    ws_url: str = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
    clob_host: str = "https://clob.polymarket.com"
    chain_id: int = 137
    db_path: Path = Path("data/microbot.duckdb")
    parquet_dir: Path = Path("data/parquet")
    feature_interval_ms: int = Field(500, ge=100, le=60_000)
    signal_threshold: float = Field(0.22, ge=0, le=1)
    exit_threshold: float = Field(0.04, ge=0, le=1)
    max_position_shares: float = Field(25.0, gt=0)
    order_size_shares: float = Field(2.0, gt=0)
    max_spread: float = Field(0.08, gt=0, le=1)
    min_top_depth: float = Field(5.0, ge=0)
    cooldown_seconds: float = Field(3.0, ge=0)
    stale_book_seconds: float = Field(5.0, gt=0)
    paper_starting_cash: float = Field(1_000.0, gt=0)
    fee_rate: float = Field(0.0, ge=0)
    model_path: Path | None = None
    export_interval_seconds: float = Field(5.0, ge=0)

    # Signal construction
    signal_half_life_seconds: float = Field(5.0, gt=0)
    zscore_half_life_seconds: float = Field(900.0, gt=0)
    zscore_warmup_samples: int = Field(30, ge=0)
    weight_imbalance: float = 0.35
    weight_ofi: float = 0.30
    weight_pressure: float = 0.20
    weight_microprice: float = 0.15

    # Entry filters, exits and sizing
    spread_penalty: float = Field(0.02, ge=0)
    min_price: float = Field(0.05, ge=0, le=1)
    max_price: float = Field(0.95, ge=0, le=1)
    max_volatility: float = Field(0.05, gt=0)
    take_profit: float = Field(0.03, gt=0)
    stop_loss: float = Field(0.02, gt=0)
    min_hold_seconds: float = Field(10.0, ge=0)
    max_hold_seconds: float = Field(600.0, gt=0)
    max_slippage: float = Field(0.01, ge=0)
    max_top_participation: float = Field(0.5, gt=0, le=1)
    min_order_shares: float = Field(1.0, gt=0)

    private_key: str | None = None
    api_key: str | None = None
    api_secret: str | None = None
    api_passphrase: str | None = None
    funder: str | None = None
    signature_type: int = 0
    enable_live_trading: str = ""

    @field_validator("model_path", mode="before")
    @classmethod
    def empty_model_path_is_none(cls, value):
        return None if value == "" else value

    @model_validator(mode="after")
    def validate_runtime(self):
        if not self.yes_token_id or not self.no_token_id:
            raise ValueError("PM_YES_TOKEN_ID and PM_NO_TOKEN_ID are required")
        if self.yes_token_id == self.no_token_id:
            raise ValueError("YES and NO token IDs must be different")
        if self.min_price >= self.max_price:
            raise ValueError("PM_MIN_PRICE must be lower than PM_MAX_PRICE")
        if self.min_hold_seconds > self.max_hold_seconds:
            raise ValueError("PM_MIN_HOLD_SECONDS cannot exceed PM_MAX_HOLD_SECONDS")
        if self.mode == "live":
            if self.enable_live_trading != "I_UNDERSTAND_THE_RISK":
                raise ValueError("Live mode requires PM_ENABLE_LIVE_TRADING=I_UNDERSTAND_THE_RISK")
            missing = [
                name
                for name, value in {
                    "PM_PRIVATE_KEY": self.private_key,
                    "PM_FUNDER": self.funder,
                }.items()
                if not value
            ]
            if missing:
                raise ValueError(f"Missing live credentials: {', '.join(missing)}")
        return self

