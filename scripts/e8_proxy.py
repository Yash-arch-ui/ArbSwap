#!/usr/bin/env python3
"""E8 (P1) - real-pool quote observability + round-trip quote-cost proxy.

This samples **real Solana routing quotes** from the public Jupiter quote API
(``lite-api.jup.ag``; no key) and reports:

- quote **persistence** (how often the quoted output changes between consecutive
  samples), with a 95% Wilson interval, overall and per route;
- a **round-trip quote-cost proxy**: quote SOL->USDC then immediately quote the
  received USDC back to SOL; the loss versus the starting SOL is a *measured,
  executable* quote cost. It is a **proxy**, not a fill gap: no transaction is
  submitted (a fill gap needs funded mainnet trades, out of scope for an agent).

The endpoint is rate-limited; the default interval is 2 s and the default run is
60 min. Raw samples are written to ``e8_proxy_raw.json`` and the summary to
``e8_proxy.json``. Missing/malformed/stale responses are recorded as ``error``
and excluded from metrics.

Run: ``.venv/bin/python scripts/e8_proxy.py --minutes 60 --interval 2``
"""

from __future__ import annotations

import argparse
import json
import math
import time
import urllib.request
from pathlib import Path

SOL = "So11111111111111111111111111111111111111112"  # wrapped SOL, 32-byte mint
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
ONE_SOL = 1_000_000_000  # 1 SOL in lamports
BASE = "https://lite-api.jup.ag/swap/v1/quote"
RAW = Path("simulation/data/results/e8_proxy_raw.json")
OUT = Path("simulation/data/results/e8_proxy.json")


def _quote(input_mint: str, output_mint: str, amount: int) -> dict:
    url = (f"{BASE}?inputMint={input_mint}&outputMint={output_mint}"
           f"&amount={amount}&slippageBps=50")
    with urllib.request.urlopen(url, timeout=20) as resp:  # noqa: S310 (fixed host)
        d = json.load(resp)
    route = [r.get("swapInfo", {}).get("label") for r in d.get("routePlan", [])]
    return {"out_amount": int(d["outAmount"]),
            "impact_pct": float(d.get("priceImpactPct", 0) or 0),
            "route": route}


def _wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def _bootstrap_mean_ci(values: list[float], *, seed: int = 20261010,
                       resamples: int = 2000) -> tuple[float, float, float]:
    import random
    if not values:
        return (0.0, 0.0, 0.0)
    rng = random.Random(seed)
    n = len(values)
    means = []
    for _ in range(resamples):
        means.append(sum(values[rng.randrange(n)] for _ in range(n)) / n)
    means.sort()
    return (sum(values) / n, means[int(0.025 * len(means))],
            means[int(0.975 * len(means)) - 1])


def run(minutes: float, interval_s: float) -> tuple[dict, list[dict]]:
    ticks = max(2, int(minutes * 60 / interval_s))
    samples: list[dict] = []
    for i in range(ticks):
        t = int(time.time())
        try:
            fwd = _quote(SOL, USDC, ONE_SOL)
            rt_bps = None
            if fwd["out_amount"] > 0:
                rev = _quote(USDC, SOL, fwd["out_amount"])
                rt_bps = 1e4 * (1.0 - rev["out_amount"] / ONE_SOL)
            samples.append({"t": t, "out_amount": fwd["out_amount"],
                            "impact_pct": fwd["impact_pct"], "route": fwd["route"],
                            "round_trip_bps": rt_bps})
        except Exception as exc:  # noqa: BLE001
            samples.append({"t": t, "error": str(exc)})
        if i + 1 < ticks:
            time.sleep(interval_s)

    ok = [s for s in samples if "out_amount" in s]
    changes = 0
    for a, b in zip(ok, ok[1:]):
        if a["out_amount"] != b["out_amount"]:
            changes += 1
    n_pairs = max(0, len(ok) - 1)
    lo, hi = _wilson(changes, n_pairs)
    rt = [s["round_trip_bps"] for s in ok if s["round_trip_bps"] is not None]
    rt_mean, rt_lo, rt_hi = _bootstrap_mean_ci(rt)
    by_route: dict[str, dict] = {}
    for a, b in zip(ok, ok[1:]):
        key = "|".join(b["route"])
        entry = by_route.setdefault(key, {"count": 0, "changes": 0})
        entry["count"] += 1
        entry["changes"] += int(a["out_amount"] != b["out_amount"])

    summary = {
        "kind": "proxy (real Jupiter routing quotes), NOT a fill gap",
        "source": BASE,
        "started": samples[0]["t"] if samples else None,
        "duration_s": (samples[-1]["t"] - samples[0]["t"]) if len(samples) > 1 else 0,
        "interval_s": interval_s,
        "samples": len(samples),
        "ok": len(ok),
        "error_rate": 1.0 - (len(ok) / len(samples)) if samples else None,
        "change_rate": (changes / n_pairs) if n_pairs else None,
        "change_rate_ci95": [lo, hi],
        "mean_change_pairs": n_pairs,
        "round_trip_bps_mean": rt_mean,
        "round_trip_bps_ci95": [rt_lo, rt_hi],
        "round_trip_bps_n": len(rt),
        "by_route": by_route,
        "routes": sorted({tuple(s["route"]) for s in ok}, key=str),
    }
    return summary, samples


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--minutes", type=float, default=60.0)
    ap.add_argument("--interval", type=float, default=2.0)
    args = ap.parse_args()
    summary, samples = run(args.minutes, args.interval)
    RAW.parent.mkdir(parents=True, exist_ok=True)
    RAW.write_text(json.dumps(samples, default=list) + "\n")
    OUT.write_text(json.dumps(summary, indent=2, default=list) + "\n")
    print(f"wrote {OUT}: {summary['ok']}/{summary['samples']} ok over "
          f"{summary['duration_s']}s, change_rate={summary['change_rate']}, "
          f"round_trip={summary['round_trip_bps_mean']:.3f} bps "
          f"CI{summary['round_trip_bps_ci95']}")


if __name__ == "__main__":
    main()
