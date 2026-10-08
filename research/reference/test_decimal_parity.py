"""Item 8: direct high-precision decimal vs integer parity.

The golden-vector suite is a Rust<->Python-*integer*-mirror differential; this
test closes the independence gap by comparing the integer fixed-point primitives
against an **independent high-precision decimal computation** (mpmath at 80
digits), with a stated tolerance.

Tolerance: every primitive is a floor of a real-valued expression, so the integer
result must equal `floor(exact)` exactly, i.e. `0 <= exact - result < 1`
(within 1 unit in the last place at Q64.64). We assert that bound.
"""

from __future__ import annotations

import random

import mpmath as mp
import pytest

from research.reference.fixed import (
    div_q64,
    mul_q64,
    price_from_sqrt,
    recip_q64,
    sqrt_q64,
)

mp.mp.dps = 80
Q64 = 1 << 64


def _within_one_ulp(exact: mp.mpf, result: int) -> bool:
    """The integer result is the exact floor of a non-negative real."""
    return mp.mpf(0) <= exact - result < mp.mpf(1)


@pytest.mark.parametrize("seed", [20261006, 20261007, 20261008])
def test_sqrt_q64_matches_high_precision(seed: int) -> None:
    rng = random.Random(seed)
    for _ in range(200):
        v = rng.randint(0, (1 << 120))
        got = sqrt_q64(v)
        exact = mp.sqrt(mp.mpf(v)) * (1 << 32)  # sqrt(v/2^64)*2^64
        assert _within_one_ulp(exact, got), (v, got, exact)


@pytest.mark.parametrize("seed", [1, 2])
def test_recip_q64_matches_high_precision(seed: int) -> None:
    rng = random.Random(seed)
    for _ in range(200):
        s = rng.randint(2, (1 << 120))
        got = recip_q64(s)
        exact = mp.mpf(1 << 128) / s
        assert _within_one_ulp(exact, got), (s, got, exact)


@pytest.mark.parametrize("seed", [3, 4])
def test_mul_and_div_q64_match_high_precision(seed: int) -> None:
    rng = random.Random(seed)
    for _ in range(200):
        a = rng.randint(0, 1 << 92)
        b = rng.randint(1, 1 << 92)
        got_mul = mul_q64(a, b)
        exact_mul = mp.mpf(a) * b / (1 << 64)
        assert _within_one_ulp(exact_mul, got_mul), (a, b, got_mul, exact_mul)
        got_div = div_q64(a, b)
        exact_div = mp.mpf(a) * (1 << 64) / b
        assert _within_one_ulp(exact_div, got_div), (a, b, got_div, exact_div)


@pytest.mark.parametrize("seed", [5, 6])
def test_price_from_sqrt_matches_high_precision(seed: int) -> None:
    rng = random.Random(seed)
    for _ in range(200):
        s = rng.randint(0, 1 << 95)  # s^2 must stay within u128 after >>64
        got = price_from_sqrt(s)
        exact = mp.mpf(s) * s / (1 << 64)
        assert _within_one_ulp(exact, got), (s, got, exact)