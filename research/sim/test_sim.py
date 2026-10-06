"""Simulator tests (T1.4). Deterministic and fast; no real data required."""

from __future__ import annotations

import pytest

from research.reference.quote_math import QuoteParams
from research.sim.calibrate import walk_forward_folds
from research.sim.engine import simulate, venue_mid
from research.sim.flow import InformedFlow, NoiseFlow
from research.sim.metrics import hedged_pnl, quote_versus_fill_gap_bps
from research.sim.oracle import OracleModel
from research.sim.price_source import synthetic_series
from research.sim.venues import PassivePool, VaultVenue


def _run(venue, length: int = 600, seed: int = 7):
    prices = synthetic_series(regime="calm", length=length, seed=seed)
    return simulate(
        venue_name="test",
        venue=venue,
        prices=prices,
        oracle=OracleModel(),
        noise=NoiseFlow(seed=seed),
        informed=InformedFlow(),
    )


def test_passive_pool_buy_then_sell_never_profits():
    pool = PassivePool()
    bought = pool.fill("buy", 1_000.0)
    sold = pool.fill("sell", bought.amount_out)
    # Round-tripping through fees cannot increase value.
    assert sold.amount_out <= 1_000.0


def test_ladder_is_monotonic_after_refresh():
    venue = VaultVenue()
    venue.refresh(price=150.0, confidence=0.02, age=0.0, previous_price=149.0)
    assert venue.quote_state is not None
    asks = [level.lo for level in venue.quote_state.asks]
    bids = [level.hi for level in venue.quote_state.bids]
    assert asks == sorted(asks)
    assert bids == sorted(bids, reverse=True)


def test_simulator_is_deterministic():
    first = _run(VaultVenue())
    second = _run(VaultVenue())
    assert first.value_path == second.value_path
    assert len(first.trades) == len(second.trades)


def test_gap_is_zero_for_an_honest_fill_definition():
    assert quote_versus_fill_gap_bps(100.0, 100.0) == 0.0


def test_walk_forward_folds_do_not_overlap_in_time():
    points = synthetic_series(regime="trend", length=300, seed=1)
    folds = walk_forward_folds(points, folds=3)
    for fold in folds:
        assert fold.train[-1].second < fold.test[0].second


def test_informed_flow_requires_an_edge():
    informed = InformedFlow(fee_bps=2.0)
    assert informed.should_trade(100.0, 100.01) is None
    assert informed.should_trade(100.0, 101.0) == "buy"
    assert informed.should_trade(100.0, 99.0) == "sell"


def test_hedged_pnl_removes_directional_exposure():
    value = [100.0, 110.0]
    base = [1.0, 1.0]
    price = [100.0, 110.0]
    # Value rose exactly as much as the base holding: hedged PnL is zero.
    assert hedged_pnl(value, base, price) == pytest.approx(0.0)


def test_default_quote_params_are_valid():
    params = QuoteParams()
    assert sum(params.weights_bps) == 10_000
