"""Amendment-1 2d: ArbSwap spread-floor frontier on W1 only.

Objective: volume share in the propAMM-free world (ArbSwap vs B1 fee tiers),
subject to hedged PnL >= 0. Publishes the frontier (hedged PnL vs volume share)
and the chosen point. Held-out windows are never used.
"""

from __future__ import annotations

from dataclasses import replace

from simulation.reference.quote_math import QuoteParams
from simulation.sim.router import route_window
from simulation.sim.study import _load_slice
from simulation.sim.windows import WINDOWS

SEED = 20261006
SPREAD_FLOORS = (0.00005, 0.0001, 0.0002, 0.0005, 0.001, 0.002)


def frontier() -> list[dict]:
    prices = _load_slice(next(w for w in WINDOWS if w.label == "W1"))
    rows = []
    for sf in SPREAD_FLOORS:
        params = replace(QuoteParams(), spread_floor=sf)
        routed = {r["venue"]: r for r in route_window(
            prices, params=params, include_prop=False, b1_fee=1.0)}
        arb = routed["ArbSwap"]
        rows.append({
            "spread_floor": sf,
            "volume_share": arb["volume_share"],
            "hedged_pnl_quote": arb["hedged_pnl_quote"],
            "half_spread_p50_bps": arb["half_spread_p50_bps"],
        })
    return rows


if __name__ == "__main__":
    rows = frontier()
    feasible = [r for r in rows if r["hedged_pnl_quote"] >= 0]
    chosen = max(feasible, key=lambda r: r["volume_share"]) if feasible else None
    print(f"{'spread_floor':>12} {'vol_share':>9} {'hedged_pnl':>11} {'hs_p50':>7}")
    for r in rows:
        print(f"{r['spread_floor']:>12} {r['volume_share']:>9.1%} {r['hedged_pnl_quote']:>11.1f} {r['half_spread_p50_bps']:>7.2f}")
    print("chosen (max volume share s.t. PnL>=0):", chosen)
