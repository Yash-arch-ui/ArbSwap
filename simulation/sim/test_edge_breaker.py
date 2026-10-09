"""S3.2: the simulator's realized-edge breaker mirrors the on-chain tracker."""

from __future__ import annotations

from simulation.reference.quote_math import QuoteParams
from simulation.sim.venues import VaultVenue


def _venue(max_edge_loss_bps: float = 50.0) -> VaultVenue:
    return VaultVenue(
        params=QuoteParams(),
        base=1_000.0,
        quote=100_000.0,
        edge_window_seconds=1_000.0,
        max_edge_loss_bps=max_edge_loss_bps,
    )


def test_edge_tracker_matches_the_onchain_formula():
    venue = _venue()
    venue.refresh(price=100.0, confidence=0.0, age=0.0, previous_price=None)
    fill = venue.fill("buy", 100.0, now=0.0)
    expected = 100.0 - fill.amount_out * 100.0
    assert abs(venue.realized_edge - expected) < 1e-9

    venue.refresh(price=100.0, confidence=0.0, age=0.0, previous_price=100.0)
    fill = venue.fill("sell", 1.0, now=1.0)
    expected += 1.0 * 100.0 - fill.amount_out
    assert abs(venue.realized_edge - expected) < 1e-9


def test_honest_flow_does_not_trip():
    venue = _venue()
    for t in range(20):
        venue.refresh(price=100.0, confidence=0.0, age=0.0, previous_price=100.0)
        try:
            venue.fill("buy", 50.0, now=float(t))
            venue.refresh(price=100.0, confidence=0.0, age=0.0, previous_price=100.0)
            venue.fill("sell", 0.4, now=float(t))
        except ValueError:
            pass
    assert venue.edge_trips == 0
    assert not venue.tripped


def test_stale_oracle_trips_the_breaker():
    venue = _venue(max_edge_loss_bps=5.0)
    venue.refresh(price=100.0, confidence=0.0, age=0.0, previous_price=None)
    # The stored oracle is stale/high while the ladder still prices at 100.
    venue.last_oracle_price = 200.0
    venue.fill("buy", 500.0, now=0.0)
    assert venue.tripped
    assert venue.edge_trips == 1
    # A tripped vault refuses further fills.
    try:
        venue.fill("buy", 10.0, now=1.0)
        raise AssertionError("a tripped vault must not fill")
    except ValueError:
        pass
