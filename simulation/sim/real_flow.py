"""Real Binance aggTrades as the order-flow layer (Item F-11), and B1
calibration against the paper's passive targets (Item F-08).

Raw aggTrades columns (Binance Vision): aggId, price, qty, firstId, lastId,
transact_time_us, _, is_buyer_maker. `is_buyer_maker=True` means the taker is a
seller (aggressor sells base), so `side="sell"`, else `side="buy"`.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass, field
from pathlib import Path

from simulation.sim.engine import simulate
from simulation.sim.flow import InformedFlow
from simulation.sim.metrics import notional_weighted_markout, retail_half_spread_bps
from simulation.sim.oracle import OracleModel
from simulation.sim.price_source import PricePoint
from simulation.sim.venues import PassivePool, VaultVenue

RAW = Path("simulation/data/raw")


@dataclass
class RealFlow:
    """A fixed list of real (second, side, quote_notional) orders."""

    orders: list[tuple[int, str, float]] = field(default_factory=list)

    def arrivals(self, steps: int, *, step_seconds: float = 1.0):  # noqa: ARG002
        return self.orders


def load_day(path: Path, *, max_seconds: int = 3_600) -> tuple[list[PricePoint], RealFlow]:
    """One aggTrades day -> (1s reference path, real flow orders)."""
    rows: list[tuple[float, int, str, float]] = []  # (second, side, price, qty)
    t0 = None
    with path.open() as handle:
        reader = csv.reader(handle)
        for row in reader:
            price = float(row[1])
            qty = float(row[2])
            t_us = int(row[5])
            buyer_maker = row[-1].lower() == "true"
            sec = t_us // 1_000_000
            if t0 is None:
                t0 = sec
            rel = sec - t0
            if rel >= max_seconds:
                break
            side = "sell" if buyer_maker else "buy"
            rows.append((rel, side, price, qty))
    # Reference path: last trade price per second.
    last_price: dict[int, float] = {}
    for rel, _side, price, _qty in rows:
        last_price[rel] = price
    prices: list[PricePoint] = []
    running = None
    for sec in range(max_seconds):
        running = last_price.get(sec, running)
        if running is None:
            continue
        prices.append(PricePoint(second=sec, price=running))
    orders = [(rel, side, qty * price) for rel, side, price, qty in rows]
    return prices, RealFlow(orders=orders)


def _metrics(result):
    lookup = {i: p for i, p in enumerate(result.price_path)}.get
    step = result.step_seconds
    return {
        "trades": len(result.trades),
        "markout_2s_bps": notional_weighted_markout(
            result.trades, max(1, round(2.0 / step)), lookup),
        "half_spread_bps": retail_half_spread_bps(result.trades, lookup,
                                                 step_seconds=step),
    }


def run_b1(prices, flow, *, depth_mult: float = 1.0, fee: float = 0.0001):
    # The pool must be initialized at the day's price, not a hard-coded 150,
    # otherwise every fill is off mid by the price level.
    base = 1_000.0 * depth_mult
    pool = PassivePool(base=base, quote=prices[0].price * base, fee=fee)
    result = simulate(
        venue_name="B1", venue=pool, prices=prices,
        oracle=OracleModel(seed=1), noise=flow, informed=InformedFlow(max_size=0.0),
        step_seconds=1.0, source_step_seconds=1.0, slot_seconds=0.4,
        keeper_update_interval_seconds=1.0, seed=1,
    )
    return _metrics(result)


def run_arb(prices, flow, *, depth_mult: float = 1.0):
    base = 1_000.0 * depth_mult
    venue = VaultVenue(base=base, quote=prices[0].price * base)
    result = simulate(
        venue_name="ArbSwap", venue=venue, prices=prices,
        oracle=OracleModel(seed=1), noise=flow, informed=InformedFlow(max_size=0.0),
        step_seconds=1.0, source_step_seconds=1.0, slot_seconds=0.4,
        keeper_update_interval_seconds=1.0, seed=1,
    )
    return _metrics(result)


if __name__ == "__main__":
    day = RAW / "SOLUSDT-aggTrades-2026-09-10.csv"
    prices, flow = load_day(day, max_seconds=3_600)
    print(f"real day: {len(prices)} seconds, {len(flow.orders)} aggTrades")
    print("== B1 vs depth (real flow) ==")
    for d in (1, 4, 16, 64, 256):
        m = run_b1(prices, flow, depth_mult=d)
        print(f"  depth×{d:>3}: {m}")
    print("== ArbSwap depth×1 ==", run_arb(prices, flow))
