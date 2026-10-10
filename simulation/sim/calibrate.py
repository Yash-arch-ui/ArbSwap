"""Walk-forward calibration (Build Plan §8.5, T1.5).

Tune on earlier windows, test on later ones, freeze parameters before the test
window. The objective is hedged PnL on the training fold minus a penalty for
quiet-flow half-spread, so we do not accidentally reward toxic-flow harvesting.

The registered protocol (pre-registration amendment, ``simulation/sim/windows.py``)
calibrates on **12 pre-registered one-hour blocks of W1** at the headline clock,
scores each candidate as the mean over blocks, and freezes the winner for W2-W6.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Callable, Iterable

from simulation.reference.quote_math import QuoteParams
from simulation.sim.engine import SimResult, simulate
from simulation.sim.experiments import RunConfig
from simulation.sim.flow import InformedFlow, NoiseFlow
from simulation.sim.metrics import hedged_pnl, retail_half_spread_bps
from simulation.sim.oracle import OracleModel
from simulation.sim.price_source import PricePoint
from simulation.sim.venues import VaultVenue

# The registered grid: 3 x 3 x 3 x 3 = 81 candidates.
SPREAD_FLOORS: tuple[float, ...] = (0.00005, 0.0001, 0.0002)
INVENTORY_COEFFS: tuple[float, ...] = (0.0002, 0.0005, 0.001)
VOLATILITY_COEFFS: tuple[float, ...] = (0.5, 1.0, 2.0)
SIGMA_TARGETS: tuple[float, ...] = (0.00005, 0.0001, 0.0002)
RISK_PENALTY = 1.0


@dataclass(frozen=True)
class Fold:
    train: list[PricePoint]
    test: list[PricePoint]


def walk_forward_folds(points: list[PricePoint], *, folds: int = 3,
                       train_fraction: float = 0.7) -> list[Fold]:
    """Split a path into rolling train/test folds without look-ahead."""
    if folds < 1 or not 0 < train_fraction < 1:
        raise ValueError("invalid fold configuration")
    n = len(points)
    if n < folds + 2:
        raise ValueError("not enough data for the requested folds")
    chunk = n // folds
    result: list[Fold] = []
    for index in range(folds):
        start = index * chunk
        end = n if index == folds - 1 else start + chunk
        window = points[start:end]
        cut = max(1, int(len(window) * train_fraction))
        result.append(Fold(train=window[:cut], test=window[cut:]))
    return result


def objective(params: QuoteParams, points: list[PricePoint], *,
              noise: NoiseFlow, informed: InformedFlow,
              risk_penalty: float = RISK_PENALTY,
              config: RunConfig | None = None) -> float:
    """Score = hedged PnL - risk_penalty * quiet-flow half-spread (bps).

    Runs at the pre-registered clock with measured CU costs debited from the
    vault, so a candidate is scored exactly the way it will be evaluated.
    """
    config = config or RunConfig()
    venue = VaultVenue(params=params)
    result = simulate(
        venue_name="candidate",
        venue=venue,
        prices=points,
        oracle=OracleModel(),
        noise=noise,
        informed=informed,
        **config.simulate_kwargs(),
    )
    pnl = hedged_pnl(result.value_path, result.base_path, result.price_path)
    spread = _retail_spread(result)
    return pnl - risk_penalty * spread


def _retail_spread(result: SimResult) -> float:
    by_second = {i: price for i, price in enumerate(result.price_path)}

    def price_at(second: int):
        return by_second.get(second)

    return retail_half_spread_bps(result.trades, price_at,
                                  step_seconds=result.step_seconds)


def grid_candidates(base: QuoteParams | None = None) -> list[QuoteParams]:
    """The registered 81-candidate grid, enumerated in a fixed order."""
    base = base or QuoteParams()
    return [
        replace(
            base,
            spread_floor=floor,
            spread_min=min(base.spread_min, floor),
            inventory_coeff=inventory,
            volatility_coeff=volatility,
            sigma_target=sigma_target,
        )
        for floor in SPREAD_FLOORS
        for inventory in INVENTORY_COEFFS
        for volatility in VOLATILITY_COEFFS
        for sigma_target in SIGMA_TARGETS
    ]


def grid_search(base: QuoteParams, *, spread_floors: Iterable[float],
                inventory_coeffs: Iterable[float],
                volatility_coeffs: Iterable[float]) -> list[tuple[QuoteParams, float]]:
    """Enumerate a small parameter grid; returns candidates sorted best-first.

    Scoring is left to the caller so the same grid can be evaluated on a fold.
    """
    candidates: list[QuoteParams] = []
    for spread_floor in spread_floors:
        for inventory_coeff in inventory_coeffs:
            for volatility_coeff in volatility_coeffs:
                candidates.append(
                    replace(
                        base,
                        spread_floor=spread_floor,
                        spread_min=min(base.spread_min, spread_floor),
                        inventory_coeff=inventory_coeff,
                        volatility_coeff=volatility_coeff,
                    )
                )
    return [(params, 0.0) for params in candidates]


@dataclass(frozen=True)
class CalibrationResult:
    """The frozen winner plus the evidence that selected it."""

    params: QuoteParams
    score: float
    per_block_scores: tuple[float, ...]
    per_candidate_scores: tuple[float, ...]
    block_hours: tuple[int, ...]

    @property
    def runner_up_score(self) -> float:
        return sorted(self.per_candidate_scores, reverse=True)[1] \
            if len(self.per_candidate_scores) > 1 else self.score


def _selection_key(item: tuple[QuoteParams, float]):
    """Best score first; on a tie prefer the smaller, more conservative coefficients."""
    params, score = item
    return (-score, params.inventory_coeff, params.volatility_coeff, params.spread_floor)


def calibrate_blocks(blocks: list[list[PricePoint]], *,
                     block_hours: tuple[int, ...],
                     base: QuoteParams | None = None,
                     config: RunConfig | None = None,
                     objective_fn: Callable[[QuoteParams, list[PricePoint]], float] | None = None,
                     ) -> CalibrationResult:
    """Score every grid candidate on every block and freeze the winner.

    ``objective_fn`` (signature ``(params, points) -> float``) may be supplied
    for tests; production always uses :func:`objective` at the headline clock.
    """
    if not blocks:
        raise ValueError("calibration needs at least one block")
    if len(blocks) != len(block_hours):
        raise ValueError("one hour label is required per block")
    config = config or RunConfig()
    noise = NoiseFlow(seed=config.seed)
    informed = InformedFlow()

    def score(params: QuoteParams) -> float:
        if objective_fn is not None:
            values = [objective_fn(params, block) for block in blocks]
        else:
            values = [objective(params, block, noise=noise, informed=informed,
                                config=config) for block in blocks]
        return sum(values) / len(values)

    scored: list[tuple[QuoteParams, float]] = [
        (params, score(params)) for params in grid_candidates(base)
    ]
    scored.sort(key=_selection_key)
    winner, best = scored[0]
    per_block = tuple(
        objective_fn(winner, block) if objective_fn is not None
        else objective(winner, block, noise=noise, informed=informed, config=config)
        for block in blocks
    )
    return CalibrationResult(
        params=winner,
        score=best,
        per_block_scores=per_block,
        per_candidate_scores=tuple(s for _, s in scored),
        block_hours=block_hours,
    )


def calibrate(points: list[PricePoint], *, folds: int = 3,
              objective_fn: Callable[[QuoteParams, list[PricePoint]], float] | None = None,
              **kwargs) -> tuple[QuoteParams, list[float]]:
    """Run walk-forward selection and return the frozen parameters + test scores.

    Kept for the synthetic-report path; the registered real-data protocol uses
    :func:`calibrate_blocks`.
    """
    base = kwargs.pop("base", QuoteParams())
    folds_data = walk_forward_folds(points, folds=folds)
    chosen = base
    test_scores: list[float] = []
    objective_fn = objective_fn or (lambda params, pts: objective(params, pts, **kwargs))
    for fold in folds_data:
        grid = grid_search(
            chosen,
            spread_floors=SPREAD_FLOORS,
            inventory_coeffs=INVENTORY_COEFFS,
            volatility_coeffs=VOLATILITY_COEFFS,
        )
        scored = [(params, objective_fn(params, fold.train)) for params, _ in grid]
        scored.sort(key=_selection_key)
        chosen = scored[0][0]
        test_scores.append(objective_fn(chosen, fold.test))
    return chosen, test_scores
