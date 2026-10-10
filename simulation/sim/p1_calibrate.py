"""T1: calibrate the passive baseline B1 to the paper's targets (pre-registered).

Targets (docs/P1_PREREGISTRATION.md): 2s markout -0.2 bps (accept -0.5..+0.1),
quiet-flow half-spread 2.6 bps (accept 1.8..3.4). We tune the flow model and the
pool depth so B1 matches; ArbSwap is never tuned here. Calibration runs on the
W1 calibration window only.
"""

from __future__ import annotations

import json
from pathlib import Path

from simulation.sim.engine import simulate
from simulation.sim.flow import InformedFlow, NoiseFlow
from simulation.sim.metrics import notional_weighted_markout, retail_half_spread_bps
from simulation.sim.oracle import OracleModel
from simulation.sim.study import _load_slice
from simulation.sim.venues import PassivePool
from simulation.sim.windows import WINDOWS

OUT = Path("simulation/data/results/b1_calibration.json")
TARGET_MARKOUT = -0.2
TARGET_HALF_SPREAD = 2.6
ACCEPT_MARKOUT = (-0.5, 0.1)
ACCEPT_HALF_SPREAD = (1.8, 3.4)
SEED = 20261006

DEPTHS = (8.0, 12.0, 16.0, 20.0, 24.0)
MEAN_SIZES = (25.0, 40.0, 50.0, 75.0, 100.0)
ARRIVALS = (0.3, 0.5, 0.7)


def _metrics(points, depth, mean_size, arrival, fee=0.0001):
    base = 1_000.0 * depth
    pool = PassivePool(base=base, quote=points[0].price * base, fee=fee)
    result = simulate(
        venue_name="B1", venue=pool, prices=points, oracle=OracleModel(seed=SEED),
        noise=NoiseFlow(arrival_rate=arrival, mean_size=mean_size, seed=SEED),
        informed=InformedFlow(), step_seconds=0.4, source_step_seconds=1.0,
        slot_seconds=0.4, keeper_update_interval_seconds=1.0, seed=SEED,
    )
    lookup = {i: p for i, p in enumerate(result.price_path)}.get
    return (
        notional_weighted_markout(result.trades, max(1, round(2.0 / result.step_seconds)), lookup),
        retail_half_spread_bps(result.trades, lookup, step_seconds=result.step_seconds),
    )


def calibrate() -> dict:
    w1 = next(w for w in WINDOWS if w.label == "W1")
    points = _load_slice(w1)
    rows = []
    best = None
    for depth in DEPTHS:
        for mean_size in MEAN_SIZES:
            for arrival in ARRIVALS:
                mo, hs = _metrics(points, depth, mean_size, arrival)
                err = (mo - TARGET_MARKOUT) ** 2 + (hs - TARGET_HALF_SPREAD) ** 2
                row = {"depth_mult": depth, "mean_size": mean_size, "arrival_rate": arrival,
                       "markout_2s_bps": mo, "half_spread_bps": hs, "sse": err}
                rows.append(row)
                if best is None or err < best["sse"]:
                    best = row
    payload = {
        "target_markout": TARGET_MARKOUT, "target_half_spread": TARGET_HALF_SPREAD,
        "accept_markout": ACCEPT_MARKOUT, "accept_half_spread": ACCEPT_HALF_SPREAD,
        "seed": SEED, "window": "W1", "best": best, "rows": rows,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    return payload


def within_acceptance(row: dict) -> bool:
    return (ACCEPT_MARKOUT[0] <= row["markout_2s_bps"] <= ACCEPT_MARKOUT[1]
            and ACCEPT_HALF_SPREAD[0] <= row["half_spread_bps"] <= ACCEPT_HALF_SPREAD[1])


if __name__ == "__main__":
    payload = calibrate()
    print("best:", payload["best"])
    n = sum(1 for r in payload["rows"] if within_acceptance(r))
    print(f"cells within acceptance: {n}/{len(payload['rows'])}")
