"""Calibration protocol tests (Task 1.5, pre-registration amendment)."""

from __future__ import annotations

from simulation.sim.calibrate import (
    INVENTORY_COEFFS,
    SIGMA_TARGETS,
    SPREAD_FLOORS,
    VOLATILITY_COEFFS,
    calibrate_blocks,
    grid_candidates,
    objective,
)
from simulation.sim.experiments import RunConfig
from simulation.sim.flow import InformedFlow, NoiseFlow
from simulation.sim.price_source import synthetic_series
from simulation.sim.windows import (
    CALIBRATION_SEED,
    HEADLINE_STEP_SECONDS,
    KEEPER_INTERVAL_SECONDS,
    SLOT_SECONDS,
    SOURCE_STEP_SECONDS,
    calibration_block_hours,
)


def test_run_config_defaults_are_the_registered_protocol():
    config = RunConfig()
    assert config.seed == CALIBRATION_SEED
    assert config.step_seconds == HEADLINE_STEP_SECONDS
    assert config.source_step_seconds == SOURCE_STEP_SECONDS
    assert config.slot_seconds == SLOT_SECONDS
    assert config.keeper_update_interval_seconds == KEEPER_INTERVAL_SECONDS


def test_registered_grid_is_81_distinct_candidates():
    candidates = grid_candidates()
    assert len(candidates) == 81
    assert len(set(candidates)) == 81
    assert {p.spread_floor for p in candidates} == set(SPREAD_FLOORS)
    assert {p.inventory_coeff for p in candidates} == set(INVENTORY_COEFFS)
    assert {p.volatility_coeff for p in candidates} == set(VOLATILITY_COEFFS)
    assert {p.sigma_target for p in candidates} == set(SIGMA_TARGETS)


def test_calibrate_blocks_freezes_the_winner_with_the_registered_tie_break():
    blocks = [[] for _ in calibration_block_hours()]
    result = calibrate_blocks(
        blocks,
        block_hours=calibration_block_hours(),
        objective_fn=lambda params, points: 0.0,
    )
    assert len(result.per_candidate_scores) == 81
    assert result.score == 0.0
    # Every candidate ties, so the documented tie-break decides: smallest
    # inventory coefficient, then smallest volatility coefficient, then smallest
    # spread floor.
    assert result.params.inventory_coeff == min(INVENTORY_COEFFS)
    assert result.params.volatility_coeff == min(VOLATILITY_COEFFS)
    assert result.params.spread_floor == min(SPREAD_FLOORS)
    assert len(result.per_block_scores) == 12


def test_calibrate_blocks_picks_the_highest_scoring_candidate():
    blocks = [[] for _ in calibration_block_hours()]

    def objective_fn(params, points) -> float:
        return params.volatility_coeff  # largest wins outright

    result = calibrate_blocks(blocks, block_hours=calibration_block_hours(),
                              objective_fn=objective_fn)
    assert result.params.volatility_coeff == max(VOLATILITY_COEFFS)
    assert result.score == max(VOLATILITY_COEFFS)


def test_objective_is_a_manual_run_at_the_headline_clock_with_costs_debited():
    points = synthetic_series(regime="calm", length=600, seed=3)
    params = grid_candidates()[0]
    noise = NoiseFlow(seed=CALIBRATION_SEED)
    informed = InformedFlow()
    score = objective(params, points, noise=noise, informed=informed)

    from simulation.sim.engine import simulate
    from simulation.sim.metrics import hedged_pnl, retail_half_spread_bps
    from simulation.sim.oracle import OracleModel
    from simulation.sim.venues import VaultVenue

    result = simulate(venue_name="c", venue=VaultVenue(params=params), prices=points,
                      oracle=OracleModel(), noise=noise, informed=informed,
                      **RunConfig().simulate_kwargs())
    assert result.step_seconds == HEADLINE_STEP_SECONDS
    assert len(result.value_path) == 1_500, "600 source seconds at 400 ms per step"
    assert result.update_cost_quote > 0.0, "the vault must pay for its keeper"
    by_step = dict(enumerate(result.price_path))
    pnl = hedged_pnl(result.value_path, result.base_path, result.price_path)
    spread = retail_half_spread_bps(result.trades, by_step.get,
                                    step_seconds=result.step_seconds)
    assert score == pnl - 1.0 * spread
