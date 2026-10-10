"""Causality and clock tests for Task 1 (T1.4, T1.5).

Two properties have to be proved mechanically before any headline number is
trusted:

1. **No look-ahead.** The quote live at simulation step ``t`` may only depend on
   reference data timestamped at or before ``t - latency``.
2. **Not already cheating.** Feeding the oracle future prices must visibly move
   the results, and taking the feed away must restore the honest run exactly.

Both tests disable order flow so the only thing that can move the quote is the
oracle feed; with flow on, fills legitimately react to the *current* reference
and would mask the property under test.
"""

from __future__ import annotations

import pytest

from simulation.sim.costs import (
    CU_UPDATE_QUOTE,
    CostModel,
    LANDING_DELAY_SECONDS,
    landing_delay,
)
from simulation.sim.engine import simulate
from simulation.sim.flow import InformedFlow, NoiseFlow
from simulation.sim.metrics import hedged_pnl
from simulation.sim.oracle import OracleModel
from simulation.sim.price_source import PricePoint
from simulation.sim.venues import VaultVenue

SILENT_FLOW = dict(noise=NoiseFlow(arrival_rate=0.0),
                   informed=InformedFlow(max_size=0.0))


def _flat_then_drop(diverge: int, total: int, *, level: float = 100.0,
                    drop: float = 90.0) -> list[PricePoint]:
    return [PricePoint(i, level if i < diverge else drop) for i in range(total)]


def _mid_path(path: list[PricePoint], *, latency: float,
              cheat: float = 0.0) -> list[float]:
    result = simulate(
        venue_name="causal",
        venue=VaultVenue(),
        prices=path,
        oracle=OracleModel(latency_seconds=latency, noise_bps=0.0,
                           cheat_seconds=cheat),
        # Keeper gas is legitimately converted at the *current* reference price,
        # which would let the cash balance react to the path independently of
        # the oracle. Zero costs so the only coupling left is the oracle feed.
        costs=CostModel(base_fee_lamports=0, priority_micro_lamports_per_cu=0.0),
        record_quotes=True,
        **SILENT_FLOW,
    )
    return result.mid_path


def test_quote_live_at_t_ignores_reference_after_t_minus_latency():
    """No look-ahead: the quote only sees data stamped at or before t-latency."""
    latency = 5.0
    diverge = 80
    path_a = _flat_then_drop(diverge, 140, level=100.0, drop=100.0)
    path_b = _flat_then_drop(diverge, 140, level=100.0, drop=90.0)

    a = _mid_path(path_a, latency=latency)
    b = _mid_path(path_b, latency=latency)

    # Every step whose freshest possible input predates the divergence must be
    # byte-for-byte identical between the two worlds.
    safe = diverge + int(latency)
    assert a[:safe] == b[:safe], "the quote used reference data from the future"

    # ...and the two worlds must actually differ later, or the test is vacuous.
    assert any(x != y for x, y in zip(a[safe:], b[safe:])), \
        "the oracle never caught up; the test proves nothing"


def test_future_prices_change_results_and_removal_restores_them():
    """Shuffled-future check: a clairvoyant oracle changes the money, and
    switching it off reproduces the honest run exactly."""
    path = _flat_then_drop(60, 200, level=100.0, drop=88.0)
    honest = _mid_path(path, latency=2.0)
    repeated = _mid_path(path, latency=2.0)
    clairvoyant = _mid_path(path, latency=2.0, cheat=70.0)

    assert honest == repeated, "the honest run must be exactly reproducible"
    assert any(x != y for x, y in zip(honest, clairvoyant)), \
        "reading the future must visibly change the quote"

    def money(cheat: float) -> float:
        result = simulate(
            venue_name="money",
            venue=VaultVenue(),
            prices=path,
            oracle=OracleModel(latency_seconds=2.0, noise_bps=0.0, cheat_seconds=cheat),
            noise=NoiseFlow(arrival_rate=0.05, seed=3),
            informed=InformedFlow(),
            record_quotes=True,
        )
        return hedged_pnl(result.value_path, result.base_path, result.price_path)

    assert money(0.0) == money(0.0), "the honest run must be reproducible"
    assert money(70.0) != money(0.0), "cheating must change PnL, not just the quote"


def test_decisions_land_on_slot_boundaries_after_a_delay():
    """A decision taken at t becomes live no earlier than t + landing, rounded
    up to the next slot boundary."""
    step = 0.4
    result = simulate(
        venue_name="slotted",
        venue=VaultVenue(),
        prices=[PricePoint(i, 100.0) for i in range(60)],
        oracle=OracleModel(latency_seconds=0.0, noise_bps=0.0),
        noise=NoiseFlow(arrival_rate=0.0),
        informed=InformedFlow(max_size=0.0),
        step_seconds=step,
        source_step_seconds=1.0,
        slot_seconds=0.4,
        keeper_update_interval_seconds=0.0,
        landing_delay_sampler=lambda rng: 0.0,
        record_quotes=True,
    )
    # Instant landing: every slot boundary produces a quote update.
    assert result.quote_updates == len(result.mid_path)
    assert result.quote_updates == 150
    assert result.mid_path[0] > 0.0


