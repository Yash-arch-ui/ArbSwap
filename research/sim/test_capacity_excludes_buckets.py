"""Item 3: ladder capacity must exclude the LP-excluded fee buckets.

The insurance/keeper/protocol buckets are claims on the reserves, so the ladder
must be sized from available reserves (reserve minus buckets), not the gross
reserve. This test pins that behaviour for the simulator venue.
"""

from __future__ import annotations

from research.reference.quote_math import QuoteParams
from research.sim.venues import VaultVenue


def _ask_capacity(venue: VaultVenue) -> float:
    """Base-sized ask capacity (sized from the base reserve)."""
    assert venue.quote_state is not None
    return sum(level.capacity for level in venue.quote_state.asks)


def _bid_capacity(venue: VaultVenue) -> float:
    """Quote-sized bid capacity (sized from the quote reserve)."""
    assert venue.quote_state is not None
    return sum(level.capacity for level in venue.quote_state.bids)


def test_available_reserves_net_out_the_buckets():
    venue = VaultVenue(base=1_000.0, quote=150_000.0)
    venue.fee_buckets_base = 100.0
    venue.fee_buckets_quote = 20_000.0
    assert venue.available_base == 900.0
    assert venue.available_quote == 130_000.0


def test_capacity_is_built_from_available_reserves_not_gross():
    price = 150.0
    clean = VaultVenue(base=1_000.0, quote=150_000.0, params=QuoteParams())
    clean.refresh(price=price, confidence=0.0, age=0.0, previous_price=None)

    bucketed = VaultVenue(base=1_000.0, quote=150_000.0, params=QuoteParams())
    # A large quote bucket must shrink the quote-sized bid capacity proportionally.
    bucketed.fee_buckets_quote = 75_000.0
    bucketed.refresh(price=price, confidence=0.0, age=0.0, previous_price=None)

    assert _bid_capacity(bucketed) < _bid_capacity(clean)
    # 150k - 75k = half the quote reserve -> roughly half the bid capacity.
    ratio = _bid_capacity(bucketed) / _bid_capacity(clean)
    assert 0.45 < ratio < 0.55


def test_excluding_buckets_can_never_increase_capacity():
    price = 150.0
    venue = VaultVenue(base=1_000.0, quote=150_000.0, params=QuoteParams())
    venue.refresh(price=price, confidence=0.0, age=0.0, previous_price=None)
    gross = _bid_capacity(venue)
    venue.fee_buckets_quote = 10_000.0
    venue.refresh(price=price, confidence=0.0, age=0.0, previous_price=None)
    assert _bid_capacity(venue) <= gross
