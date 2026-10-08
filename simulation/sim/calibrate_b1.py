"""Item 3a: calibrate B1 (passive) to the paper's passive targets.

Targets (Solmaz et al., Solana): 2s markout ~= -0.2 bps and quiet/retail
half-spread ~= 2.6 bps. We grid over the passive pool depth, the noise trade
size, and the informed fee threshold, and report the best fit + error.
"""

from __future__ import annotations

from dataclasses import replace

from simulation.sim.engine import simulate
from simulation.sim.flow import InformedFlow, NoiseFlow
from simulation.sim.metrics import (
    notional_weighted_markout,
    retail_half_spread_bps,
)
from simulation.sim.oracle import OracleModel
from simulation.sim.venues import PassivePool

TARGET_MARKOUT = -0.2
TARGET_HALF_SPREAD = 2.6
DEPTH_MULTS = (1, 4, 8, 16, 32)
MEAN_SIZES = (25.0, 50.0, 100.0, 200.0)
INFORMED_FEES = (0.5, 1.0, 2.0)


def _b1_metrics(prices, depth_mult, mean_size, informed_fee, seed=20261006):
    pool = PassivePool(base=1_000.0 * depth_mult, quote=150_000.0 * depth_mult, fee=0.0001)
    result = simulate(
        venue_name="B1_passive", venue=pool, prices=prices,
        oracle=OracleModel(seed=seed),
        noise=NoiseFlow(mean_size=mean_size, seed=seed),
        informed=InformedFlow(fee_bps=informed_fee),
        step_seconds=0.4, source_step_seconds=1.0, slot_seconds=0.4,
        keeper_update_interval_seconds=1.0, seed=seed,
    )
    lookup = {i: p for i, p in enumerate(result.price_path)}.get
    markout = notional_weighted_markout(result.trades, max(1, round(2.0 / result.step_seconds)), lookup)
    half = retail_half_spread_bps(result.trades, lookup, step_seconds=result.step_seconds)
    return markout, half


def calibrate(prices, seed: int = 20261006) -> dict:
    best = None
    rows = []
    for depth in DEPTH_MULTS:
        for size in MEAN_SIZES:
            for fee in INFORMED_FEES:
                mo, hs = _b1_metrics(prices, depth, size, fee, seed)
                err = (mo - TARGET_MARKOUT) ** 2 + (hs - TARGET_HALF_SPREAD) ** 2
                row = {"depth_mult": depth, "mean_size": size, "informed_fee": fee,
                       "markout_2s_bps": mo, "half_spread_bps": hs, "sse": err}
                rows.append(row)
                if best is None or err < best["sse"]:
                    best = row
    return {"target_markout": TARGET_MARKOUT, "target_half_spread": TARGET_HALF_SPREAD,
            "best": best, "rows": rows}


if __name__ == "__main__":
    from simulation.sim.study import _load_slice
    from simulation.sim.windows import TEST_WINDOWS
    res = calibrate(_load_slice(TEST_WINDOWS[2]))
    print("targets: markout", res["target_markout"], "half-spread", res["target_half_spread"])
    print("best:", res["best"])
    mx = max(r["sse"] for r in res["rows"]) or 1.0
    for r in sorted(res["rows"], key=lambda x: x["sse"])[:6]:
        print(r)
