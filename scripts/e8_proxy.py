#!/usr/bin/env python3
"""C4.7 - E8 read-only proxy: sample Jupiter SOL/USDC quotes and report quote
persistence (how often the quoted output changes between consecutive samples).

This is a **proxy**, not a fill gap. A fill gap needs funded mainnet trades
(out of scope for an agent). Uses the public Jupiter quote API
(``lite-api.jup.ag``); no key. Respect the endpoint's rate limits (default 2 s
between samples).

Run: ``.venv/bin/python scripts/e8_proxy.py --minutes 2``
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

SOL = "So11111111111111111111111111111111111111112"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
AMOUNT = 1_000_000_000  # 1 SOL
BASE = "https://lite-api.jup.ag/swap/v1/quote"
OUT = Path("simulation/data/results/e8_proxy.json")


def sample() -> dict:
    url = (f"{BASE}?inputMint={SOL}&outputMint={USDC}&amount={AMOUNT}&slippageBps=50")
    with urllib.request.urlopen(url, timeout=20) as resp:  # noqa: S310 (fixed host)
        d = json.load(resp)
    route = [r.get("swapInfo", {}).get("label") for r in d.get("routePlan", [])]
    return {"out_amount": int(d["outAmount"]), "impact_pct": float(d.get("priceImpactPct", 0)),
            "route": route}


def run(minutes: float, interval_s: float) -> dict:
    n = max(2, int(minutes * 60 / interval_s))
    samples = []
    for _ in range(n):
        try:
            samples.append(sample())
        except Exception as exc:  # noqa: BLE001
            samples.append({"error": str(exc)})
        time.sleep(interval_s)
    ok = [s for s in samples if "out_amount" in s]
    changes = 0
    bps = []
    for a, b in zip(ok, ok[1:]):
        if a["out_amount"] != b["out_amount"]:
            changes += 1
            bps.append(1e4 * abs(b["out_amount"] - a["out_amount"]) / a["out_amount"])
    return {
        "kind": "proxy (quote persistence), NOT a fill gap",
        "samples": len(samples), "ok": len(ok),
        "change_rate": (changes / (len(ok) - 1)) if len(ok) > 1 else None,
        "mean_change_bps": (sum(bps) / len(bps)) if bps else 0.0,
        "max_change_bps": max(bps) if bps else 0.0,
        "routes": sorted({tuple(s["route"]) for s in ok}),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--minutes", type=float, default=2.0)
    ap.add_argument("--interval", type=float, default=2.0)
    args = ap.parse_args()
    res = run(args.minutes, args.interval)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(res, indent=2, default=list) + "\n")
    print(f"wrote {OUT}: {res['ok']}/{res['samples']} ok, "
          f"change_rate={res['change_rate']}, mean_change={res['mean_change_bps']:.3f} bps")


if __name__ == "__main__":
    main()
