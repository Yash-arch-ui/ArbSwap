"""Section 5 reference tests (P1/T1.1).

These tests focus on invariants rather than hard-coded tuning outcomes. The
coefficients are heuristics and will be calibrated in T1.5; monotonicity,
capacity, rounding, and conservation are not heuristics.
"""

import math

import pytest

from research.reference.quote_math import (
    QuoteParams,
    VolatilityState,
    build_ladder,
    compute_half_spread,
    compute_quote,
    deposit_shares,
    depth_multiplier,
    directional_addon,
    first_deposit_shares,
    inventory_imbalance,
    lvr_budget_value,
    reset_flow,
    reservation_price,
    walk_ladder,
    withdrawal_amounts,
)


def test_inventory_and_reservation_price_have_expected_sign():
    q = inventory_imbalance(10.0, 900.0, 100.0)
    assert q > 0
    assert reservation_price(100.0, q, 0.05) < 100.0
    assert reservation_price(100.0, -q, 0.05) > 100.0


def test_volatility_state_tracks_short_and_medium_variance():
    state = VolatilityState().update(100.0)
    state = state.update(101.0)
    assert state.sigma_short > state.sigma_medium
    assert state.previous_price == 101.0


def test_spread_is_clamped_and_widens_for_risk():
    params = QuoteParams(spread_max=0.002)
    calm = compute_half_spread(sigma_short=0.0, inventory_q=0.0,
                               confidence=0.0, price=100.0, age=0.0,
                               jump_flag=False, params=params)
    risky = compute_half_spread(sigma_short=0.01, inventory_q=1.0,
                                confidence=1.0, price=100.0, age=100.0,
                                jump_flag=True, params=params)
    assert params.spread_min <= calm < risky <= params.spread_max


def test_directional_addon_only_widens_the_moving_side():
    assert directional_addon(110.0, 100.0, coefficient=1.0) == pytest.approx((0.1, 0.0))
    assert directional_addon(90.0, 100.0, coefficient=1.0) == pytest.approx((0.0, 0.1))


def test_ladder_is_monotonic_and_capacity_is_bounded():
    params = QuoteParams()
    asks, bids = build_ladder(price=100.0, reservation=100.0,
                              half_spread=0.001, ask_extra=0.0,
                              bid_extra=0.0, base_reserve=1_000.0,
                              quote_reserve=100_000.0, depth_mult=1.0,
                              params=params)
    assert sum(level.capacity for level in asks) == pytest.approx(500.0)
    assert sum(level.capacity for level in bids) == pytest.approx(50_000.0)
    assert all(a.hi < b.hi for a, b in zip(asks, asks[1:]))
    assert all(a.lo > b.lo for a, b in zip(bids, bids[1:]))


def test_ask_walk_stops_at_capacity_and_updates_flow():
    params = QuoteParams()
    asks, _ = build_ladder(price=100.0, reservation=100.0,
                           half_spread=0.001, ask_extra=0.0,
                           bid_extra=0.0, base_reserve=1_000.0,
                           quote_reserve=100_000.0, depth_mult=1.0,
                           params=params)
    capacity = sum(level.liquidity * (math.sqrt(level.hi) - math.sqrt(level.lo)) for level in asks)
    output, flow, consumed = walk_ladder(asks, capacity)
    assert output == pytest.approx(500.0)
    assert flow == pytest.approx(500.0)
    assert consumed == len(asks)


def test_bid_walk_returns_quote_and_decreases_flow():
    params = QuoteParams()
    _, bids = build_ladder(price=100.0, reservation=100.0,
                           half_spread=0.001, ask_extra=0.0,
                           bid_extra=0.0, base_reserve=1_000.0,
                           quote_reserve=100_000.0, depth_mult=1.0,
                           params=params)
    base_in = bids[0].liquidity * (1 / math.sqrt(bids[0].lo) - 1 / math.sqrt(bids[0].hi)) / 2
    output, flow, consumed = walk_ladder(bids, base_in)
    assert output > 0
    assert flow == pytest.approx(-base_in)
    assert consumed == 0


def test_quote_uses_throttle_and_resets_flow():
    params = QuoteParams()
    volatility = VolatilityState().update(100.0).update(101.0)
    quote = compute_quote(price=101.0, base_reserve=1_000.0,
                          quote_reserve=100_000.0, confidence=0.01,
                          age=0.0, volatility=volatility, params=params,
                          previous_price=100.0)
    assert 0 <= quote.depth_mult <= 1
    assert quote.ask_extra > 0
    assert quote.bid_extra == 0
    assert reset_flow() == 0


def test_lvr_budget_is_zero_when_cost_exceeds_revenue_and_infinite_at_zero_vol():
    assert lvr_budget_value(1.0, 2.0, 0.01) == 0
    assert math.isinf(lvr_budget_value(1.0, 0.0, 0.0))
    assert lvr_budget_value(2.0, 1.0, 0.01) == pytest.approx(80_000.0)


def test_vault_shares_round_down_and_first_deposit_burns_minimum():
    minted = first_deposit_shares(10_000, 40_000, 1_000)
    assert minted == 19_000
    assert deposit_shares(100, 100, 1_000, 2_000, 10_000) == 500
    assert withdrawal_amounts(500, 1_000, 2_000, 10_000) == (50, 100)


def test_invalid_ladder_weights_are_rejected():
    with pytest.raises(ValueError, match="sum"):
        QuoteParams(weights_bps=(1_000, 1_000, 1_000, 1_000, 1_000, 1_000))
