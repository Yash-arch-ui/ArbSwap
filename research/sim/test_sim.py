"""Simulator tests (T1.4). Deterministic and fast; no real data required."""

from __future__ import annotations

import pytest

from research.reference.quote_math import QuoteParams
from research.sim.calibrate import walk_forward_folds
from research.sim.engine import simulate, venue_mid
from research.sim.flow import InformedFlow, NoiseFlow
from research.sim.metrics import (
    hedged_pnl,
    notional_weighted_markout,
    quote_versus_fill_gap_bps,
)
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


def test_ladder_capacity_is_spent_once_per_quote_window():
    """A fill must remove its capacity from the displayed ladder.

    Otherwise every fill inside one ``update_quote`` window re-walks the original
    ladder and a fast arbitrageur drains the vault many times over between two
    keeper updates — the bug showed up as a 3x turnover blow-up on a 100 ms
    clock.
    """
    from research.sim.venues import HonestyRejected

    venue = VaultVenue(honest_enabled=False)
    venue.refresh(price=150.0, confidence=0.02, age=0.0, previous_price=150.0)
    paid_out = 0.0
    for _ in range(50):
        try:
            fill = venue.fill("buy", 5_000.0)
        except (ValueError, HonestyRejected):
            break
        paid_out += fill.amount_out
    # depth 1.0 x utilization 0.5 x 1,000 base reserve = 500 base of ask depth.
    assert 0.0 < paid_out <= 500.0 * (1 + 1e-9)
    assert venue.base >= 0.0
    assert venue.quote >= 0.0


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


def _sim(venue, regime: str, length: int = 600, seed: int = 11, noise=None,
         latency: int = 1):
    prices = synthetic_series(regime=regime, length=length, seed=seed)
    return simulate(
        venue_name="test",
        venue=venue,
        prices=prices,
        oracle=OracleModel(latency_seconds=latency),
        noise=noise or NoiseFlow(seed=seed),
        informed=InformedFlow(),
    )


def _hedged(result) -> float:
    return hedged_pnl(result.value_path, result.base_path, result.price_path)


def test_passive_pool_is_picked_off_by_a_price_step():
    """Deterministic mechanism check: when the reference steps down, a passive
    pool is arbitraged at the stale price and loses, while a latency-free
    oracle-anchored vault has already repriced and does not."""
    from research.sim.price_source import PricePoint

    path = (
        [PricePoint(i, 100.0) for i in range(200)]
        + [PricePoint(i, 95.0) for i in range(200, 320)]
    )
    flow = NoiseFlow(arrival_rate=0.0, seed=5)
    passive = simulate(
        venue_name="B1", venue=PassivePool(), prices=path,
        oracle=OracleModel(latency_seconds=0), noise=flow, informed=InformedFlow(),
    )
    fresh = simulate(
        venue_name="B3", venue=VaultVenue(), prices=path,
        oracle=OracleModel(latency_seconds=0), noise=flow, informed=InformedFlow(),
    )
    assert _hedged(passive) < 0, "a passive pool must lose to a price step"
    assert _hedged(passive) < _hedged(fresh), "repricing must avoid the loss"


def test_passive_pool_loses_more_as_volatility_rises():
    """LVR grows with volatility: the passive pool's hedged PnL must be worse
    in a crash than in calm, with the same flow."""
    quiet_flow = NoiseFlow(arrival_rate=0.0, seed=5)
    calm = _sim(PassivePool(), "calm", length=800, noise=quiet_flow)
    crash = _sim(PassivePool(), "crash", length=800, noise=quiet_flow)
    assert _hedged(crash) < _hedged(calm), "higher vol must cost the passive pool more"


def test_oracle_latency_creates_adverse_selection():
    """A lagged oracle exposes the vault to arbitrage; a fresh one does not.

    On a *crashing* path the stale quote is picked off far more often and the
    vault keeps less value after hedging. Calm paths are barely affected — the
    per-regime asymmetry is reported in ``docs/P1_RESULTS.md``, not hidden.
    """
    fresh = _sim(VaultVenue(), "crash", latency=0)
    lagged = _sim(VaultVenue(), "crash", latency=8)
    assert len(lagged.trades) > len(fresh.trades), "stale quotes must be picked off more often"
    assert _hedged(lagged) < _hedged(fresh), "stale quotes must cost the vault value"


