"""Walk-forward calibration (Build Plan §8.5, T1.5).

Tune on earlier windows, test on later ones, freeze parameters before the test
window. The objective is hedged PnL on the training fold minus a penalty for
quiet-flow half-spread, so we do not accidentally reward toxic-flow harvesting.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Callable, Iterable

from research.reference.quote_math import QuoteParams
from research.sim.engine import SimResult, simulate
from research.sim.flow import InformedFlow, NoiseFlow
from research.sim.metrics import hedged_pnl, retail_half_spread_bps
from research.sim.oracle import OracleModel
from research.sim.price_source import PricePoint
from research.sim.venues import VaultVenue


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
              risk_penalty: float = 1.0) -> float:
    """Score = hedged PnL - risk_penalty * quiet-flow half-spread."""
    venue = VaultVenue(params=params)
    result = simulate(
        venue_name="candidate",
        venue=venue,
        prices=points,
        oracle=OracleModel(),
        noise=noise,
        informed=informed,
    )
    pnl = hedged_pnl(result.value_path, result.base_path, result.price_path)
    spread = _retail_spread(result)
    return pnl - risk_penalty * spread


def _retail_spread(result: SimResult) -> float:
    by_second = {i: price for i, price in enumerate(result.price_path)}

    def price_at(second: int):
        return by_second.get(second)

    return retail_half_spread_bps(result.trades, price_at)


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


def calibrate(points: list[PricePoint], *, folds: int = 3,
              objective_fn: Callable[[QuoteParams, list[PricePoint]], float] | None = None,
              **kwargs) -> tuple[QuoteParams, list[float]]:
    """Run walk-forward selection and return the frozen parameters + test scores."""
    base = kwargs.pop("base", QuoteParams())
    folds_data = walk_forward_folds(points, folds=folds)
    chosen = base
    test_scores: list[float] = []
    objective_fn = objective_fn or (lambda params, pts: objective(params, pts, **kwargs))
    for fold in folds_data:
        grid = grid_search(
            chosen,
            spread_floors=(0.00005, 0.0001, 0.0002),
            inventory_coeffs=(0.0002, 0.0005, 0.001),
            volatility_coeffs=(0.5, 1.0, 2.0),
        )
        scored = [(params, objective_fn(params, fold.train)) for params, _ in grid]
        chosen = max(scored, key=lambda pair: pair[1])[0]
        test_scores.append(objective_fn(chosen, fold.test))
    return chosen, test_scores
