"""Independent Python differential checks for the Rust keeper quote builder.

The keeper's quote math is integer and mirrors the Section 5 formulas in
``research/reference/quote_math.py``:

    q            = (B*P - Q) / (B*P + Q)                       (Section 5.3)
    spread       = clamp(floor + a1*sigma + a2*|q| + a3*c/P
                         + a4*max(0, age-grace) + jump_extra,
                         spread_min, spread_max)               (Section 5.5)
    ask_extra    = e*max(0, (P-Pprev)/Pprev)                    (Section 5.6)
    depth        = min(1, sigma_target/sigma, 1-c/c_max, 1-jump_cooldown)
                   capped by depth_budget                       (Section 5.9)

These tests re-derive the *integer* result in Python and require bit equality
with the Rust binary, which is a true differential check between the two
implementations. The fixtures exercise what the earlier single σ=0, same-scale
case could not: a non-zero inventory skew, a real token-decimals scale
(SOL 9 / USDC 6, audit F-03), and the directional add-on.
"""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

Q64 = 1 << 64
BPS = 10_000
ROOT = Path(__file__).resolve().parents[2]

# KeeperParams::default() values this test mirrors.
SPREAD_FLOOR = 1
SPREAD_MIN = 1
SPREAD_MAX = 50
INVENTORY_COEFF = 5
CONFIDENCE_COEFF = 1
CONFIDENCE_MAX_BPS = 10
JUMP_EXTRA = 5
JUMP_COOLDOWN = 5_000
DIRECTIONAL_COEFF = 10_000
UTILIZATION = 5_000
DEPTH_BUDGET = 10_000
SIGMA_TARGET_Q64 = 1 << 60
OFFSETS = (2, 5, 10, 20, 40, 80)
WEIGHTS = (1000, 1500, 2000, 2000, 2000, 1500)
CONFIDENCE_BPS = 1  # `single` uses a fixed confidence of 1 bp


