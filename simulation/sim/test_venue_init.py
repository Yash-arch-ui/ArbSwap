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
