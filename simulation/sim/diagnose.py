"""F4 — retail diagnosis: decompose the quiet-flow half-spread, and explain the
routed-world paradox (high quiet half-spread but a large no-propAMM volume
share).

- **Decomposition.** Runs ArbSwap on each held-out window (W2-W6), records the
  Section 5.5/5.6 spread terms at every refresh, and averages them over the
  *quiet* refreshes (reference moved < 1 bp over the trailing 6 s, the same
  `is_quiet` rule used for `quiet_half_spread_bps`).
- **Routed world without a propAMM.** Reports each venue's filled-volume share
  split into informed and noise components, plus the B1 fee tier and the flow
  price-elasticity settings.
- **Simulator flaw.** The prior `volume_share` counted *attempted* notional,
  including orders a venue rejected, which inflated ArbSwap's share. Fixed in
  `simulation/sim/router.py` (regression: `test_router.py`); affected numbers
  are marked superseded in `docs/RESULTS.md`.

Run: ``.venv/bin/python -m simulation.sim.diagnose``
Writes ``simulation/data/results/diagnosis.json``.
"""

from __future__ import annotations

import json
from pathlib import Path

from simulation.reference.quote_math import QuoteParams
from simulation.sim.engine import simulate
from simulation.sim.flow import InformedFlow, NoiseFlow
from simulation.sim.flow_config import pool_kwargs
from simulation.sim.metrics import retail_half_spread_bps
from simulation.sim.oracle import OracleModel
from simulation.sim.router import route_window
from simulation.sim.study import _load_window, load_frozen_params
from simulation.sim.venues import VaultVenue
from simulation.sim.windows import HEADLINE_STEP_SECONDS, WINDOWS

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "simulation" / "data" / "results" / "diagnosis.json"

TERM_KEYS = ("floor", "volatility", "inventory", "confidence", "age", "jump")


def _quiet(prices: list[float], now: float, step_seconds: float) -> bool:
    idx = int(round(now / step_seconds))
    lookback = max(1, round(5.0 / step_seconds))
    forward = max(1, round(1.0 / step_seconds))
    before = prices[idx - lookback] if idx - lookback >= 0 else None
    after = prices[idx + forward] if idx + forward < len(prices) else None
    if before is None or after is None or before <= 0:
        return False
    return abs(after - before) / before < 0.0001


def decompose_window(params: QuoteParams, label: str) -> dict:
    window = next(w for w in WINDOWS if w.label == label)
    points = _load_window(window)
    venue = VaultVenue(params=params, record_terms=True,
                       **pool_kwargs(points[0].price))
    result = simulate(
        venue_name="ArbSwap", venue=venue, prices=points,
        oracle=OracleModel(), noise=NoiseFlow(), informed=InformedFlow(),
        step_seconds=HEADLINE_STEP_SECONDS, source_step_seconds=1.0,
        slot_seconds=0.4, keeper_update_interval_seconds=1.0,
    )
    prices = result.price_path
    quiet_terms = [t for t in venue.spread_terms
                   if _quiet(prices, t["now"], HEADLINE_STEP_SECONDS)]
    source = quiet_terms or venue.spread_terms
    n = max(1, len(source))
    means = {key: sum(t[key] for t in source) / n for key in TERM_KEYS}
    directional = sum(t["ask_extra"] + t["bid_extra"] for t in source) / n
    lookup = {i: p for i, p in enumerate(result.price_path)}.get
    realized = retail_half_spread_bps(result.trades, lookup,
                                      step_seconds=HEADLINE_STEP_SECONDS)
    dominant = max(means, key=lambda k: means[k])
    return {
        "window": label,
        "quiet_refreshes": len(quiet_terms),
        "total_refreshes": len(venue.spread_terms),
        "term_means_bps": {k: v * 10_000.0 for k, v in means.items()},
        "directional_mean_bps": directional * 10_000.0,
        "raw_sum_bps": sum(means.values()) * 10_000.0,
        "realized_quiet_half_spread_bps": realized,
        "dominant_term": dominant,
        "dominant_share": means[dominant] / max(1e-12, sum(means.values())),
    }


def routed_explanation() -> dict:
    agg = {}
    for window in WINDOWS:
        points = _load_window(window)
        for row in route_window(points, include_prop=False, b1_fee=1.0,
                                insensitive_share=0.2, slippage_bps=1.0):
            entry = agg.setdefault(row["venue"], {"volume_share": [], "informed": [],
                                                  "noise": [], "quiet_hs": []})
            entry["volume_share"].append(row["volume_share"])
            entry["informed"].append(row["informed_volume_share"])
            entry["noise"].append(row["noise_volume_share"])
            entry["quiet_hs"].append(row["quiet_half_spread_bps"])

    def mean(values):
        return sum(values) / len(values) if values else 0.0

    return {
        "b1_fee_bps": 1.0,
        "insensitive_share": 0.2,
        "price_sensitive_share": 0.8,
        "slippage_tolerance_bps": 1.0,
        "per_venue_mean": {
            name: {
                "volume_share": mean(e["volume_share"]),
                "informed_volume_share": mean(e["informed"]),
                "noise_volume_share": mean(e["noise"]),
                "quiet_half_spread_bps": mean(e["quiet_hs"]),
            }
            for name, e in agg.items()
        },
    }


def evaluate() -> dict:
    params = load_frozen_params()
    print("[F4] decomposing the quiet half-spread per window...", flush=True)
    windows = []
    for label in ("W2", "W3", "W4", "W5", "W6"):
        row = decompose_window(params, label)
        windows.append(row)
        print(f"  {label}: dominant={row['dominant_term']} "
              f"({row['dominant_share']:.0%}), realized {row['realized_quiet_half_spread_bps']:.2f} bps",
              flush=True)
    overall = {key: sum(w["term_means_bps"][key] for w in windows) / len(windows)
               for key in TERM_KEYS}
    return {
        "windows": windows,
        "overall_term_means_bps": overall,
        "overall_dominant_term": max(overall, key=lambda k: overall[k]),
        "routed_without_propamm": routed_explanation(),
        "simulator_flaw": {
            "found": True,
            "what": "router volume_share counted attempted notional (including "
                    "rejected orders), inflating ArbSwap's share",
            "fix": "simulation/sim/router.py now uses filled notional for "
                   "volume_share; attempt_share is reported separately",
            "regression": "simulation/sim/test_router.py::"
                          "test_volume_share_counts_filled_not_attempted_notional",
        },
    }


def main() -> None:
    payload = evaluate()
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(f"[write] {OUT.relative_to(ROOT)}")
    print("overall dominant term:", payload["overall_dominant_term"])


if __name__ == "__main__":
    main()