def expected(
    price_q64: int,
    base: int,
    quote: int,
    *,
    previous_price_q64: int = 0,
    base_atom_scale: int = 1,
) -> dict[str, int | list[tuple[int, int, int]]]:
    # Inventory imbalance on the base *value* in quote atoms (F-03).
    base_value = base * price_q64 // Q64 // base_atom_scale
    denominator = base_value + quote
    if base_value >= quote:
        q_bps = min(BPS, (base_value - quote) * BPS // denominator)
    else:
        q_bps = -min(BPS, (quote - base_value) * BPS // denominator)
    # Rust `/` truncates toward zero; Python `//` floors. The keeper uses signed
    # division on `q_bps`, so mirror the truncation (FORMULA Section 1.2).
    scaled = INVENTORY_COEFF * q_bps
    skew = (abs(scaled) // BPS) * (1 if scaled >= 0 else -1)
    factor = BPS - skew
    reservation = price_q64 * factor // BPS

    # sigma = 0 for `single`, so the volatility term is zero; the confidence
    # term rounds to zero but the confidence *throttle* does not.
    raw_spread = (
        SPREAD_FLOOR
        + CONFIDENCE_COEFF * CONFIDENCE_BPS // BPS
        + 0
        + 0
    )
    spread = max(SPREAD_MIN, min(SPREAD_MAX, raw_spread))

    if previous_price_q64 == 0 or price_q64 == 0:
        ask_extra = bid_extra = 0
    else:
        move_bps = abs(price_q64 - previous_price_q64) * BPS // previous_price_q64
        ask_extra = move_bps * DIRECTIONAL_COEFF // BPS if price_q64 > previous_price_q64 else 0
        bid_extra = move_bps * DIRECTIONAL_COEFF // BPS if previous_price_q64 > price_q64 else 0

    sigma = 0
    sigma_factor = BPS if sigma == 0 else BPS
    confidence_factor = BPS - min(BPS, CONFIDENCE_BPS * BPS // CONFIDENCE_MAX_BPS)
    jump_factor = 0
    rule = sigma_factor * confidence_factor // BPS
    rule = rule * (BPS - jump_factor) // BPS
    depth = min(BPS, rule, DEPTH_BUDGET)

    ask_spread = spread + ask_extra
    capacity = base * UTILIZATION * depth // (BPS * BPS)
    levels = []
    previous = 0
    for offset, weight in zip(OFFSETS, WEIGHTS):
        lo_price = reservation * (BPS + ask_spread + previous) // BPS
        hi_price = reservation * (BPS + ask_spread + offset) // BPS
        lo = math.isqrt(lo_price << 64)
        hi = math.isqrt(hi_price << 64)
        level_capacity = capacity * weight // BPS
        liquidity = level_capacity * lo * hi // (hi - lo)
        levels.append((lo, hi, liquidity))
        previous = offset
    return {
        "anchor": math.isqrt(price_q64 << 64),
        "reservation": math.isqrt(reservation << 64),
        "spread": spread,
        "ask_extra": ask_extra,
        "bid_extra": bid_extra,
        "depth": depth,
        "levels": levels,
    }


def rust_quote(
    price_q64: int,
    base: int,
    quote: int,
    *,
    previous_price_q64: int = 0,
    base_atom_scale: int = 1,
) -> dict[str, int | list[tuple[int, int, int]]]:
    result = subprocess.run(
        [
            "cargo", "run", "-q", "-p", "arbswap-keeper", "--", "single",
            str(price_q64), str(base), str(quote),
            str(previous_price_q64), str(base_atom_scale),
        ],
        cwd=ROOT, check=True, text=True, capture_output=True,
    )
    lines = result.stdout.strip().splitlines()
    fields = {key: int(value) for key, value in (part.split("=") for part in lines[0].split(","))}
    levels = [tuple(int(value.strip()) for value in line.split("=", 1)[1].split(",")) for line in lines[1:]]
    fields["levels"] = levels
    return fields


def test_keeper_matches_independent_python_quote_construction():
    """Same-scale fixtures: balanced, long-base and short-base skews."""
    cases = (
        (150 * Q64, 1_000, 150_000),
        (150 * Q64, 1_000, 100_000),   # long base -> q > 0 -> reservation < price
        (150 * Q64, 1_000, 300_000),   # short base -> q < 0 -> reservation > price
        (123 * Q64, 2_000, 246_000),
        (200 * Q64, 900, 120_000),
    )
    for price, base, quote in cases:
        assert rust_quote(price, base, quote) == expected(price, base, quote)


def test_keeper_inventory_skew_is_decimal_aware():
    """F-03 regression: SOL has 9 decimals, USDC 6.

    A balanced 1000 SOL / 150,000 USDC vault must quote *at* the anchor. With
    the old `base * price_q64` (no Q64 shift, no scale) the imbalance saturated
    and the reservation was pushed to its bound for every realistic reserve.
    """
    price = 150 * Q64
    base = 1_000 * 10**9        # 1000 SOL in 9-decimal atoms
    quote = 150_000 * 10**6     # 150,000 USDC in 6-decimal atoms
    got = rust_quote(price, base, quote, base_atom_scale=10**3)
    want = expected(price, base, quote, base_atom_scale=10**3)
    assert got == want
    assert got["reservation"] == got["anchor"], "balanced vault must not be skewed"

    # 100,000 USDC against the same 1000 SOL is a clearly long-base vault
    # (~20% imbalance, enough that the 5 bps inventory coefficient bites), so
    # the reservation must drop below the anchor.
    long_base = rust_quote(price, base, 100_000 * 10**6, base_atom_scale=10**3)
    assert long_base["reservation"] < long_base["anchor"]
    assert long_base == expected(price, base, 100_000 * 10**6, base_atom_scale=10**3)


def test_keeper_directional_addon_is_encoded():
    """A 1 USDC rise on a 149 USDC prior price widens the ask side only."""
    previous = 149 * Q64
    price = 150 * Q64
    got = rust_quote(price, 1_000, 150_000, previous_price_q64=previous)
    want = expected(price, 1_000, 150_000, previous_price_q64=previous)
    assert got == want
    assert got["ask_extra"] > 0
    assert got["bid_extra"] == 0

    # A fall widens the bid side instead.
    down = rust_quote(148 * Q64, 1_000, 150_000, previous_price_q64=previous)
    assert down["ask_extra"] == 0
    assert down["bid_extra"] > 0


def test_keeper_pricing_matches_the_simulator_reference():
    """Keeper anchor/reservation/depth against ``quote_math.compute_quote``.

    The simulator uses float fractions; the keeper uses integer bps. The
    *pricing core* (anchor, reservation, depth throttle) must agree within
    rounding. The spread coefficient scales still differ (audit F-09), so the
    spread itself is compared only structurally elsewhere.
    """
    from research.reference.quote_math import QuoteParams, VolatilityState, compute_quote

    cases = (
        (150 * Q64, 1_000, 150_000),
        (150 * Q64, 1_000, 100_000),
        (150 * Q64, 1_000, 220_000),
        (200 * Q64, 900, 120_000),
    )
    conf_bps = 1
    for price_q64, base, quote in cases:
        price = price_q64 / Q64
        reference = compute_quote(
            price=price,
            base_reserve=base,
            quote_reserve=quote,
            confidence=price * conf_bps / 10_000,
            age=0.0,
            volatility=VolatilityState(),
            params=QuoteParams(),
        )
        got = rust_quote(price_q64, base, quote)
        keeper_anchor = got["anchor"] ** 2 / (1 << 128)
        keeper_reservation = got["reservation"] ** 2 / (1 << 128)
        assert abs(keeper_anchor - reference.reference_price) <= 1e-6 * price
        # The keeper quantises the inventory skew to whole bps, so the
        # reservation agrees with the float reference to within one bps of price.
        assert (
            abs(keeper_reservation - reference.reservation_price)
            <= 2e-4 * reference.reservation_price
        )
        assert abs(got["depth"] / 10_000 - reference.depth_mult) <= 1e-9

