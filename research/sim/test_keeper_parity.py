"""Independent Python differential checks for the Rust keeper quote builder."""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

Q64 = 1 << 64
BPS = 10_000
ROOT = Path(__file__).resolve().parents[2]


def expected(price_q64: int, base: int, quote: int) -> dict[str, int | list[tuple[int, int, int]]]:
    value = base * price_q64
    denominator = value + quote
    if value >= quote:
        q_bps = min(BPS, (value - quote) * BPS // denominator)
    else:
        q_bps = -min(BPS, (quote - value) * BPS // denominator)
    skew = 5 * q_bps // BPS
    factor = BPS - skew
    reservation = price_q64 * factor // BPS
    sqrt_anchor = math.isqrt(price_q64 << 64)
    sqrt_reservation = math.isqrt(reservation << 64)
    capacity = base * 5_000 * BPS // (BPS * BPS)
    levels = []
    previous = 0
    for offset, weight in zip((2, 5, 10, 20, 40, 80), (1000, 1500, 2000, 2000, 2000, 1500)):
        lo_price = reservation * (BPS + 1 + previous) // BPS
        hi_price = reservation * (BPS + 1 + offset) // BPS
        lo = math.isqrt(lo_price << 64)
        hi = math.isqrt(hi_price << 64)
        level_capacity = capacity * weight // BPS
        liquidity = level_capacity * lo * hi // (hi - lo)
        levels.append((lo, hi, liquidity))
        previous = offset
    return {"anchor": sqrt_anchor, "reservation": sqrt_reservation, "spread": 1, "depth": 10_000, "levels": levels}


def rust_quote(price_q64: int, base: int, quote: int) -> dict[str, int | list[tuple[int, int, int]]]:
    result = subprocess.run(
        ["cargo", "run", "-q", "-p", "arbswap-keeper", "--", "single", str(price_q64), str(base), str(quote)],
        cwd=ROOT, check=True, text=True, capture_output=True,
    )
    lines = result.stdout.strip().splitlines()
    fields = {key: int(value) for key, value in (part.split("=") for part in lines[0].split(","))}
    levels = [tuple(int(value.strip()) for value in line.split("=", 1)[1].split(",")) for line in lines[1:]]
    fields["levels"] = levels
    return fields


def test_keeper_matches_independent_python_quote_construction():
    for price, base, quote in ((150 * Q64, 1_000, 150_000), (123 * Q64, 2_000, 246_000), (200 * Q64, 900, 120_000)):
        assert rust_quote(price, base, quote) == expected(price, base, quote)
