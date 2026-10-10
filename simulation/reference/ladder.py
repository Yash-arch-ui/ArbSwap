"""Integer Q64.64 ladder walk (T1.2 source of truth).

Mirrors `vault/math/src/quote.rs` bit-for-bit. All quantities are exact
integers; floating point must never appear here, because these functions
produce the golden vectors the Rust port is checked against.

Scaling (see docs/FORMULA.md §6-7):
- ``sqrt_lo``, ``sqrt_hi`` are Q64.64 square-root prices, ``sqrt_lo < sqrt_hi``.
- ``liquidity`` is the integer ``L_int = L_real * 2**64``.
- A full ask level consumes ``floor(L*(hi-lo)/2**128)`` quote and releases
  ``floor(floor(L*(hi-lo)/lo)/hi)`` base; the bid side is symmetric.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Literal

from simulation.reference.fixed import FixedPointError, isqrt

Q64 = 1 << 64
BPS = 10_000
Side = Literal["ask", "bid"]


@dataclass(frozen=True)
class Level:
    sqrt_lo: int
    sqrt_hi: int
    liquidity: int

    def delta_sqrt(self) -> int:
        if self.sqrt_lo <= 0 or self.sqrt_lo >= self.sqrt_hi or self.liquidity <= 0:
            raise FixedPointError("invalid level")
        return self.sqrt_hi - self.sqrt_lo

    def base_capacity(self) -> int:
        """Base the vault pays out (ask) / receives (bid) for a full segment.

        Floors, which is vault-favoured: the vault never pays out more base and
        needs at least this much base to fill a bid fully.
        """
        delta = self.delta_sqrt()
        return (self.liquidity * delta // self.sqrt_lo) // self.sqrt_hi

    def quote_capacity(self) -> int:
        """Quote the vault pays out (bid) / receives (ask) for a full segment.

        Floors, which is vault-favoured when the vault pays quote.
        """
        return self.liquidity * self.delta_sqrt() >> 128

    def max_input(self, side: Side) -> int:
        """Largest input that is still within the segment.

        Ceils so a full fill is only granted once the trader has supplied at
        least the exact amount; this is the safe direction for the vault.
        """
        delta = self.delta_sqrt()
        if side == "ask":
            return _ceil_div(self.liquidity * delta, 1 << 128)
        return _ceil_div(self.liquidity * delta, self.sqrt_lo * self.sqrt_hi)


def _ceil_div(numerator: int, denominator: int) -> int:
    if denominator <= 0:
        raise FixedPointError("zero denominator")
    return -((-numerator) // denominator)


def liquidity_for_base_capacity(sqrt_lo: int, sqrt_hi: int, capacity: int) -> int:
    """Ask-side liquidity implied by a base capacity."""
    delta = sqrt_hi - sqrt_lo
    if sqrt_lo <= 0 or delta <= 0 or capacity < 0:
        raise FixedPointError("invalid liquidity derivation")
    return capacity * sqrt_lo * sqrt_hi // delta


@dataclass(frozen=True)
class SwapResult:
    out: int
    consumed: int
    remaining: int


def _ask_partial(level: Level, quote_in: int) -> int:
    delta = quote_in * (1 << 128) // level.liquidity
    if delta > level.delta_sqrt():
        raise FixedPointError("ask input exceeds segment")
    sqrt_p = level.sqrt_lo + delta
    return (level.liquidity * delta // level.sqrt_lo) // sqrt_p


def _bid_partial(level: Level, base_in: int) -> int:
    denominator = level.liquidity + base_in * level.sqrt_hi
    if denominator == 0:
        raise FixedPointError("bid denominator zero")
    # Round the intermediate price UP so the vault pays out no more quote than
    # the exact amount: paying quote must floor.
    sqrt_p = _ceil_div(level.sqrt_hi * level.liquidity, denominator)
    if sqrt_p > level.sqrt_hi:
        raise FixedPointError("bid output price above segment top")
    if sqrt_p == level.sqrt_hi:
        return 0
    # dy = L_int*(hi - p) / 2^128 (quote atoms), matching `quote_capacity`.
    return level.liquidity * (level.sqrt_hi - sqrt_p) >> 128


def walk_ladder(levels: Iterable[Level], side: Side, amount_in: int) -> SwapResult:
    """Walk the ladder; consume levels outward until input is exhausted."""
    if amount_in < 0:
        raise FixedPointError("negative input")
    out = 0
    remaining = amount_in
    consumed = 0
    for level in levels:
        if remaining == 0:
            break
        max_in = level.max_input(side)
        if remaining >= max_in:
            out += level.base_capacity() if side == "ask" else level.quote_capacity()
            remaining -= max_in
            consumed += 1
        else:
            out += _ask_partial(level, remaining) if side == "ask" \
                else _bid_partial(level, remaining)
            remaining = 0
    return SwapResult(out, consumed, remaining)


def mean_price_q64(quote_amount: int, base_amount: int) -> int:
    if base_amount <= 0:
        raise FixedPointError("zero base")
    return (quote_amount << 64) // base_amount


def first_deposit_shares(deposit_base: int, deposit_quote: int, min_liquidity: int) -> int:
    if deposit_base <= 0 or deposit_quote <= 0:
        raise FixedPointError("invalid first deposit")
    root = isqrt(deposit_base * deposit_quote)
    if root <= min_liquidity:
        raise FixedPointError("deposit does not cover minimum liquidity")
    return root - min_liquidity


def deposit_shares(deposit_base: int, deposit_quote: int, reserve_base: int,
                   reserve_quote: int, total_shares: int) -> int:
    if min(reserve_base, reserve_quote, total_shares) <= 0:
        raise FixedPointError("invalid deposit state")
    return min(deposit_base * total_shares // reserve_base,
               deposit_quote * total_shares // reserve_quote)


def withdrawal_amounts(shares: int, reserve_base: int, reserve_quote: int,
                       total_shares: int) -> tuple[int, int]:
    if total_shares <= 0 or not 0 <= shares <= total_shares:
        raise FixedPointError("invalid withdrawal state")
    return (shares * reserve_base // total_shares,
            shares * reserve_quote // total_shares)


def fee_amount(amount_in: int, fee_bps: int) -> int:
    if amount_in < 0 or fee_bps < 0:
        raise FixedPointError("negative fee input")
    product = amount_in * fee_bps
    return product // BPS + (1 if product % BPS else 0)
