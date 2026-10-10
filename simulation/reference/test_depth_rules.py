"""Tests for the F-idea depth rules (Spec §5.10 LVR budget, M9 vol kill-switch)."""

from __future__ import annotations

import math

from simulation.reference.quote_math import QuoteParams, depth_multiplier, lvr_depth_budget


def test_lvr_budget_quarters_when_volatility_doubles():
    one = lvr_depth_budget(revenue_per_second=1_000, gas_per_second=100,
                           sigma_short=1e-3, value=1e13, cap=1.0)
    two = lvr_depth_budget(revenue_per_second=1_000, gas_per_second=100,
                           sigma_short=2e-3, value=1e13, cap=1.0)
    assert 0 < two < one
    assert two <= one / 3.5 + 1e-9, f"doubling sigma must ~quarter: {one} -> {two}"


def test_lvr_budget_is_zero_without_net_revenue():
    assert lvr_depth_budget(revenue_per_second=100, gas_per_second=100,
                            sigma_short=1e-3, value=1e6) == 0.0
    assert lvr_depth_budget(revenue_per_second=50, gas_per_second=100,
                            sigma_short=1e-3, value=1e6) == 0.0


def test_lvr_budget_is_capped_and_full_when_calm():
    assert lvr_depth_budget(revenue_per_second=1e12, gas_per_second=0,
                            sigma_short=1e-9, value=1e6, cap=1.0) == 1.0
    assert lvr_depth_budget(revenue_per_second=1_000, gas_per_second=0,
                            sigma_short=0.0, value=1e6) == 1.0


def test_volatility_kill_switch_zeroes_depth():
    params = QuoteParams()
    depth = depth_multiplier(sigma_short=0.01, confidence=0.0, jump_flag=False,
                             depth_budget=1.0, params=params, max_vol_short=0.001)
    assert depth == 0.0
    # Below the threshold the throttle is unchanged from the neutral call.
    assert depth_multiplier(sigma_short=1e-4, confidence=0.0, jump_flag=False,
                            depth_budget=1.0, params=params, max_vol_short=0.001) > 0.0


def test_lvr_budget_caps_the_depth_throttle():
    params = QuoteParams()
    full = depth_multiplier(sigma_short=0.0, confidence=0.0, jump_flag=False,
                            depth_budget=1.0, params=params, lvr_budget=1.0)
    capped = depth_multiplier(sigma_short=0.0, confidence=0.0, jump_flag=False,
                              depth_budget=1.0, params=params, lvr_budget=0.25)
    assert capped == 0.25
    assert full > capped
    assert math.isclose(full, 1.0)
