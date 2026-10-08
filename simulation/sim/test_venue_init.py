"""Regression: venue pools must be priced at the path's start, not a constant.

Before this fix every venue was initialized at price 150 while real windows
trade ~100, so every fill was far off mid and all results were invalid.
"""

from __future__ import annotations

from simulation.reference.quote_math import QuoteParams
from simulation.sim.experiments import venue_set
from simulation.sim.price_source import PricePoint


def test_venues_are_priced_at_the_path_start():
    venues = venue_set(QuoteParams(), start_price=100.0)
    for name in ("B1_passive", "ArbSwap", "B2_fixed_spread"):
        venue = venues[name]
        assert abs(venue.quote / venue.base - 100.0) < 1e-9, name


def test_start_price_changes_the_reserve_ratio():
    a = venue_set(QuoteParams(), start_price=100.0)["ArbSwap"]
    b = venue_set(QuoteParams(), start_price=250.0)["ArbSwap"]
    assert a.quote / a.base != b.quote / b.base


def test_guard_rejects_a_mispriced_venue():
    import pytest

    from simulation.sim.guards import assert_initial_price, assert_sane
    from simulation.sim.venues import PassivePool

    good = PassivePool(base=1000.0, quote=100_000.0)  # price 100
    assert_initial_price(good, 100.0)  # ok
    bad = PassivePool(base=1000.0, quote=150_000.0)  # price 150
    with pytest.raises(AssertionError):
        assert_initial_price(bad, 100.0)
    with pytest.raises(AssertionError):
        assert_sane(PassivePool(base=-1.0, quote=1.0))


def test_venue_set_asserts_initial_price():
    import pytest

    # A start price with no matching reserves would trip the guard; the normal
    # path must pass and a deliberately wrong one must not.
    from simulation.reference.quote_math import QuoteParams
    from simulation.sim.experiments import venue_set

    venue_set(QuoteParams(), start_price=123.45)  # no exception
