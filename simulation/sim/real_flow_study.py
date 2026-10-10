"""F5 — real-flow evidence: high-volatility windows and T-A.i bootstrap CIs.

Registered in ``docs/THESIS.md`` (Amendment 4) **before** this module was run.
Two parts:

1. **High-volatility held-out windows.** The two highest-σ non-overlapping UTC
   days in 2026-01-01…2026-02-28 with σ ≥ 2·σ_ref are selected by the
   registered rule (2026-02-06 and 2026-01-31). The E1–E6 held-out protocol
   (`run_venues`) runs on each day's USDC-converted real price path.

2. **T-A.i.** Real ``aggTrades`` flow drives ArbSwap and B1 at fee tiers
   1 / 5 / 30 bps on those two days plus the three archived aggTrades days. A
   5-minute moving-block bootstrap gives a 95% CI on the hedged-PnL difference
   (ArbSwap − B1) per day and tier.

Run: ``.venv/bin/python -m simulation.sim.real_flow_study``
Writes ``simulation/data/results/f5_real_flow.json``.
"""

from __future__ import annotations

import io
import json
import math
import random
import zipfile
from dataclasses import asdict
from datetime import date
from pathlib import Path

from simulation.reference.quote_math import QuoteParams
from simulation.sim.costs import CU_SWAP, CU_UPDATE_QUOTE
from simulation.sim.data_io import ensure_sol_csv, ensure_usdc_csv
from simulation.sim.engine import simulate
from simulation.sim.experiments import RunConfig, run_venues
from simulation.sim.flow import InformedFlow
from simulation.sim.metrics import hedged_pnl, notional_weighted_markout, retail_half_spread_bps
from simulation.sim.oracle import OracleModel
from simulation.sim.price_source import PricePoint, load_price_window
from simulation.sim.real_flow import RealFlow, load_day
from simulation.sim.study import PASSIVE_FEE, VAULT_FEE_BPS, load_frozen_params
from simulation.sim.usdt_usdc import convert_legs
from simulation.sim.venues import PassivePool, VaultVenue
from simulation.sim.windows import WINDOWS

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "simulation" / "data" / "raw"
OUT = ROOT / "simulation" / "data" / "results" / "f5_real_flow.json"
HIGH_VOL_CACHE = ROOT / "simulation" / "data" / "results" / "f5_high_vol.json"

# Amendment 4: registered before running.
HIGH_VOL_DAYS = ("2026-02-06", "2026-01-31")
AGGTRADES_DAYS = ("2026-09-10", "2026-09-17", "2026-10-01")
B1_FEE_TIERS_BPS = (1.0, 5.0, 30.0)
BOOTSTRAP_BLOCK_SECONDS = 300
BOOTSTRAP_RESAMPLES = 2_000
BOOTSTRAP_SEED = 20261010
REAL_FLOW_SECONDS = 6 * 3_600  # six hours per day keeps memory/runtime bounded

# σ_ref = equal-weighted mean W2-W6 realised σ per sqrt-second (Amendment 4).
SIGMA_REF = 1.02e-4
# Both venues are sized to the same realistic depth for the real-flow run. The
# day's traded notional is millions of quote, so a $100k pool is annihilated;
# 100,000 base units (~$10M at SOL≈$100) is comparable to one hour of flow.
DEPTH_BASE = 10_000_000.0


def _realised_sigma(prices: list[float]) -> float:
    total = 0.0
    count = 0
    for previous, current in zip(prices, prices[1:]):
        if previous > 0 and current > 0:
            total += math.log(current / previous) ** 2
            count += 1
    return math.sqrt(total / count) if count else 0.0


def _high_vol_points(day: str) -> list[PricePoint]:
    """USDC-converted 1-second reference for one high-vol UTC day."""
    sol = ensure_sol_csv(day)
    usdc = ensure_usdc_csv(day)
    from datetime import datetime, timezone

    start = int(datetime.fromisoformat(day).replace(tzinfo=timezone.utc).timestamp() * 1_000)
    end = start + 86_400_000
    return convert_legs(
        load_price_window(sol, start_ms=start, end_ms=end),
        load_price_window(usdc, start_ms=start, end_ms=end),
    )


