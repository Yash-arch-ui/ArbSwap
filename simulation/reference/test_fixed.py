"""Tests for fixed-point primitives (Build Plan §5.2)."""
import pytest

from simulation.reference.arb_math_ref import add_bps, mul_div_ceil, mul_div_floor
from simulation.reference.fixed import (
    BPS,
    FixedPointError,
    Q64,
    U128_MAX,
    ceil_bps,
    div_q64,
    isqrt,
    mul_bps,
    mul_q64,
    one_plus_q64,
    price_from_sqrt,
    recip_inv,
    recip_q64,
    sqrt_from_price,
    sqrt_price_scaled,
    sqrt_q64,
    tdiv,
)

SOL_PRICE = 150
# Q64.64 sqrt price of 150: exact floor(sqrt(150 * 2**64))
SQRT_150 = isqrt((SOL_PRICE * Q64) << 64)


def test_tdiv_matches_rust_truncation():
    assert tdiv(7, 2) == 3
    assert tdiv(-7, 2) == -3  # Rust: -7/2 == -3 (toward zero); Python // would be -4
    assert tdiv(7, -2) == -3
    assert tdiv(-7, -2) == 3
    assert tdiv(0, 5) == 0
    with pytest.raises(FixedPointError):
        tdiv(1, 0)


def test_isqrt():
    assert isqrt(0) == 0
    assert isqrt(1) == 1
    assert isqrt(15) == 3
    assert isqrt(16) == 4
    assert isqrt((1 << 128) - 1) == (1 << 64) - 1
    with pytest.raises(FixedPointError):
        isqrt(-1)


def test_mul_q64_floor():
    # 2.0 * 3.0 = 6.0 in Q64.64
    assert mul_q64(2 * Q64, 3 * Q64) == 6 * Q64
    # 1.1 * 1.1 = 1.21: a = floor(1.1 * 2**64), so floor(a*a / 2**64) can trail
    # floor(1.21 * 2**64) by up to ~3 units (double flooring: a is already
    # rounded, and the product is floored again). Assert closeness, not equality.
    a = (11 * Q64) // 10
    expected = (121 * Q64) // 100
    got = mul_q64(a, a)
    assert abs(got - expected) <= 3
    # exact floor semantics: mul_q64(a, b) == (a * b) >> 64 by definition
    assert got == (a * a) >> 64
    # one-atom products floor to zero
    assert mul_q64(1, 1) == 0
    with pytest.raises(FixedPointError):
        mul_q64(-1, 1)


def test_div_q64_floor():
    assert div_q64(6 * Q64, 3 * Q64) == 2 * Q64
    # floor direction: 1 / 3 in Q64.64
    assert div_q64(Q64, 3 * Q64) == Q64 // 3
    with pytest.raises(FixedPointError):
        div_q64(1, 0)


def test_sqrt_q64_of_one_is_one():
    assert sqrt_q64(Q64) == Q64  # sqrt(1.0) = 1.0


def test_sqrt_q64_is_floor_of_true_sqrt():
    # sqrt(2) in Q64.64 = exact floor(sqrt(2) * 2**64) = isqrt(2 * 2**128)
    two_q64 = 2 * Q64
    exact = isqrt(two_q64 << 64)
    assert sqrt_q64(two_q64) == exact
    # the old shortcut isqrt(v) << 32 truncates before scaling: it must be
    # strictly below the true floor (unless v is a perfect square)
    assert isqrt(two_q64) << 32 < exact
    # perfect square: exact and shortcut agree
    assert sqrt_q64(4 * Q64) == isqrt(4 * Q64 << 64)
    assert sqrt_q64(4 * Q64) == 2 * Q64


def test_recip_q64_roundtrip_close():
    # 1 / sqrt(150) in Q64.64 then back. The double-floor construction
    # recip_inv(recip(s)) = floor(2**128 / floor(2**128 / s)) can overshoot s
    # by up to ~s**2 / 2**128 units (here s**2/2**128 ~ 150), not by 1 unit.
    s = sqrt_from_price(SOL_PRICE * Q64)
    r = recip_q64(s)
    back = recip_inv(r)
    bound = (s * s) >> 128
    assert 0 <= back - s <= bound + 1
    # value check: r == floor(2**128 / s)
    assert r == (1 << 128) // s


def test_recip_domain():
    with pytest.raises(FixedPointError):
        recip_q64(1)
    with pytest.raises(FixedPointError):
        recip_inv(1)


def test_sqrt_from_price_and_back():
    p = SOL_PRICE * Q64
    s = sqrt_from_price(p)
    # exact conversion: s = floor(sqrt(p * 2**64)) — 192-bit radicand
    assert s == isqrt(p << 64)
    back = price_from_sqrt(s)
    # squaring a floored sqrt: back <= p and the loss is ~2*sqrt(p)/2**64 + 1
    # units of price_q64 (tiny: sqrt here is ~12.25 * 2**64)
    assert back <= p
    assert p - back <= (2 * s) // Q64 + 1


def test_one_plus_q64():
    assert one_plus_q64(0) == Q64
    assert one_plus_q64(BPS) == 2 * Q64  # 1 + 100% = 2.0
    assert one_plus_q64(-BPS // 2) == Q64 // 2  # 1 - 50% = 0.5
    with pytest.raises(FixedPointError):
        one_plus_q64(-BPS)
    with pytest.raises(FixedPointError):
        one_plus_q64(-BPS - 1)


def test_sqrt_price_scaled_matches_direct_computation():
    # sqrt(P * (1 + x)) via the two-floor path sqrt(P) * sqrt(1+x)
    p = 150 * Q64
    s = sqrt_from_price(p)
    x_bps = 25  # +0.25%
    got = sqrt_price_scaled(s, x_bps)
    # direct: floor(sqrt(floor(150 * 1.0025) * 2**64)) — single-floor value
    direct_price = (p * (BPS + x_bps)) // BPS
    direct = sqrt_from_price(direct_price)
    # two-floor path never exceeds direct and trails it by at most
    # sqrt_p/2**64 + 3 units (see sqrt_price_scaled docstring)
    assert 0 <= direct - got <= (s // Q64) + 3


def test_mul_bps_and_ceil_bps_rounding_directions():
    # vault pays out: floor
    assert mul_bps(999, 1) == 0
    assert mul_bps(10_000, 1) == 1
    # vault receives: ceil
    assert ceil_bps(999, 1) == 1
    assert ceil_bps(10_000, 1) == 1
    assert ceil_bps(0, 50) == 0
    with pytest.raises(FixedPointError):
        mul_bps(-1, 1)
    with pytest.raises(FixedPointError):
        ceil_bps(-1, 1)


def test_u128_overflow_guard():
    with pytest.raises(FixedPointError):
        # force mul_q64 overflow: two huge Q64.64 values
        mul_q64(U128_MAX, U128_MAX)


def test_primitive_exports_still_work():
    assert mul_div_floor(9, 3, 3) == 9
    assert mul_div_ceil(10, 1, 3) == 4
    assert add_bps(1_000_001, 1, True) == 1_000_102
    assert BPS == 10_000