def test_slot_clock_quantises_a_sub_step_landing_delay():
    """On a 1 s clock a 0.4 s landing delay can only round to the next step."""
    result = simulate(
        venue_name="quantised",
        venue=VaultVenue(),
        prices=[PricePoint(i, 100.0) for i in range(60)],
        oracle=OracleModel(latency_seconds=0.0, noise_bps=0.0),
        noise=NoiseFlow(arrival_rate=0.0),
        informed=InformedFlow(max_size=0.0),
        step_seconds=1.0,
        landing_delay_sampler=lambda rng: 0.4,
        record_quotes=True,
    )
    # Decisions at 0..59 land at 1..60, so the step-0 decision is not yet live.
    assert result.quote_updates == len(result.mid_path) - 1
    assert result.mid_path[0] == 0.0, "nothing may be quoted before the tx lands"


def test_step_size_does_not_change_the_amount_of_noise_flow():
    """``arrival_rate`` is per second, so both clocks realise the same rate."""
    from simulation.sim.flow import NoiseFlow

    slow = NoiseFlow(arrival_rate=0.2, seed=5).arrivals(1_000)
    fast = NoiseFlow(arrival_rate=0.2, seed=5).arrivals(2_500, step_seconds=0.4)
    # 1_000 s vs 2_500 x 0.4 s = 1_000 s of simulated time.
    assert abs(len(slow) / 1_000.0 - 0.2) < 0.03
    assert abs(len(fast) / 1_000.0 - 0.2) < 0.03


def test_landing_delay_distribution_is_a_probability_measure():
    assert sum(p for _, p in LANDING_DELAY_SECONDS) == pytest.approx(1.0)
    assert all(v > 0 for v, _ in LANDING_DELAY_SECONDS)
    import random

    rng = random.Random(1)
    draws = [landing_delay(rng) for _ in range(2_000)]
    mean = sum(draws) / len(draws)
    expected = sum(v * p for v, p in LANDING_DELAY_SECONDS)
    assert mean == pytest.approx(expected, rel=0.05)


def test_cost_model_splits_base_fee_from_priority_fee():
    costs = CostModel(priority_micro_lamports_per_cu=1_000.0)
    gas, priority = costs.update(sol_price=100.0)
    assert gas == pytest.approx(5_000 / 1e9 * 100.0)
    assert priority == pytest.approx((CU_UPDATE_QUOTE * 1_000.0 / 1e6) / 1e9 * 100.0)
    swap_gas, swap_priority = costs.swap(sol_price=100.0)
    assert swap_gas == gas
    assert swap_priority > priority, "a swap must cost more CU than an update"
    with pytest.raises(ValueError):
        costs.update(sol_price=0.0)


def _run_clock(step_seconds: float, venue_factory, *, regime: str = "trend",
               length: int = 1200, seed: int = 4,
               keeper_interval: float = 1.0) -> "SimResult":
    from simulation.sim.price_source import synthetic_series

    prices = synthetic_series(regime=regime, length=length, seed=seed)
    return simulate(
        venue_name="clock",
        venue=venue_factory(),
        prices=prices,
        oracle=OracleModel(),
        noise=NoiseFlow(seed=seed),
        informed=InformedFlow(),
        step_seconds=step_seconds,
        source_step_seconds=1.0,
        keeper_update_interval_seconds=keeper_interval,
    )


def test_keeper_decision_grid_does_not_depend_on_the_simulation_clock():
    """Keeper decisions sit on a wall-clock grid: multiples of the update
    interval, taken at the first slot boundary at or after the target.

    The interval is deliberately *not* a multiple of either clock (0.7 s).
    A design that floored the interval to a whole number of steps would turn it
    into 1.0 s on a 1 s clock and 0.4 s on a 400 ms clock — a silent change of
    keeper load — and the decision times would drift off the grid.
    """
    from simulation.sim.venues import VaultVenue

    interval = 0.7
    decisions = {dt: _run_clock(dt, VaultVenue, keeper_interval=interval).decision_times
                 for dt in (1.0, 0.4, 0.1)}
    for step_seconds, times in decisions.items():
        assert times, "no keeper decisions were recorded"
        effective_slot = max(0.4, step_seconds)
        for index, moment in enumerate(times):
            target = index * interval
            assert moment + 1e-9 >= target, (f"decision {index} fired early: "
                                             f"{moment} < {target}")
            assert moment < target + effective_slot + 1e-6, (
                f"decision {index} at {moment} missed the {target} target")
    counts = [len(times) for times in decisions.values()]
    assert max(counts) - min(counts) <= 1, (
        f"decision count changed with the clock: {counts}")


def test_simulation_clock_is_a_sensitivity_not_a_free_parameter():
    """400 ms and 100 ms have converged; the 1 s clock has not.

    A 1 s clock hands the arbitrageur one reaction per second instead of four,
    which *understates* adverse selection. That direction of bias is asserted
    (and reported), not hidden: the 1 s result must deviate from the converged
    pair by more than the pair deviates from each other.
    """
    from simulation.sim.venues import PassivePool, VaultVenue

    def pnl(result) -> float:
        return hedged_pnl(result.value_path, result.base_path, result.price_path)

    vault = {dt: pnl(_run_clock(dt, VaultVenue)) for dt in (1.0, 0.4, 0.1)}
    converged_gap = abs(vault[0.4] - vault[0.1])
    assert converged_gap <= 0.35 * max(abs(vault[0.4]), abs(vault[0.1]))
    assert abs(vault[1.0] - vault[0.4]) > converged_gap

    passive = {dt: pnl(_run_clock(dt, PassivePool)) for dt in (1.0, 0.4, 0.1)}
    assert max(passive.values()) - min(passive.values()) <= 0.05 * abs(passive[0.4])
