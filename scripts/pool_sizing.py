#!/usr/bin/env python3
"""S2.2/S2.3 — pool sizing from the frozen config using the program's exact
integer formulas (mirrors `vault/keeper/src/lib.rs::compute_quote` and `arb-math`
`Level::liquidity_for_*` / `base_capacity` / `quote_capacity`).

The human oracle price is normalized ONCE to the raw `quote-atoms per base-atom`
price, exactly as the corrected keeper does (`normalize_price_q64`).

TEST TOKEN, devnet only. Nothing here submits a transaction.

Run:
  .venv/bin/python scripts/pool_sizing.py --price 109.25290338 --base-tokens 2000
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from simulation.reference.ladder import (  # noqa: E402
    Level,
    liquidity_for_base_capacity,
)

BPS = 10_000
Q64 = 1 << 64
FROZEN = ROOT / "simulation/data/results/frozen_params.json"
BASE_DECIMALS = 9   # tSOL
QUOTE_DECIMALS = 6  # tUSDC


def liquidity_for_quote_capacity(sqrt_lo: int, sqrt_hi: int, capacity: int) -> int:
    """Bid-side liquidity implied by a quote capacity (mirrors arb-math)."""
    delta = sqrt_hi - sqrt_lo
    if sqrt_lo <= 0 or delta <= 0 or capacity < 0:
        raise ValueError("invalid liquidity derivation")
    return (capacity << 128) // delta


def sqrt_q64(x: int) -> int:
    """floor(sqrt(x)) in Q64.64 for a Q64.64 input (mirrors arb-math)."""
    return math.isqrt(x << 64)


def normalize_price_q64(price_q64: int, base_decimals: int, quote_decimals: int) -> int:
    """Mirror the keeper's S2.3 normalization:
    `P_raw = P * 10^(quote_decimals - base_decimals)` (division floors)."""
    if price_q64 == 0 or base_decimals == quote_decimals:
        return price_q64
    if quote_decimals > base_decimals:
        return price_q64 * 10 ** (quote_decimals - base_decimals)
    return price_q64 // 10 ** (base_decimals - quote_decimals)


def mul_div_floor(a: int, b: int, d: int) -> int:
    return (a * b) // d


def compute_sizing(
    price: float,
    base_tokens: float = 2000.0,
    depth_bps: int = 10_000,
    demo_tokens: float = 10.0,
    base_decimals: int = BASE_DECIMALS,
    quote_decimals: int = QUOTE_DECIMALS,
    legacy_usd_ladder: bool = False,
) -> dict:
    """Return the sizing table + constraints for the given reserves/price."""
    frozen = json.loads(FROZEN.read_text())["params"]
    weights = frozen["weights_bps"]
    offsets = frozen["offsets_bps"]
    util_bps = int(round(frozen["utilization_max"] * BPS))
    spread_floor_bps = int(round(frozen["spread_floor"] * BPS))
    assert sum(weights) == BPS, weights

    price_q64 = int(round(price * Q64))
    base_atoms = int(round(base_tokens * 10 ** base_decimals))
    quote_atoms = base_atoms * price_q64 // Q64 // 10 ** (base_decimals - quote_decimals)

    # Correct: ladder price is the raw-atom price. Legacy flag reproduces the
    # pre-S2.3 bug (ladder at the human price) for the regression comparison.
    reservation_price = price_q64 if legacy_usd_ladder else normalize_price_q64(
        price_q64, base_decimals, quote_decimals
    )
    ask_spread = bid_spread = spread_floor_bps
    depth = depth_bps

    ask_total = base_atoms * util_bps * depth // (BPS * BPS)
    bid_total = quote_atoms * util_bps * depth // (BPS * BPS)

    def build(caps, side):
        levels, previous = [], 0
        for i, cap in enumerate(caps):
            if side == "ask":
                lo_f, hi_f = BPS + ask_spread + previous, BPS + ask_spread + offsets[i]
            else:
                hi_f, lo_f = BPS - (bid_spread + previous), BPS - (bid_spread + offsets[i])
            lo = sqrt_q64(mul_div_floor(reservation_price, lo_f, BPS))
            hi = sqrt_q64(mul_div_floor(reservation_price, hi_f, BPS))
            liq = (liquidity_for_base_capacity(lo, hi, cap) if side == "ask"
                   else liquidity_for_quote_capacity(lo, hi, cap))
            levels.append(Level(sqrt_lo=lo, sqrt_hi=hi, liquidity=liq))
            previous = offsets[i]
        return levels

    asks = build([ask_total * w // BPS for w in weights], "ask")
    bids = build([bid_total * w // BPS for w in weights], "bid")
    l1_ask_base = asks[0].base_capacity()
    l1_ask_quote = asks[0].quote_capacity()
    l1_bid_base = bids[0].base_capacity()
    l1_bid_quote = bids[0].quote_capacity()
    return {
        "price": price,
        "base_atoms": base_atoms,
        "quote_atoms": quote_atoms,
        "util_bps": util_bps,
        "weights_bps": weights,
        "offsets_bps": offsets,
        "reservation_price_q64": reservation_price,
        "ask_total": ask_total,
        "bid_total": bid_total,
        "asks": asks,
        "bids": bids,
        "l1_ask_base": l1_ask_base,
        "l1_ask_quote": l1_ask_quote,
        "l1_bid_base": l1_bid_base,
        "l1_bid_quote": l1_bid_quote,
        "demo_base": int(round(demo_tokens * 10 ** base_decimals)),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--price", type=float, required=True, help="SOL/USD from Pyth")
    ap.add_argument("--base-tokens", type=float, default=2000.0, help="base reserve (tSOL)")
    ap.add_argument("--depth-bps", type=int, default=10_000, help="keeper depth throttle")
    ap.add_argument("--demo-tokens", type=float, default=10.0, help="demo swap (tSOL)")
    ap.add_argument("--max-quote-size", type=int, default=100_000_000_000)
    ap.add_argument("--flow-bps", type=int, default=1_000)
    ap.add_argument("--edge-loss-bps", type=int, default=50)
    ap.add_argument("--legacy-usd-ladder", action="store_true",
                    help="reproduce the pre-S2.3 bug (ladder at the human price)")
    args = ap.parse_args()

    s = compute_sizing(args.price, args.base_tokens, args.depth_bps, args.demo_tokens,
                       legacy_usd_ladder=args.legacy_usd_ladder)
    price_q64 = int(round(args.price * Q64))
    base_atoms, quote_atoms = s["base_atoms"], s["quote_atoms"]
    print(f"TEST TOKEN, devnet | price SOL/USD = {args.price}")
    print(f"ladder_price_q64 = {s['reservation_price_q64']} "
          f"(raw quote-atoms/base-atom, normalized once)")
    print(f"reserves: base={base_atoms} ({base_atoms/1e9:.3f} tSOL)  "
          f"quote={quote_atoms} ({quote_atoms/1e6:.3f} tUSDC)  depth={args.depth_bps} bps")
    print(f"ask_base_capacity_total={s['ask_total']} ({s['ask_total']/1e9:.3f} tSOL)  "
          f"bid_quote_capacity_total={s['bid_total']} ({s['bid_total']/1e6:.3f} tUSDC)")
    for i, w in enumerate(s["weights_bps"]):
        a, b = s["asks"][i], s["bids"][i]
        print(f"ask{i+1} w={w}: base={a.base_capacity()/1e9:.4f} tSOL "
              f"quote={a.quote_capacity()/1e6:.4f} tUSDC | "
              f"bid{i+1}: base={b.base_capacity()/1e9:.4f} tSOL "
              f"quote={b.quote_capacity()/1e6:.4f} tUSDC")

    l1a_base, l1a_quote = s["l1_ask_base"], s["l1_ask_quote"]
    human_ratio = (l1a_quote / 1e6) / (l1a_base / 1e9) if l1a_base else 0
    demo = s["demo_base"]
    flow_cap = base_atoms * args.flow_bps // BPS
    avail_value = (base_atoms * price_q64 >> 64) // 10 ** (BASE_DECIMALS - QUOTE_DECIMALS) + quote_atoms
    loss_bound = avail_value * args.edge_loss_bps // BPS
    print(f"level1 ask: base={l1a_base/1e9:.4f} tSOL quote={l1a_quote/1e6:.4f} tUSDC "
          f"human_ratio={human_ratio:.4f} (expect ~{args.price})")
    print(f"demo={args.demo_tokens} tSOL <= half level1? {demo <= l1a_base//2} "
          f"({demo/l1a_base*100:.2f}% of level1)")
    print(f"demo/base={demo/base_atoms*100:.3f}%  sim mean trade/depth="
          f"{40/(1000*12)*100:.3f}%")
    print(f"flow_cap={flow_cap/1e9:.4f} tSOL (demo<=cap {demo <= flow_cap})")
    print(f"available_value={avail_value/1e6:.2f} tUSDC edge_bound({args.edge_loss_bps}bps)="
          f"{loss_bound/1e6:.2f} tUSDC")


if __name__ == "__main__":
    main()
