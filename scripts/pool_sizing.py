#!/usr/bin/env python3
"""S2.2 — pool sizing from the frozen config using the program's exact integer
formulas (mirrors `vault/keeper/src/lib.rs::compute_quote` and `arb-math`
`Level::liquidity_for_*` / `base_capacity` / `quote_capacity`).

TEST TOKEN, devnet only. Nothing here submits a transaction.

Run:
  .venv/bin/python scripts/pool_sizing.py --price 109.25290338 \
      --base-tokens 2000 --depth-bps 10000
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
import sys  # noqa: E402

sys.path.insert(0, str(ROOT))
from simulation.reference.ladder import (  # noqa: E402
    Level,
    liquidity_for_base_capacity,
)


def liquidity_for_quote_capacity(sqrt_lo: int, sqrt_hi: int, capacity: int) -> int:
    """Bid-side liquidity implied by a quote capacity (mirrors arb-math)."""
    delta = sqrt_hi - sqrt_lo
    if sqrt_lo <= 0 or delta <= 0 or capacity < 0:
        raise ValueError("invalid liquidity derivation")
    return (capacity << 128) // delta

BPS = 10_000
Q64 = 1 << 64
FROZEN = ROOT / "simulation/data/results/frozen_params.json"
BASE_DECIMALS = 9   # tSOL
QUOTE_DECIMALS = 6  # tUSDC


def sqrt_q64(x: int) -> int:
    """floor(sqrt(x)) in Q64.64 for a Q64.64 input (mirrors arb-math)."""
    return math.isqrt(x << 64)


def mul_div_floor(a: int, b: int, d: int) -> int:
    return (a * b) // d


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--price", type=float, required=True, help="SOL/USD from Pyth")
    ap.add_argument("--base-tokens", type=float, default=2000.0, help="base reserve (tSOL)")
    ap.add_argument("--depth-bps", type=int, default=10_000, help="keeper depth throttle")
    ap.add_argument("--demo-tokens", type=float, default=10.0, help="demo swap (tSOL)")
    ap.add_argument("--max-quote-size", type=int, default=100_000_000_000,
                    help="max_quote_size cap (raw amount_in units)")
    ap.add_argument("--flow-bps", type=int, default=1_000, help="max_window_flow_bps")
    ap.add_argument("--edge-loss-bps", type=int, default=50, help="max_edge_loss_bps")
    ap.add_argument("--ladder-scale", type=int, default=1,
                    help="divide the ladder price by this (base_atom_scale for a "
                         "correct 9/6 raw-atom ladder); default 1 = as-built keeper")
    args = ap.parse_args()

    frozen = json.loads(FROZEN.read_text())["params"]
    weights = frozen["weights_bps"]
    offsets = frozen["offsets_bps"]
    util_bps = int(round(frozen["utilization_max"] * BPS))
    spread_floor_bps = int(round(frozen["spread_floor"] * BPS))
    assert sum(weights) == BPS, weights

    price_q64 = int(round(args.price * Q64))
    base_atom_scale = 10 ** (BASE_DECIMALS - QUOTE_DECIMALS)
    ladder_scale = args.ladder_scale

    base_atoms = int(round(args.base_tokens * 10 ** BASE_DECIMALS))
    # balanced quote reserve = base valued at price, in quote atoms
    quote_atoms = base_atoms * price_q64 // Q64 // base_atom_scale

    reservation_price = price_q64 // ladder_scale  # as-built: scale=1 (USD)
    ask_spread = spread_floor_bps
    bid_spread = spread_floor_bps

    depth = args.depth_bps
    ask_total = base_atoms * util_bps * depth // (BPS * BPS)
    bid_total = quote_atoms * util_bps * depth // (BPS * BPS)

    def build(level_caps, side):
        levels = []
        previous = 0
        for i, cap in enumerate(level_caps):
            if side == "ask":
                lo_f = BPS + ask_spread + previous
                hi_f = BPS + ask_spread + offsets[i]
            else:
                hi_f = BPS - (bid_spread + previous)
                lo_f = BPS - (bid_spread + offsets[i])
            lo = sqrt_q64(mul_div_floor(reservation_price, lo_f, BPS))
            hi = sqrt_q64(mul_div_floor(reservation_price, hi_f, BPS))
            if side == "ask":
                liq = liquidity_for_base_capacity(lo, hi, cap)
            else:
                liq = liquidity_for_quote_capacity(lo, hi, cap)
            levels.append(Level(sqrt_lo=lo, sqrt_hi=hi, liquidity=liq))
            previous = offsets[i]
        return levels

    ask_caps = [ask_total * w // BPS for w in weights]
    bid_caps = [bid_total * w // BPS for w in weights]
    asks = build(ask_caps, "ask")
    bids = build(bid_caps, "bid")

    print(f"TEST TOKEN, devnet | price SOL/USD = {args.price}  (price_q64={price_q64})")
    print(f"frozen: offsets_bps={offsets} weights_bps={weights} "
          f"utilization={frozen['utilization_max']} spread_floor_bps={spread_floor_bps}")
    print(f"base_atom_scale = 10^({BASE_DECIMALS}-{QUOTE_DECIMALS}) = {base_atom_scale}")
    print(f"ladder_price = oracle_price / ladder_scale = {args.price}/{ladder_scale} "
          f"(as-built keeper uses ladder_scale=1)")
    print(f"reserves: base={base_atoms} atoms ({args.base_tokens} tSOL)  "
          f"quote={quote_atoms} atoms ({quote_atoms/1e6:.6f} tUSDC)  depth={depth} bps")
    print(f"ask_base_capacity_total(planned) = {ask_total} ({ask_total/1e9:.3f} tSOL)")
    print(f"bid_quote_capacity_total(planned) = {bid_total} ({bid_total/1e6:.3f} tUSDC)")
    print()
    print("level | weight_bps |  base_cap(atoms)  base(tSOL) | quote_cap(atoms) quote(tUSDC) | liquidity")
    for i in range(len(weights)):
        ab = asks[i].base_capacity()
        aq = asks[i].quote_capacity()
        print(f"ask {i+1}  | {weights[i]:>10} | {ab:>16} {ab/1e9:>10.4f} | {aq:>16} {aq/1e6:>12.4f} | {asks[i].liquidity}")
    for i in range(len(weights)):
        bq = bids[i].quote_capacity()
        bb = bids[i].base_capacity()
        print(f"bid {i+1}  | {weights[i]:>10} | {bb:>16} {bb/1e9:>10.4f} | {bq:>16} {bq/1e6:>12.4f} | {bids[i].liquidity}")

    l1_ask_base = asks[0].base_capacity()
    l1_ask_quote = asks[0].quote_capacity()
    l1_bid_base = bids[0].base_capacity()
    l1_bid_quote = bids[0].quote_capacity()
    half_l1 = l1_ask_base // 2

    demo_base = int(round(args.demo_tokens * 10 ** BASE_DECIMALS))
    # demo buy-base: trader supplies quote to get <= 10 tSOL out of level 1
    demo_quote_in = l1_ask_quote * demo_base // l1_ask_base if l1_ask_base else 0

    print()
    print("=== demo-swap constraints ===")
    print(f"level1 ask base capacity = {l1_ask_base} atoms ({l1_ask_base/1e9:.4f} tSOL); "
          f"half = {half_l1/1e9:.4f} tSOL")
    print(f"level1 ask quote capacity (max buy-base amount_in) = {l1_ask_quote} atoms "
          f"({l1_ask_quote/1e6:.4f} tUSDC)")
    print(f"level1 bid base capacity = {l1_bid_base/1e9:.4f} tSOL; "
          f"quote capacity = {l1_bid_quote/1e6:.4f} tUSDC")
    print(f"demo = {args.demo_tokens} tSOL -> {demo_base} base atoms")
    print(f"  demo <= half level1-ask? {demo_base <= half_l1}  "
          f"({demo_base/l1_ask_base*100:.2f}% of level1)")
    print(f"  demo <= half the budget at depth={depth}? {demo_base <= l1_ask_base//2}")
    print(f"  sell-base amount_in = {demo_base} <= max_quote_size {args.max_quote_size}? "
          f"{demo_base <= args.max_quote_size}")
    print(f"  buy-base amount_in ~= {demo_quote_in} <= max_quote_size {args.max_quote_size}? "
          f"{demo_quote_in <= args.max_quote_size}")
    flow_cap = base_atoms * args.flow_bps // BPS
    print(f"  flow_cap = base_reserve*{args.flow_bps/ BPS:.2%} = {flow_cap/1e9:.4f} tSOL; "
          f"demo<=cap? {demo_base <= flow_cap}")
    avail_value = (base_atoms * price_q64 >> 64) // base_atom_scale + quote_atoms
    loss_bound = avail_value * args.edge_loss_bps // BPS
    print(f"  available_value = {avail_value/1e6:.2f} tUSDC; edge-loss bound "
          f"({args.edge_loss_bps} bps) = {loss_bound/1e6:.2f} tUSDC "
          f"(honest demo edge ~ +spread, far below bound)")
    print(f"  demo/total base reserves = {demo_base/base_atoms*100:.3f}%")
    sim_ratio = 40.0 / (1000.0 * 12.0)
    print(f"  simulator mean trade/depth (B1 fitted: mean_size 40 / (1000*12)) = {sim_ratio*100:.3f}%")


if __name__ == "__main__":
    main()
