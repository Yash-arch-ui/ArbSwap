"""Item F-10: a price-elastic multi-venue router.

Each real order is routed to the venue with the best executed price for the
trader among ArbSwap, the passive pool B1, and a competing tight propAMM-like
venue (a 0.3-1 bp half-spread around the reference). We report the volume
(notional) fill share per venue and the average executed half-spread.
"""

from __future__ import annotations

from dataclasses import dataclass

from simulation.reference.quote_math import QuoteParams
from simulation.sim.oracle import OracleModel
from simulation.sim.real_flow import load_day, RAW
from simulation.sim.venues import PassivePool, VaultVenue


@dataclass
class PropAmm:
    """A tight propAMM-like venue: exec at reference +/- `half_spread_bps`."""

    half_spread_bps: float = 0.5
    def price(self, side: str, reference: float) -> float:
        edge = self.half_spread_bps / 10_000.0
        return reference * (1.0 + edge) if side == "buy" else reference * (1.0 - edge)


def route(prices, flow, *, prop_half_spread_bps: float = 0.5, depth_mult: float = 1.0):
    base0 = prices[0].price
    base = 1_000.0 * depth_mult
    arb = VaultVenue(params=QuoteParams(), base=base, quote=base0 * base)
    b1 = PassivePool(base=base, quote=base0 * base, fee=0.0001)
    prop = PropAmm(half_spread_bps=prop_half_spread_bps)
    prev = None

    shares = {"ArbSwap": 0.0, "B1_passive": 0.0, "PropAMM": 0.0}
    counts = {"ArbSwap": 0, "B1_passive": 0, "PropAMM": 0}
    half_sum = {"ArbSwap": 0.0, "B1_passive": 0.0, "PropAMM": 0.0}

    orders_by_second: dict[int, list[tuple[str, float]]] = {}
    for sec, side, notional in flow.orders:
        orders_by_second.setdefault(sec, []).append((side, notional))

    for point in prices:
        sec, ref = point.second, point.price
        arb.refresh(price=ref, confidence=0.0, age=0.0, previous_price=prev)
        prev = ref
        for side, notional in orders_by_second.get(sec, []):
            if side == "buy":
                amount_in = notional              # quote in (buy base)
            else:
                amount_in = notional / ref        # base in (sell base)
            if amount_in <= 0:
                continue
            # Candidate executed prices (average) for the trader.
            prices_by_venue = {}
            try:
                prices_by_venue["ArbSwap"] = arb.preview(side, amount_in)
            except (ValueError, ZeroDivisionError):
                pass
            try:
                prices_by_venue["B1_passive"] = b1.preview(side, amount_in)
            except (ValueError, ZeroDivisionError):
                pass
            prices_by_venue["PropAMM"] = prop.price(side, ref)
            # Best for the trader: lowest for a buy, highest for a sell.
            key = min if side == "buy" else max
            choice = key(prices_by_venue, key=prices_by_venue.get)
            shares[choice] += notional
            counts[choice] += 1
            half_sum[choice] += abs(prices_by_venue[choice] - ref) / ref * 10_000.0
            # Execute on the chosen real venue.
            try:
                if choice == "ArbSwap":
                    arb.fill(side, amount_in)
                elif choice == "B1_passive":
                    b1.fill(side, amount_in)
            except (ValueError, ZeroDivisionError):
                pass

    total = sum(shares.values()) or 1.0
    rows = []
    for name in shares:
        rows.append({
            "venue": name,
            "orders": counts[name],
            "notional_share": shares[name] / total,
            "avg_exec_half_spread_bps": (half_sum[name] / counts[name]) if counts[name] else 0.0,
        })
    return rows


if __name__ == "__main__":
    prices, flow = load_day(RAW / "SOLUSDT-aggTrades-2026-09-10.csv", max_seconds=3_600)
    for prop_hs in (0.3, 0.5, 1.0):
        print(f"== propAMM half-spread {prop_hs} bp, ArbSwap/B1 depth x100 ==")
        for row in route(prices, flow, prop_half_spread_bps=prop_hs, depth_mult=100.0):
            print(f"  {row['venue']:10} orders={row['orders']:5} "
                  f"notional_share={row['notional_share']:6.1%} "
                  f"half_spread={row['avg_exec_half_spread_bps']:.3f}bps")
