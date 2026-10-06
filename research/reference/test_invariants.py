"""Tough invariant and adversarial tests for the Section 5 core (P1).

These are the tests that matter for safety: they assert properties that must
hold for *every* input, not just the golden vectors. If one of these fails the
pipeline is exploitable, so they use many deterministic random samples.
"""

from __future__ import annotations

import random
from fractions import Fraction

import pytest

from research.reference.fixed import (
    FixedPointError,
    Q64,
    ceil_bps,
    mul_bps,
    price_from_sqrt,
    recip_q64,
    sqrt_q64,
)
from research.reference.ladder import (
    Level,
    deposit_shares,
    fee_amount,
    first_deposit_shares,
    mean_price_q64,
    walk_ladder,
    withdrawal_amounts,
)
from research.reference.quote_math import (
    QuoteParams,
    age_penalty,
    oracle_update_allowed,
    quote_expired,
)


def _random_level(rng: random.Random) -> Level:
    price = rng.uniform(20.0, 400.0)
    lo = sqrt_q64(int(price * Q64))
    hi = lo + rng.randint(Q64 // 100, Q64)
    return Level(lo, hi, rng.randint(10**18, 10**24))


def test_ask_output_is_monotonic_and_capacity_bounded():
    rng = random.Random(1)
    for _ in range(300):
        level = _random_level(rng)
        cap = level.base_capacity()
        previous = -1
        for step in range(1, 11):
            amount = level.quote_capacity() * step // 10
            out = walk_ladder([level], "ask", amount).out
            assert out >= previous, "ask output must be non-decreasing in input"
            assert out <= cap + 1, "ask output must never exceed capacity"
            previous = out


def test_bid_output_is_monotonic_and_capacity_bounded():
    rng = random.Random(2)
    for _ in range(300):
        level = _random_level(rng)
        cap = level.quote_capacity()
        previous = -1
        for step in range(1, 11):
            amount = level.base_capacity() * step // 10
            out = walk_ladder([level], "bid", amount).out
            assert out >= previous, "bid output must be non-decreasing in input"
            assert out <= cap + 1, "bid output must never exceed capacity"
            previous = out


def test_buying_then_selling_never_creates_money():
    """A round trip across a proper two-sided ladder cannot turn a profit.

    The vault's ask range sits above the mid and the bid range below it, so
    buying from the ask and selling into the bid must lose (rounded down in the
    vault's favour).
    """
    rng = random.Random(3)
    for _ in range(300):
        mid = sqrt_q64(int(rng.uniform(20.0, 400.0) * Q64))
        width = rng.randint(Q64 // 100, Q64 // 10)
        liquidity = rng.randint(10**18, 10**22)
        ask = Level(mid, mid + width, liquidity)
        bid = Level(mid - width, mid, liquidity)
        quote_in = rng.randint(1, max(1, ask.quote_capacity()))
        bought = walk_ladder([ask], "ask", quote_in).out
        if bought == 0:
            continue
        back = walk_ladder([bid], "bid", bought).out
        assert back <= quote_in, "round trip must not create quote"


def test_execution_price_stays_inside_the_level():
    rng = random.Random(4)
    for _ in range(300):
        level = _random_level(rng)
        # Use amounts large enough that the floored base output is meaningful.
        amount = rng.randint(level.quote_capacity() // 2, level.quote_capacity())
        delta = amount * (1 << 128) // level.liquidity
        if delta == 0 or delta > level.delta_sqrt():
            continue
        price_point = level.sqrt_lo + delta
        exact_base = Fraction(level.liquidity * delta, level.sqrt_lo * price_point)
        out = walk_ladder([level], "ask", amount).out
        assert out <= exact_base, "the vault must never pay out more base than exact"
        # The *exact* execution price is between the level bounds.
        exact_price = Fraction(amount, exact_base)
        lower = Fraction(level.sqrt_lo * level.sqrt_lo, 1 << 64)
        upper = Fraction(level.sqrt_hi * level.sqrt_hi, 1 << 64)
        exact_price_q64 = exact_price * (1 << 64)
        assert lower <= exact_price_q64 <= upper


def test_walk_reports_remaining_when_capacity_is_exhausted():
    rng = random.Random(5)
    for _ in range(100):
        level = _random_level(rng)
        max_in = level.max_input("ask")
        if max_in == 0:
            continue
        result = walk_ladder([level], "ask", max_in * 3 + 1)
        assert result.remaining > 0
        assert result.out == level.base_capacity()


def test_fee_always_rounds_in_the_vault_favour():
    rng = random.Random(6)
    for _ in range(1_000):
        amount = rng.randint(0, 10**18)
        bps = rng.randint(0, 10_000)
        fee = fee_amount(amount, bps)
        exact = amount * bps
        assert fee * 10_000 >= exact  # ceil
        assert (fee - 1) * 10_000 < exact  # minimal


def test_bps_rounding_directions_are_opposite():
    rng = random.Random(7)
    for _ in range(1_000):
        x = rng.randint(0, (1 << 110))
        bps = rng.randint(0, 10_000)
        assert mul_bps(x, bps) * 10_000 <= x * bps
        assert ceil_bps(x, bps) * 10_000 >= x * bps
        assert ceil_bps(x, bps) - mul_bps(x, bps) <= 1


def test_deposit_then_full_withdraw_never_profits():
    rng = random.Random(8)
    for _ in range(300):
        reserve_base = rng.randint(10**6, 10**15)
        reserve_quote = rng.randint(10**9, 10**18)
        total_shares = rng.randint(10**6, 10**15)
        db = rng.randint(1, reserve_base)
        dq = rng.randint(1, reserve_quote)
        minted = deposit_shares(db, dq, reserve_base, reserve_quote, total_shares)
        if minted == 0:
            continue
        out_b, out_q = withdrawal_amounts(
            minted, reserve_base + db, reserve_quote + dq, total_shares + minted
        )
        assert out_b <= db and out_q <= dq, "deposit/withdraw round trip must not create value"


def test_donation_cannot_mint_free_shares():
    """Inflating reserves by donation must never increase the shares a later
    depositor receives per unit deposited."""
    rng = random.Random(9)
    for _ in range(200):
        reserve_base = rng.randint(10**6, 10**14)
        reserve_quote = rng.randint(10**9, 10**17)
        total_shares = rng.randint(10**6, 10**14)
        db, dq = rng.randint(1, 10**12), rng.randint(1, 10**15)
        honest = deposit_shares(db, dq, reserve_base, reserve_quote, total_shares)
        donated = deposit_shares(db, dq, reserve_base * 2, reserve_quote * 2, total_shares)
        assert donated <= honest, "a larger reserve must not yield more shares"


def test_first_deposit_requires_minimum_liquidity():
    with pytest.raises(FixedPointError):
        first_deposit_shares(10, 10, 10)  # sqrt(100) - 10 == 0


def test_recip_roundtrip_error_is_bounded():
    rng = random.Random(10)
    for _ in range(500):
        s = rng.randint(2, (1 << 100))
        r = recip_q64(s)
        assert s * r <= (1 << 128) < s * (r + 1)


def test_oracle_guards_reject_stale_wide_and_jumpy_updates():
    params = QuoteParams()
    assert oracle_update_allowed(staleness=0.0, confidence_ratio=0.0001, anchor_step=0.0, params=params)
    assert not oracle_update_allowed(staleness=3.0, confidence_ratio=0.0, anchor_step=0.0, params=params)
    assert not oracle_update_allowed(staleness=0.0, confidence_ratio=0.5, anchor_step=0.0, params=params)
    assert not oracle_update_allowed(staleness=0.0, confidence_ratio=0.0, anchor_step=0.2, params=params)


def test_expiry_and_age_penalty_are_monotonic():
    params = QuoteParams()
    assert not quote_expired(params.grace_slots, params)
    assert quote_expired(params.expiry_slots, params)
    assert age_penalty(params.grace_slots, params) == 0.0
    assert age_penalty(params.grace_slots + 5, params) > 0.0
