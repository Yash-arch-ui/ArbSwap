"""Amendment-1 routed tables: competitor sweep and the propAMM-free world."""

from __future__ import annotations

from simulation.sim.router import route_window
from simulation.sim.study import _load_slice
from simulation.sim.windows import WINDOWS

SEED = 20261006


def _show(title, rows):
    print(f"== {title} ==")
    for r in rows:
        print(f"  {r['venue']:10} vol={r['volume_share']:6.1%} fill={r['fill_share']:6.1%} "
              f"mkt={r['markout_2s_bps']:+7.3f} pnl={r['hedged_pnl_quote']:+8.1f} "
              f"hs50={r['half_spread_p50_bps']:.2f} hs95={r['half_spread_p95_bps']:.2f} rej={r['rejection_rate']:.1%}")


if __name__ == "__main__":
    prices = _load_slice(next(w for w in WINDOWS if w.label == "W4"))
    for hs in (0.3, 0.5, 1.0, 2.0):
        _show(f"W4 propAMM half-spread {hs} bp", route_window(prices, prop_hs=hs))
    _show("W4 NO propAMM, ArbSwap vs B1 fee tiers", route_window(prices, include_prop=False, b1_fee=1.0))
    _show("W4 NO propAMM, B1 fee 5 bp", route_window(prices, include_prop=False, b1_fee=5.0))
    _show("W4 NO propAMM, B1 fee 30 bp", route_window(prices, include_prop=False, b1_fee=30.0))
