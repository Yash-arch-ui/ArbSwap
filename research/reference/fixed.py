"""Fixed-point primitives for the ArbSwap math core (Build Plan §5.2).

Source-of-truth conventions (mirrored bit-exactly by `crates/arb-math`):

- Prices are Q64.64 fixed point: ``price_q64 = P * 2**64`` where P is quote
  tokens per base token (real number).
- Square-root prices are Q64.64 of sqrt(P): ``sqrt_price = sqrt(P) * 2**64``.
  Exact conversion (decision 2026-10-06): ``sqrt_price = isqrt(price_q64 << 64)``
  — the true floor of ``sqrt(P) * 2**64``. The shortcut ``isqrt(price_q64) << 32``
  is NOT equal to it (it truncates ``floor(sqrt(p))`` before scaling and loses up
  to ``2**32`` units); we use the exact form everywhere so Python and Rust match
  bit-for-bit against the golden vectors. The radicand ``price_q64 << 64`` needs
  192 bits — trivial in Python; the Rust port must widen (u128 * u128 -> u192/u256).
- Token amounts are plain integers (u64 semantics on-chain).
- ``bps`` are integers with denominator 10_000.
- Rounding: amounts the vault pays out round DOWN; amounts it receives round
  UP.  Every function below documents its direction.
- Python ``//`` floors (toward -inf) while Rust ``/`` truncates (toward 0);
  ``tdiv`` reproduces Rust truncation and MUST be used wherever an operand can
  be negative (e.g. inventory imbalance numerator, price returns).
"""

import math

from research.reference.arb_math_ref import (  # noqa: F401  (re-exported public API)
    BPS_DENOMINATOR,
    add_bps,
    mul_div_ceil,
    mul_div_floor,
)

BPS = BPS_DENOMINATOR
Q64 = 1 << 64
U64_MAX = (1 << 64) - 1
U128_MAX = (1 << 128) - 1
ONE_Q64 = Q64


class FixedPointError(ValueError):
    """Raised where the Rust port returns None (overflow / zero / out of domain)."""


def _chk_u128(x: int) -> int:
    if x > U128_MAX:
        raise FixedPointError(f"u128 overflow: {x}")
    return x


def tdiv(a: int, b: int) -> int:
    """Truncating division toward zero — identical to Rust integer ``/``."""
    if b == 0:
        raise FixedPointError("division by zero")
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def isqrt(n: int) -> int:
    """Floor square root. Negative input is an error (Rust returns None)."""
    if n < 0:
        raise FixedPointError("isqrt of negative")
    return math.isqrt(n)


def mul_q64(a: int, b: int) -> int:
    """Q64.64 * Q64.64 -> Q64.64, floor. Non-negative operands only."""
    if a < 0 or b < 0:
        raise FixedPointError("mul_q64 negative operand")
    return _chk_u128((a * b) >> 64)


def div_q64(a: int, b: int) -> int:
    """Q64.64 / Q64.64 -> Q64.64, floor. Non-negative operands only."""
    if a < 0 or b <= 0:
        raise FixedPointError("div_q64 domain")
    return _chk_u128((a << 64) // b)


def sqrt_q64(v: int) -> int:
    """sqrt of a Q64.64 value, result Q64.64, exact floor.

    sqrt(v / 2**64) * 2**64 = sqrt(v) * 2**32 = isqrt(v << 64).
    Uses the 192-bit radicand so the result is the true floor; the Rust port
    must compute the same value with a widened isqrt (see module docstring).
    """
    if v < 0:
        raise FixedPointError("sqrt_q64 negative")
    return _chk_u128(isqrt(v << 64))


def recip_q64(s: int) -> int:
    """1/s in Q64.64 where s is a Q64.64 sqrt price, floor.

    (1<<128) // s.  Requires s >= 2 so the result fits u128 (s == 1 would
    give exactly 2**128, one past u128::MAX — an impossible sqrt price for
    any real market, and rejected identically in Rust).
    """
    if s < 2:
        raise FixedPointError("recip_q64 domain")
    return (1 << 128) // s


def recip_inv(r: int) -> int:
    """Inverse of recip_q64: floor(2**128 / r), a Q64.64 sqrt price."""
    if r < 2:
        raise FixedPointError("recip_inv domain")
    return (1 << 128) // r


def sqrt_from_price(price_q64: int) -> int:
    """Q64.64 price -> Q64.64 sqrt price, exact floor (same operation as sqrt_q64)."""
    return sqrt_q64(price_q64)


def price_from_sqrt(sqrt_p: int) -> int:
    """Q64.64 sqrt price -> Q64.64 price, floor."""
    return mul_q64(sqrt_p, sqrt_p)


def one_plus_q64(x_bps: int) -> int:
    """Q64.64 of (1 + x_bps/BPS).  Requires x_bps > -BPS (factor positive)."""
    num = BPS + x_bps
    if num <= 0:
        raise FixedPointError("one_plus_q64 factor <= 0")
    return _chk_u128((num << 64) // BPS)


def sqrt_price_scaled(sqrt_p: int, x_bps: int) -> int:
    """sqrt(P * (1 + x_bps/BPS)) in Q64.64 via the two-floor path
    floor(sqrt_p * sqrt_q64(1+x) / 2**64).

    Never exceeds the single-floor value sqrt_q64(floor(price_q64 * (1+x))) and
    can trail it by at most ``sqrt_p // 2**64 + 3`` units: the floor of the
    sqrt(1+x) factor (<= 1 unit, amplified by sqrt_p / 2**64), the floor on
    sqrt_p itself (<= 1 unit scaled by sqrt(1+x)), and the final floor.
    Deterministic and identical in the Rust port; used when a bps offset is
    applied to an already-stored sqrt price (e.g. the age penalty inside
    walk_ladder) where the plain price is not available.
    """
    return mul_q64(sqrt_p, sqrt_q64(one_plus_q64(x_bps)))


def mul_bps(x: int, bps: int) -> int:
    """floor(x * bps / BPS) for non-negative x (vault-favoring when used on
    capacity or fee shares the vault pays)."""
    if x < 0 or bps < 0:
        raise FixedPointError("mul_bps negative")
    return (x * bps) // BPS


def ceil_bps(x: int, bps: int) -> int:
    """ceil(x * bps / BPS) for non-negative x (vault-favoring when the vault
    receives, e.g. trading fees)."""
    if x < 0 or bps < 0:
        raise FixedPointError("ceil_bps negative")
    p = x * bps
    return p // BPS + (1 if p % BPS else 0)