def _raw_aggtrades_csv(day: str) -> Path:
    out = RAW / f"SOLUSDT-aggTrades-{day}.csv"
    if out.exists():
        return out
    from simulation.data.download_vision import archive_url, fetch_archive

    payload = fetch_archive(
        archive_url("aggTrades", "SOLUSDT", date.fromisoformat(day)),
        cache_dir=RAW / "archive",
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        name = archive.namelist()[0]
        text = archive.read(name).decode()
    out.write_text(text)
    return out


def _pnl_increments(result) -> list[float]:
    increments = []
    for t in range(len(result.value_path) - 1):
        hedge = result.base_path[t] * (result.price_path[t + 1] - result.price_path[t])
        increments.append((result.value_path[t + 1] - result.value_path[t]) - hedge)
    return increments


def _moving_block_ci(diffs: list[float], *, block: int, resamples: int,
                     seed: int) -> tuple[float, float, float]:
    """95% moving-block bootstrap CI of the mean of ``diffs``."""
    n = len(diffs)
    if n == 0:
        return 0.0, 0.0, 0.0
    means = []
    rng = random.Random(seed)
    n_blocks = max(1, math.ceil(n / block))
    for _ in range(resamples):
        total = 0.0
        for _ in range(n_blocks):
            start = rng.randrange(0, max(1, n - block + 1))
            total += sum(diffs[start:start + block])
        means.append(total / (n_blocks * block))
    means.sort()
    lo = means[int(0.025 * len(means))]
    hi = means[int(0.975 * len(means)) - 1]
    return sum(diffs) / n, lo, hi


def _run_real_flow_day(day: str, params: QuoteParams, tier_bps: float) -> dict:
    prices, flow = load_day(_raw_aggtrades_csv(day), max_seconds=REAL_FLOW_SECONDS)
    common = dict(
        prices=prices, oracle=OracleModel(seed=1), noise=flow,
        informed=InformedFlow(max_size=0.0), step_seconds=1.0,
        source_step_seconds=1.0, slot_seconds=0.4,
        keeper_update_interval_seconds=1.0, seed=1,
    )
    base = DEPTH_BASE
    arb_venue = VaultVenue(base=base, quote=prices[0].price * base,
                           params=params, fee_bps=VAULT_FEE_BPS)
    b1_venue = PassivePool(base=base, quote=prices[0].price * base,
                           fee=tier_bps / 10_000.0)
    arb = simulate(venue_name="ArbSwap", venue=arb_venue, **common)
    b1 = simulate(venue_name="B1_passive", venue=b1_venue, **common)
    diffs = [a - b for a, b in zip(_pnl_increments(arb), _pnl_increments(b1))]
    mean, lo, hi = _moving_block_ci(diffs, block=BOOTSTRAP_BLOCK_SECONDS,
                                    resamples=BOOTSTRAP_RESAMPLES,
                                    seed=BOOTSTRAP_SEED)
    total_notional = sum(n for _, _, n in flow.orders) or 1.0
    lookup = {i: p for i, p in enumerate(arb.price_path)}.get
    arb_markout = notional_weighted_markout(arb.trades, 2, lookup)
    b1_markout = notional_weighted_markout(b1.trades, 2, lookup)
    return {
        "day": day,
        "b1_fee_bps": tier_bps,
        "seconds": len(prices),
        "depth_base": base,
        "agg_trades": len(flow.orders),
        "total_notional_quote": total_notional,
        "sigma_per_sqrt_s": _realised_sigma([p.price for p in prices]),
        "arb_hedged_pnl": hedged_pnl(arb.value_path, arb.base_path, arb.price_path),
        "b1_hedged_pnl": hedged_pnl(b1.value_path, b1.base_path, b1.price_path),
        "pnl_diff_quote": sum(diffs),
        "pnl_diff_bps_notional": sum(diffs) / total_notional * 10_000.0,
        "ci_mean_quote_per_s": mean,
        "ci_95_quote_per_s": [lo, hi],
        "ci_above_zero": lo > 0,
        "arb_markout_2s_bps": arb_markout,
        "b1_markout_2s_bps": b1_markout,
        "markout_diff_2s_bps": arb_markout - b1_markout,
        "arb_quiet_half_spread_bps": retail_half_spread_bps(arb.trades, lookup,
                                                            step_seconds=1.0),
        "b1_quiet_half_spread_bps": retail_half_spread_bps(b1.trades, lookup,
                                                           step_seconds=1.0),
        "arb_trades": len(arb.trades),
        "arb_rejects": arb.rejects,
    }


def high_vol_held_out(params: QuoteParams) -> dict:
    if HIGH_VOL_CACHE.exists():
        print(f"[F5] reusing {HIGH_VOL_CACHE.name}", flush=True)
        return json.loads(HIGH_VOL_CACHE.read_text())
    out = {}
    for day in HIGH_VOL_DAYS:
        points = _high_vol_points(day)
        reports = run_venues(points, params=params, passive_fee=PASSIVE_FEE,
                             vault_fee_bps=VAULT_FEE_BPS)
        arb = reports["ArbSwap"]
        b1 = reports["B1_passive"]
        prices = [p.price for p in points]
        e1 = (arb.hedged_pnl - b1.hedged_pnl) / abs(b1.hedged_pnl) if b1.hedged_pnl else 0.0
        out[day] = {
            "sigma_per_sqrt_s": _realised_sigma(prices),
            "sigma_ratio_vs_ref": _realised_sigma(prices) / SIGMA_REF,
            "seconds": len(points),
            "reports": {name: asdict(report) for name, report in reports.items()},
            "E1_pct": e1 * 100.0,
            "E2_arb_markout_2s_bps": arb.markout_2s_bps,
            "E3_arb_hedged_pnl": arb.hedged_pnl,
            "E3_b2_hedged_pnl": reports["B2_fixed_spread"].hedged_pnl,
            "E4_arb_quiet_half_spread_bps": arb.quiet_half_spread_bps,
            "E4_b1_quiet_half_spread_bps": b1.quiet_half_spread_bps,
            "E5_throttle_ablation_quote": arb.hedged_pnl - reports["B3_no_throttle"].hedged_pnl,
            "E6_arb_fill_rate": arb.fill_rate,
            "E6_b4_fill_rate": reports["B4_no_honesty"].fill_rate,
        }
    HIGH_VOL_CACHE.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n")
    return out


def evaluate() -> dict:
    params = load_frozen_params()
    print("[F5] high-volatility held-out windows (E1-E6)...", flush=True)
    high_vol = high_vol_held_out(params)
    print("[F5] T-A.i real aggTrades flow + bootstrap CIs...", flush=True)
    rows = []
    for day in list(HIGH_VOL_DAYS) + list(AGGTRADES_DAYS):
        for tier in B1_FEE_TIERS_BPS:
            try:
                row = _run_real_flow_day(day, params, tier)
            except (ValueError, ZeroDivisionError) as exc:
                row = {"day": day, "b1_fee_bps": tier,
                       "error": f"{type(exc).__name__}: {exc}", "ci_above_zero": False}
            rows.append(row)
            if "error" in row:
                print(f"  {day} B1={tier:>4.0f}bps: ERROR {row['error']}", flush=True)
                continue
            print(f"  {day} B1={tier:>4.0f}bps: diff {row['pnl_diff_bps_notional']:+.4f} bps "
                  f"markout {row['markout_diff_2s_bps']:+.3f} bps "
                  f"above0={row['ci_above_zero']}", flush=True)
    # T-A.i criterion (Amendment 4): CI lower bound > 0 in >=3 of 5 days, at
    # least one high-vol day. Evaluate on the 1 bps tier (the headline tier).
    headline = [r for r in rows if r["b1_fee_bps"] == 1.0]
    days_above = [r["day"] for r in headline if r["ci_above_zero"]]
    high_vol_above = [d for d in days_above if d in HIGH_VOL_DAYS]
    t_a_i = {
        "met": len(days_above) >= 3 and len(high_vol_above) >= 1,
        "days_with_ci_above_zero": days_above,
        "of_days": [r["day"] for r in headline],
        "high_vol_days_above_zero": high_vol_above,
    }
    return {
        "amendment": "THESIS.md Amendment 4 (2026-10-10)",
        "sigma_ref_per_sqrt_s": SIGMA_REF,
        "high_vol_days": list(HIGH_VOL_DAYS),
        "agg_trades_days": list(AGGTRADES_DAYS),
        "b1_fee_tiers_bps": list(B1_FEE_TIERS_BPS),
        "bootstrap": {"block_seconds": BOOTSTRAP_BLOCK_SECONDS,
                      "resamples": BOOTSTRAP_RESAMPLES, "seed": BOOTSTRAP_SEED},
        "cu": {"update_quote": CU_UPDATE_QUOTE, "swap": CU_SWAP},
        "high_vol_held_out": high_vol,
        "real_flow_rows": rows,
        "T_A_i": t_a_i,
    }


def main() -> None:
    payload = evaluate()
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(f"[write] {OUT.relative_to(ROOT)}")
    print("T-A.i:", payload["T_A_i"])


if __name__ == "__main__":
    main()
