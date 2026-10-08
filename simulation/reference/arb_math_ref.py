"""High-precision Python reference of `arb-math` (Build Plan §5, task T1.1).

The Python reference is the source of truth: the Rust implementation must match
it within 1 unit of the smallest token atom (Build Plan §10 differential tests).
Golden vectors generated from here land in `tests/golden_vectors` (task T1.2,
target: >= 500 cases covering edge cases and rounding).

This module starts with the exact integer primitives from Build Plan §5.2.
Floating-point research math (spread, LVR, simulator) may use numpy/mpmath;
on-chain math must never see floats.
"""

BPS_DENOMINATOR = 10_000


def mul_div_floor(a: int, b: int, c: int) -> int:
    """Exact floor((a * b) / c). Python ints are arbitrary precision."""
    if c == 0:
        raise ValueError("division by zero")
    return (a * b) // c


def mul_div_ceil(a: int, b: int, c: int) -> int:
    """Exact ceil((a * b) / c)."""
    if c == 0:
        raise ValueError("division by zero")
    return -((-a * b) // c)


def add_bps(amount: int, bps: int, round_up: bool) -> int:
    """Add `bps` of `amount`, rounding in the vault's favor.

    round_up=True  -> the vault receives (ceil)
    round_up=False -> the vault pays out (floor)
    """
    part = mul_div_ceil(amount, bps, BPS_DENOMINATOR) if round_up \
        else mul_div_floor(amount, bps, BPS_DENOMINATOR)
    return amount + part


# TODO(T1.1): port Build Plan §5 in full:
#   §5.5 half-spread, §5.6 directional add-on, §5.7 ladder, §5.8 segment swap walk,
#   §5.9 flow accumulator (resets per update, decision D-04),
#   §5.10 LVR budget (V_active <= 8*(R-gas)/sigma^2), §5.14 share math (D-05).
