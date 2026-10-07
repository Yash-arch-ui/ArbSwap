"""Integration tests for the P4 analytics pipeline (Build Plan §9)."""

from __future__ import annotations

import json

import pytest

from analytics import dashboard, events, indexer, metrics
from analytics.bridge import analytics_for, events_from_simulation


def test_anchor_log_round_trips_every_event():
    lines = [
        events.encode_log("QuoteUpdated", slot=5, version=1,
                          anchor_sqrt_price=225_887_000_000_000_000_000, depth_mult_bps=9000),
        events.encode_log("SwapEvent", slot=7, version=1, side="buy",
                          amount_in=100_000, amount_out=665, fee=1_000),
        events.encode_log("SwapEvent", slot=9, version=1, side="sell",
                          amount_in=665, amount_out=99_000, fee=1_000),
        events.encode_log("DepositEvent", slot=1, shares=999, base_amount=1_000_000,
                          quote_amount=1_000_000),
        events.encode_log("RewardClaimed", keeper=bytes(range(32)), base=1, quote=2),
        "Program log: unrelated",
        "not a log line",
    ]
    parsed = events.parse_logs(lines)
    assert [type(e).__name__ for e in parsed] == [
        "QuoteUpdated", "SwapEvent", "SwapEvent", "DepositEvent", "RewardClaimed"]
    assert parsed[1].side == "buy" and parsed[1].amount_out == 665
    assert parsed[2].side == "sell"


def test_jsonl_round_trip(tmp_path):
    swaps = [
        events.SwapEvent(slot=1, version=1, side="buy", amount_in=10, amount_out=1,
                         fee=0, mid_at_fill=150.0, quoted_out=1.01),
    ]
    path = tmp_path / "events.jsonl"
    assert events.dump_jsonl(swaps, path) == 1
    loaded = events.load_jsonl(path)
    assert loaded == swaps
    assert indexer.index(loaded).swaps == loaded


def _simulated(regime: str = "crash", length: int = 900, seed: int = 5):
    from research.sim.engine import simulate
    from research.sim.flow import InformedFlow, NoiseFlow
    from research.sim.oracle import OracleModel
    from research.sim.price_source import synthetic_series
    from research.sim.venues import VaultVenue

    points = synthetic_series(regime=regime, length=length, seed=seed)
    result = simulate(
        venue_name="ArbSwap",
        venue=VaultVenue(),
        prices=points,
        oracle=OracleModel(),
        noise=NoiseFlow(seed=seed),
        informed=InformedFlow(),
        step_seconds=1.0,
    )
    return result


def test_metrics_match_the_simulator_on_the_same_run():
    """Two independent implementations of §8.3 must agree on one run."""
    from research.sim.experiments import report

    result = _simulated()
    expected = report("ArbSwap", result)
    lookup = {i: price for i, price in enumerate(result.price_path)}
    price_at = lookup.get

    swaps = events_from_simulation(result)
    assert swaps, "the run must produce fills"

    assert metrics.hedged_pnl(result.value_path, result.base_path, result.price_path) == \
        pytest.approx(expected.hedged_pnl, rel=1e-9)
    assert metrics.markout_2s(swaps, price_at) == pytest.approx(expected.markout_2s_bps, rel=1e-6)
    assert metrics.retail_half_spread_bps(swaps, price_at) == \
        pytest.approx(expected.quiet_half_spread_bps, rel=1e-6)
    assert metrics.gap_stats(swaps).notional_weighted_mean == pytest.approx(expected.gap_bps, rel=1e-6)


def test_attribution_decomposes_hedged_pnl():
    result = _simulated(regime="trend")
    swaps = events_from_simulation(result)
    lookup = {i: price for i, price in enumerate(result.price_path)}
    analytics = analytics_for(result, "ArbSwap", lookup.get)
    attr = metrics.attribution(swap_fees=100.0, keeper_gas=analytics.gas_quote,
                               hedged=analytics.hedged_pnl)
    # fees - gas - adverse = hedged, by construction.
    assert attr.fees_quote - attr.gas_quote - attr.adverse_selection_quote == \
        pytest.approx(attr.total)


def test_dashboard_renders_every_view_with_charts():
    result = _simulated()
    lookup = {i: price for i, price in enumerate(result.price_path)}
    venues = {"ArbSwap": analytics_for(result, "ArbSwap", lookup.get)}
    html = dashboard.render("test", venues, scenario="crash")
    for heading in ("LP view", "Trader view", "Risk view", "Comparison view", "Demo mode"):
        assert heading in html
    assert "<svg" in html
    assert "markout curve" in html


def test_cli_build_writes_artifacts(tmp_path):
    from analytics.__main__ import build

    payload = build(tmp_path, scenario="calm", length=600, seed=3)
    assert payload["swaps"] > 0
    events_path = tmp_path / "events.jsonl"
    assert events_path.exists()
    loaded = events.load_jsonl(events_path)
    assert len(loaded) == payload["events"]
    assert (tmp_path / "metrics.json").exists()
    html = (tmp_path / "dashboard.html").read_text()
    assert "Comparison view" in html and "<svg" in html


def test_e1_reduction_and_lvr_theory():
    assert metrics.e1_lvr_reduction(150.0, 100.0) == pytest.approx(0.5)
    assert metrics.e1_lvr_reduction(0.0, 0.0) == 0.0
    # sigma^2/8 * V * T
    assert metrics.lvr_theory(1e-4, 250_000.0, 604_800) == pytest.approx(
        1e-8 / 8 * 250_000 * 604_800)


def test_microprice_weights_by_opposite_depth():
    # Equal depth -> midpoint; skewed ask depth -> closer to the bid.
    assert metrics.microprice(99.0, 101.0, 1.0, 1.0) == pytest.approx(100.0)
    assert metrics.microprice(99.0, 101.0, 1.0, 3.0) == pytest.approx(99.5)


def test_reproduces_e1_from_indexed_events():
    """E1 computed from the analytics event pipeline equals the simulator's E1.

    `run_venues` gives every venue its own fresh oracle at the same seed, so a
    standalone `simulate` per venue reproduces it exactly; the analytics then
    has to land on the same E1.
    """
    from research.reference.quote_math import QuoteParams
    from research.sim.engine import simulate
    from research.sim.experiments import e1_lvr_reduction as simulator_e1
    from research.sim.experiments import run_venues
    from research.sim.flow import InformedFlow, NoiseFlow
    from research.sim.oracle import OracleModel
    from research.sim.price_source import synthetic_series
    from research.sim.venues import PassivePool, VaultVenue

    points = synthetic_series(regime="crash", length=900, seed=5)
    reports = run_venues(points, params=QuoteParams(), seed=5, step_seconds=1.0)
    lookup = {i: p.price for i, p in enumerate(points)}

    def analytics_for_venue(venue, name):
        result = simulate(
            venue_name=name,
            venue=venue,
            prices=points,
            oracle=OracleModel(),
            noise=NoiseFlow(seed=5),
            informed=InformedFlow(),
            step_seconds=1.0,
            seed=5,
        )
        return analytics_for(result, name, lookup.get)

    arb = analytics_for_venue(VaultVenue(), "ArbSwap")
    b1 = analytics_for_venue(PassivePool(fee=0.0001), "B1_passive")
    assert metrics.e1_lvr_reduction(arb.hedged_pnl, b1.hedged_pnl) == pytest.approx(
        simulator_e1(reports), rel=1e-6)
