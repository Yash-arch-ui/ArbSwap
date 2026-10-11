"""F-08 real-flow calibration (reproducible).

The historical "real-flow residual" (-7.9 / 13.1 bps) was not backed by a
committed artifact and came from a comparison that **disabled the arbitrageur**,
so the passive pool was never re-anchored to the reference and its measured
half-spread blew up (thousands of bps) — a venue-definition artifact, not
adverse selection.

This module recomputes the passive-pool (B1) 2s markout and quiet half-spread on
real Binance aggTrades flow, with the arbitrageur **on** (a real pool is
arbitraged) and **off** (the historical ablation), and writes
``simulation/data/results/real_flow_calibration.json``.

Run: ``.venv/bin/python -m simulation.sim.real_flow_calibrate``
"""

from __future__ import annotations

import json
from pathlib import Path

from simulation.sim.engine import simulate
from simulation.sim.flow import InformedFlow
from simulation.sim.metrics import notional_weighted_markout, retail_half_spread_bps
from simulation.sim.oracle import OracleModel
from simulation.sim.real_flow import load_day
from simulation.sim.venues import PassivePool

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "simulation" / "data" / "raw"
OUT = ROOT / "simulation" / "data" / "results" / "real_flow_calibration.json"
DAYS = ("2026-09-10", "2026-09-17", "2026-10-01")
MAX_SECONDS = 3_600
BASE = 1_000.0


def _b1(day: str, *, informed_on: bool) -> dict:
    prices, flow = load_day(RAW / f"SOLUSDT-aggTrades-{day}.csv", max_seconds=MAX_SECONDS)
    pool = PassivePool(base=BASE, quote=prices[0].price * BASE, fee=0.0001)
    informed = InformedFlow() if informed_on else InformedFlow(max_size=0.0)
    result = simulate(
        venue_name="B1", venue=pool, prices=prices, oracle=OracleModel(seed=1),
        noise=flow, informed=informed, step_seconds=1.0, source_step_seconds=1.0,
        slot_seconds=0.4, keeper_update_interval_seconds=1.0, seed=1,
    )
    lookup = {i: p for i, p in enumerate(result.price_path)}.get
    return {
        "day": day,
        "informed": informed_on,
        "trades": len(result.trades),
        "markout_2s_bps": notional_weighted_markout(result.trades, 2, lookup),
        "quiet_half_spread_bps": retail_half_spread_bps(result.trades, lookup,
                                                       step_seconds=1.0),
    }


def main() -> None:
    rows = [{"day": day, "informed_on": _b1(day, informed_on=True),
             "informed_off": _b1(day, informed_on=False)} for day in DAYS]
    with_informed = [r["informed_on"]["markout_2s_bps"] for r in rows]
    without = [r["informed_off"]["markout_2s_bps"] for r in rows]
    hs_on = [r["informed_on"]["quiet_half_spread_bps"] for r in rows]
    payload = {
        "kind": "real-flow passive-pool (B1) calibration",
        "note": ("The arbitrageur keeps the pool near mid; disabling it inflates "
                 "the residual (venue-definition artifact). The corrected "
                 "residual is the `informed_on` column."),
        "days": list(DAYS),
        "rows": rows,
        "residual_informed_on_bps": sum(with_informed) / len(with_informed),
        "residual_informed_off_bps": sum(without) / len(without),
        "residual_informed_on_half_spread_bps": sum(hs_on) / len(hs_on),
    }
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}")
    print(f"  B1 2s markout (arb ON):  {payload['residual_informed_on_bps']:+.3f} bps")
    print(f"  B1 2s markout (arb OFF): {payload['residual_informed_off_bps']:+.3f} bps")


if __name__ == "__main__":
    main()
