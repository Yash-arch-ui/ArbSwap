"""C2.5 - operating envelope in the routed world.

Sweeps vault fee x competitor half-spread x regime, reporting ArbSwap volume
share and 2s markout together, so losing/zero-share cells are visible. Model
output (synthetic price path, synthetic flow).

Run: ``.venv/bin/python -m simulation.sim.envelope``
"""

from __future__ import annotations

import json
from pathlib import Path

from simulation.sim.price_source import synthetic_series
from simulation.sim.router import route_window

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "simulation" / "data" / "results" / "envelope.json"

REGIMES = ("calm", "trend", "crash")
VAULT_FEES = (1, 3, 5, 10, 20)
PROP_HS = (0.3, 0.5, 1.0, 2.0, 4.0)


def run(*, length: int = 1_800, seed: int = 20261006) -> list[dict]:
    rows = []
    for regime in REGIMES:
        prices = synthetic_series(regime=regime, length=length, seed=seed)
        for vf in VAULT_FEES:
            for hs in PROP_HS:
                res = route_window(prices, prop_hs=hs, vault_fee_bps=vf)
                arb = next((r for r in res if r["venue"] == "ArbSwap"), {})
                rows.append({
                    "regime": regime, "vault_fee_bps": vf, "prop_half_spread_bps": hs,
                    "arb_volume_share": arb.get("volume_share"),
                    "arb_markout_2s_bps": arb.get("markout_2s_bps"),
                    "deploy_ok": (arb.get("volume_share", 0.0) > 0.0
                                  and arb.get("markout_2s_bps", -1) >= 0.0),
                })
    return rows


def main() -> None:
    rows = run()
    OUT.write_text(json.dumps(rows, indent=2, sort_keys=True) + "\n")
    lose = [r for r in rows if not r["deploy_ok"]]
    print(f"wrote {OUT.relative_to(ROOT)}: {len(rows)} cells, "
          f"{len(rows) - len(lose)} deploy-ok, {len(lose)} not")


if __name__ == "__main__":
    main()
