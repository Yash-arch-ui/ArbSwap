"""C3/B2 differential: the Python inverse-sqrt capacity must not under-estimate
the exact integer capacity, mirroring `vault/math/tests/capacity_inverse.rs`."""

from __future__ import annotations

from simulation.reference.quote_math import (
    base_capacity_from_inverse_sqrts,
    inv_sqrt_is_conservative,
    inv_sqrt_q64_ceil,
)


def _lcg(state: int) -> int:
    return (state * 6364136223846793005 + 1442695040888963407) % (1 << 128)


def test_inverse_capacity_over_estimates_the_exact_one():
    state = 0x1234_5678_9ABC_DEF0
    checked = 0
    for _ in range(100_000):
        state = _lcg(state)
        liquidity = (state % (1 << 60)) + 1
        state = _lcg(state)
        sqrt_lo = (state % (1 << 90)) + 1
        state = _lcg(state)
        delta = (state % (1 << 60)) + 1
        sqrt_hi = sqrt_lo + delta
        exact = liquidity * delta // (sqrt_lo * sqrt_hi)
        inv_lo = inv_sqrt_q64_ceil(sqrt_lo)
        inv_hi = inv_sqrt_q64_ceil(sqrt_hi)
        assert inv_sqrt_is_conservative(sqrt_lo, inv_lo)
        assert inv_sqrt_is_conservative(sqrt_hi, inv_hi)
        est = base_capacity_from_inverse_sqrts(liquidity, sqrt_lo, sqrt_hi, inv_lo, inv_hi)
        assert est >= exact, f"under-estimate: {est} < {exact}"
        assert est <= exact + exact // 1_000 + 2, f"too loose: {est} vs {exact}"
        checked += 1
    assert checked == 100_000


def test_under_estimate_is_detected():
    sqrt_lo = (1 << 70) + 12345
    inv = inv_sqrt_q64_ceil(sqrt_lo)
    assert inv_sqrt_is_conservative(sqrt_lo, inv)
    assert not inv_sqrt_is_conservative(sqrt_lo, inv // 2)
