"""Amendment-1 T5: operating envelope in the routed world.

Grid: latency (0.2,0.5,1,2,4 s) x vault fee (1,3,10,30,100 bp) x volatility
(calm,trend,crash). For each cell report ArbSwap hedged PnL and volume share
against the propAMM (0.5 bp). Mark losing (PnL<0) and zero-share cells.
"""

from __future__ import annotations

from simulation.sim.price_source import synthetic_series
from simulation.sim.router import route_window

LATENCIES = (0.2, 0.5, 1.0, 2.0, 4.0)
VAULT_FEES = (1.0, 3.0, 10.0, 30.0, 100.0)
REGIMES = ("calm", "trend", "crash")
LENGTH = 900


def envelope() -> list[dict]:
    rows = []
    for regime in REGIMES:
        prices = synthetic_series(regime=regime, length=LENGTH, seed=20261006)
        for lat in LATENCIES:
            for vf in VAULT_FEES:
                routed = {r["venue"]: r for r in route_window(
                    prices, prop_hs=0.5, prop_latency_s=lat, vault_fee_bps=vf)}
                arb = routed["ArbSwap"]
                pnl = arb["hedged_pnl_quote"]
                share = arb["volume_share"]
                verdict = "lose" if pnl < 0 else ("zero" if share < 1e-6 else "win")
                rows.append({"regime": regime, "latency_s": lat, "vault_fee_bps": vf,
                             "arb_pnl": pnl, "arb_volume_share": share, "verdict": verdict})
    return rows


if __name__ == "__main__":
    rows = envelope()
    from collections import Counter
    print("counts:", Counter(r["verdict"] for r in rows))
    print(f"{'regime':6} {'lat':>4} {'vf':>5} {'arb_pnl':>9} {'arb_vol':>8} verdict")
    for r in rows:
        if r["verdict"] != "win":
            print(f"{r['regime']:6} {r['latency_s']:>4} {r['vault_fee_bps']:>5} {r['arb_pnl']:>9.1f} {r['arb_volume_share']:>8.1%} {r['verdict']}")