def test_oracle_never_exposes_the_current_reference_price():
    from research.sim.price_source import PricePoint

    oracle = OracleModel(latency_seconds=1, noise_bps=0.0)
    first = oracle.observe(PricePoint(0, 100.0))
    second = oracle.observe(PricePoint(1, 110.0))
    assert first.oracle_price == 100.0
    assert second.oracle_price == 100.0
    assert second.oracle_price != second.reference_price


def test_keeper_interval_limits_quote_updates():
    prices = synthetic_series(regime="trend", length=80, seed=9)
    result = simulate(
        venue_name="delayed",
        venue=VaultVenue(),
        prices=prices,
        oracle=OracleModel(),
        noise=NoiseFlow(arrival_rate=0.0),
        informed=InformedFlow(),
        keeper_update_interval_seconds=4,
        seed=1,
    )
    assert result.quote_updates < len(prices), "a slow keeper must quote less often"
    assert result.quote_updates >= len(prices) // 5, "the keeper must still be quoting"


def test_keeper_costs_use_measured_cu_at_the_reference_sol_price():
    """Gas and priority are derived from the LiteSVM CU measurements, not typed
    in as magic numbers, and converted to USDC at the reference SOL price."""
    from research.sim.costs import CostModel
    from research.sim.price_source import PricePoint

    flat = [PricePoint(i, 100.0) for i in range(30)]
    costs = CostModel(priority_micro_lamports_per_cu=1_000.0)
    result = simulate(
        venue_name="costed",
        venue=VaultVenue(),
        prices=flat,
        oracle=OracleModel(latency_seconds=0.0, noise_bps=0.0),
        noise=NoiseFlow(arrival_rate=0.0),
        informed=InformedFlow(max_size=0.0),
        costs=costs,
        seed=1,
    )
    assert result.quote_updates > 0
    gas_each = 5_000 / 1_000_000_000 * 100.0
    priority_each = (12_802 * 1_000.0 / 1_000_000.0) / 1_000_000_000 * 100.0
    assert result.update_gas_quote == pytest.approx(result.quote_updates * gas_each)
    assert result.update_priority_quote == pytest.approx(result.quote_updates * priority_each)
    assert result.update_cost_quote == pytest.approx(
        result.update_gas_quote + result.update_priority_quote)
    # Nothing traded, so no swap transaction was signed.
    assert result.swap_cost_quote == pytest.approx(0.0)


def test_markouts_are_recorded_on_the_simulation_clock():
    """Guard against the regression where trades carried absolute seconds and
    every markout silently evaluated to zero."""
    result = _sim(PassivePool(), "crash", length=600)
    lookup = {i: p for i, p in enumerate(result.price_path)}.get
    markout = notional_weighted_markout(result.trades, 2, lookup)
    assert markout != 0.0


def test_run_venues_gives_every_venue_its_own_fresh_oracle():
    """A shared OracleModel is stateful: handing one instance to five venues
    gives each a different stretch of the noise stream and breaks the paired
    comparison. ArbSwap must match a standalone run with its own oracle."""
    from research.sim.experiments import RunConfig, run_venues

    prices = synthetic_series(regime="crash", length=400, seed=7)
    config = RunConfig()
    reports = run_venues(prices, params=QuoteParams(), config=config)

    direct = simulate(
        venue_name="ArbSwap",
        venue=VaultVenue(params=QuoteParams(), fee_bps=1.0),
        prices=prices,
        oracle=OracleModel(),
        noise=NoiseFlow(seed=config.seed),
        informed=InformedFlow(),
        **config.simulate_kwargs(),
    )
    expected = hedged_pnl(direct.value_path, direct.base_path, direct.price_path)
    assert reports["ArbSwap"].hedged_pnl == pytest.approx(expected)
    assert reports["ArbSwap"].trades == len(direct.trades)


def test_run_venues_uses_an_oracle_template_without_mutating_it():
    from research.sim.experiments import run_venues

    prices = synthetic_series(regime="calm", length=200, seed=7)
    template = OracleModel(latency_seconds=0.5, noise_bps=4.0)
    first = run_venues(prices, params=QuoteParams(), oracle=template)
    assert template.latency_seconds == 0.5 and template.noise_bps == 4.0
    second = run_venues(prices, params=QuoteParams(), oracle=template)
    assert first["ArbSwap"].hedged_pnl == pytest.approx(second["ArbSwap"].hedged_pnl)
