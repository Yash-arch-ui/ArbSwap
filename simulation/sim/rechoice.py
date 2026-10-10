"""F4(d) — one-coefficient re-choice on the calibration window (Amendment 5).

Runs the registered objective on W1's 12 one-hour blocks, freezes the winner (if
any), and re-runs W2-W6 with it. Writes
``simulation/data/results/rechoice.json``.

Run: ``.venv/bin/python -m simulation.sim.rechoice``
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, replace
from pathlib import Path

from simulation.reference.quote_math import QuoteParams
from simulation.sim.experiments import RunConfig
from simulation.sim.flow import InformedFlow, NoiseFlow
from simulation.sim.flow_config import pool_kwargs
from simulation.sim.metrics import hedged_pnl, retail_half_spread_bps
from simulation.sim.oracle import OracleModel
from simulation.sim.engine import simulate
from simulation.sim.router import route_window
from simulation.sim.study import (
    PASSIVE_FEE,
    VAULT_FEE_BPS,
    _load_window,
    extract_blocks,
    load_frozen_params,
)
from simulation.sim.venues import PassivePool, VaultVenue
from simulation.sim.windows import CALIBRATION_SEED, WINDOWS, calibration_block_hours

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "simulation" / "data" / "results" / "rechoice.json"

INVENTORY_GRID = (0.0, 0.0001, 0.00025, 0.0004, 0.0005)  # Amendment 5 (superseded)
VOLATILITY_GRID = (0.0, 0.25, 0.5, 1.0)  # Amendment 6 (active)
B1_FEE_BPS = 1.0
INSENSITIVE_SHARE = 0.2
SLIPPAGE_BPS = 1.0


def _pair(block, params: QuoteParams) -> dict:
    config = RunConfig(seed=CALIBRATION_SEED)
    kw = pool_kwargs(block[0].price)
    arb = simulate(venue_name="ArbSwap",
                   venue=VaultVenue(params=params, fee_bps=VAULT_FEE_BPS, **kw),
                   prices=block, oracle=OracleModel(),
                   noise=NoiseFlow(seed=CALIBRATION_SEED), informed=InformedFlow(),
                   **config.simulate_kwargs())
    b1 = simulate(venue_name="B1_passive", venue=PassivePool(fee=PASSIVE_FEE, **kw),
                  prices=block, oracle=OracleModel(),
                  noise=NoiseFlow(seed=CALIBRATION_SEED), informed=InformedFlow(),
                  **config.simulate_kwargs())
    arb_lookup = {i: p for i, p in enumerate(arb.price_path)}.get
    b1_lookup = {i: p for i, p in enumerate(b1.price_path)}.get
    return {
        "arb_hedged_pnl": hedged_pnl(arb.value_path, arb.base_path, arb.price_path),
        "arb_quiet_half_spread_bps": retail_half_spread_bps(
            arb.trades, arb_lookup, step_seconds=arb.step_seconds),
        "b1_quiet_half_spread_bps": retail_half_spread_bps(
            b1.trades, b1_lookup, step_seconds=b1.step_seconds),
    }


def _candidate_score(blocks, params: QuoteParams) -> dict:
    shares, pairs = [], []
    for block in blocks:
        routed = route_window(block, params=params, b1_fee=B1_FEE_BPS,
                              insensitive_share=INSENSITIVE_SHARE,
                              slippage_bps=SLIPPAGE_BPS, seed=CALIBRATION_SEED,
                              include_prop=False)
        arb = next(r for r in routed if r["venue"] == "ArbSwap")
        shares.append(arb["volume_share"])
        pairs.append(_pair(block, params))
    n = len(blocks)
    mean = lambda key: sum(p[key] for p in pairs) / n  # noqa: E731
    return {
        "mean_volume_share": sum(shares) / n,
        "mean_arb_hedged_pnl": mean("arb_hedged_pnl"),
        "mean_arb_quiet_half_spread_bps": mean("arb_quiet_half_spread_bps"),
        "mean_b1_quiet_half_spread_bps": mean("b1_quiet_half_spread_bps"),
    }


def evaluate() -> dict:
    base = load_frozen_params()
    window = next(w for w in WINDOWS if w.is_calibration)
    blocks = extract_blocks(_load_window(window), calibration_block_hours())
    print(f"[F4d] {len(blocks)} calibration blocks", flush=True)
    scored = []
    for coeff in VOLATILITY_GRID:
        params = replace(base, volatility_coeff=coeff)
        row = _candidate_score(blocks, params)
        row["volatility_coeff"] = coeff
        row["feasible"] = (row["mean_arb_hedged_pnl"] >= 0
                           and row["mean_arb_quiet_half_spread_bps"]
                           <= row["mean_b1_quiet_half_spread_bps"])
        scored.append(row)
        print(f"  volatility_coeff={coeff}: share={row['mean_volume_share']:.4f} "
              f"pnl={row['mean_arb_hedged_pnl']:.1f} "
              f"arb_hs={row['mean_arb_quiet_half_spread_bps']:.3f} "
              f"b1_hs={row['mean_b1_quiet_half_spread_bps']:.3f} "
              f"feasible={row['feasible']}", flush=True)
    feasible = [s for s in scored if s["feasible"]]
    if feasible:
        winner = max(feasible, key=lambda s: (s["mean_volume_share"], -s["volatility_coeff"]))
        chosen_params = replace(base, volatility_coeff=winner["volatility_coeff"])
        held = {}
        for w in WINDOWS:
            if w.is_calibration:
                continue
            points = _load_window(w)
            held[w.label] = _pair(points, chosen_params)
        payload_hash = hashlib.sha256(
            json.dumps(asdict(chosen_params), sort_keys=True).encode()).hexdigest()
        return {"decision": "re-chosen",
                "winner": winner, "candidates": scored,
                "frozen_params_sha256": payload_hash,
                "held_out_after_rechoice": held}
    return {"decision": "no-feasible-candidate",
            "winner": None, "candidates": scored,
            "frozen_params_sha256": hashlib.sha256(
                json.dumps(asdict(base), sort_keys=True).encode()).hexdigest(),
            "held_out_after_rechoice": None}


def main() -> None:
    payload = evaluate()
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(f"[write] {OUT.relative_to(ROOT)}")
    print("decision:", payload["decision"])


if __name__ == "__main__":
    main()
