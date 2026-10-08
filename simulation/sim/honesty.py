"""Items 2a-2c: honesty rejections, survivorship bias, and rejection causes.

2a: sweep the trader's min_out slippage tolerance (0, 0.5, 1, 2, 5 bps) and
    report the rejection and fill rates.
2b: report the would-be quote-vs-fill gap of *all attempted* fills (before the
    honesty decision) next to the post-rejection gap of accepted fills (which is
    non-positive by construction).
2c: sweep the keeper update cadence and decompose the rejection causes.
"""

from __future__ import annotations

import math
from dataclasses import replace

from simulation.reference.quote_math import QuoteParams
from simulation.sim.engine import simulate
from simulation.sim.flow import InformedFlow, NoiseFlow
from simulation.sim.oracle import OracleModel
from simulation.sim.venues import VaultVenue

TOLERANCES_BPS = (0.0, 0.5, 1.0, 2.0, 5.0)
CADENCES_S = (0.4, 1.0, 2.0, 5.0)


def _p95(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(math.ceil(0.95 * len(ordered))) - 1)
    return ordered[idx]


def _run(prices, *, tol_bps: float, cadence_s: float, seed: int = 20261006):
    venue = VaultVenue(params=QuoteParams(), fee_bps=1.0, min_out_tol_bps=tol_bps)
    result = simulate(
        venue_name="ArbSwap",
        venue=venue,
        prices=prices,
        oracle=OracleModel(seed=seed),
        noise=NoiseFlow(seed=seed),
        informed=InformedFlow(),
        step_seconds=0.4,
        source_step_seconds=1.0,
        slot_seconds=0.4,
        keeper_update_interval_seconds=cadence_s,
        seed=seed,
    )
    return venue, result


def _gap_stats(venue, result) -> dict:
    gaps = [g for (g, _) in venue.attempt_gaps]
    notionals = [n for (_, n) in venue.attempt_gaps]
    total_n = sum(notionals)
    wmean = (sum(g * n for g, n in venue.attempt_gaps) / total_n) if total_n else 0.0
    post = [t.gap_bps for t in result.trades]
    return {
        "wouldbe_gap_mean": sum(gaps) / len(gaps) if gaps else 0.0,
        "wouldbe_gap_vwmean": wmean,
        "wouldbe_gap_p95": _p95(gaps),
        "post_gap_mean": sum(post) / len(post) if post else 0.0,
    }


def sweep_tolerance(prices, *, seed: int = 20261006) -> list[dict]:
    rows = []
    for tol in TOLERANCES_BPS:
        venue, result = _run(prices, tol_bps=tol, cadence_s=1.0, seed=seed)
        trades = len(result.trades)
        rejected = venue.honesty_rejects + venue.capacity_rejects + venue.reserve_rejects
        attempted = trades + rejected
        stats = _gap_stats(venue, result)
        rows.append({
            "tol_bps": tol,
            "trades": trades,
            "honesty_rejects": venue.honesty_rejects,
            "fill_rate": trades / attempted if attempted else 1.0,
            "rejection_rate": rejected / attempted if attempted else 0.0,
            **stats,
        })
    return rows


def sweep_cadence(prices, *, seed: int = 20261006) -> list[dict]:
    rows = []
    for cadence in CADENCES_S:
        venue, result = _run(prices, tol_bps=0.0, cadence_s=cadence, seed=seed)
        trades = len(result.trades)
        rejected = venue.honesty_rejects + venue.capacity_rejects + venue.reserve_rejects
        attempted = trades + rejected
        rows.append({
            "cadence_s": cadence,
            "trades": trades,
            "honesty_rejects": venue.honesty_rejects,
            "capacity_rejects": venue.capacity_rejects,
            "expired_skips": result.expired_skips,
            "fill_rate": trades / attempted if attempted else 1.0,
        })
    return rows


if __name__ == "__main__":
    from simulation.sim.study import _load_slice
    from simulation.sim.windows import TEST_WINDOWS

    prices = _load_slice(TEST_WINDOWS[2])  # W4 trend
    print("== 2a/2b tolerance sweep (W4) ==")
    for r in sweep_tolerance(prices):
        print(r)
    print("== 2c cadence sweep (W4) ==")
    for r in sweep_cadence(prices):
        print(r)
