"""Shared fee arithmetic for decisions and execution."""

FEE_DECIMALS = 5


def polymarket_fee(fee_rate: float, size: float, price: float, exponent: float = 1.0) -> float:
    """Taker fee in USDC, rounded to the venue's published precision."""
    return round(size * fee_rate * (price * (1 - price)) ** exponent, FEE_DECIMALS)
