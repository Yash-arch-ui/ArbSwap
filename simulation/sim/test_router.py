"""T2 router tests: best-price routing, exclusion of worse-priced venues for
price-sensitive flow, and order-count conservation."""

from __future__ import annotations

from simulation.sim.flow import NoiseFlow
from simulation.sim.flow_config import NOISE_ARRIVAL_RATE, NOISE_MEAN_SIZE
from simulation.sim.price_source import synthetic_series
from simulation.sim.router import route_window


def _prices():
    return synthetic_series(regime="calm", length=1_200, seed=20261006)


def test_routing_prefers_the_best_price():
    # propAMM at 0.3 bp vs B1 at 30 bp -> price-sensitive flow goes to propAMM.
    rows = {r["venue"]: r for r in route_window(
        _prices(), prop_hs=0.3, b1_fee=30.0, insensitive_share=0.0, informed_enabled=False)}
    assert rows["PropAMM"]["volume_share"] > 0.9


def test_worse_priced_venue_gets_no_price_sensitive_flow():
    rows = {r["venue"]: r for r in route_window(
        _prices(), prop_hs=0.3, b1_fee=30.0, insensitive_share=0.0, informed_enabled=False)}
    assert rows["B1_passive"]["volume_share"] < 0.05


def test_order_count_is_conserved():
    prices = _prices()
    rows = route_window(prices, insensitive_share=0.0, informed_enabled=False)
    routed = sum(r["orders"] for r in rows)
    arrivals = len(NoiseFlow(seed=20261006, arrival_rate=NOISE_ARRIVAL_RATE,
                             mean_size=NOISE_MEAN_SIZE).arrivals(len(prices), step_seconds=1.0))
    assert routed == arrivals


def test_price_insensitive_share_reaches_the_designated_venue():
    rows = {r["venue"]: r for r in route_window(
        _prices(), prop_hs=0.3, b1_fee=30.0, insensitive_share=1.0, informed_enabled=False)}
    assert rows["B1_passive"]["volume_share"] > 0.9
