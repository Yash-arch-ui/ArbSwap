"""T2: price-elastic multi-venue router.

A single order stream is routed across three venues: ArbSwap, the passive pool
B1 (a fee tier), and a competing propAMM-like venue (half-spread 0.3-1.0 bp,
oracle-latency-limited repricing). Noise orders go to the best executed price
(with a configurable share of price-insensitive flow and a user slippage
tolerance); the informed arbitrageur hits whichever venue is most stale, sized to
maximise its profit. We report per-venue volume share, fill share, 2s markout,
quiet half-spread, rejection rate and quote-vs-fill gap.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

from simulation.reference.quote_math import QuoteParams
from simulation.sim.flow import InformedFlow, NoiseFlow
from simulation.sim.flow_config import NOISE_ARRIVAL_RATE, NOISE_MEAN_SIZE, pool_kwargs
from simulation.sim.metrics import (
    TradeRecord,
    notional_weighted_gap,
    notional_weighted_markout,
    retail_half_spread_bps,
)
from simulation.sim.oracle import OracleModel
from simulation.sim.venues import PassivePool, VaultVenue


@dataclass
class Venue:
    name: str
    kind: str  # "vault" | "pool" | "prop"
    fee_bps: float = 1.0
    prop_half_spread_bps: float = 0.5
    latency_steps: int = 1
    venue: object = None
    trades: list = field(default_factory=list)
    orders: int = 0
    notional: float = 0.0
    fills: int = 0
    rejects: int = 0


def _build(kind, *, params, b1_fee, prop_hs, latency_steps, start_price):
    kw = pool_kwargs(start_price)
    if kind == "vault":
        return Venue("ArbSwap", "vault", venue=VaultVenue(params=params, **kw))
    if kind == "pool":
        return Venue("B1_passive", "pool", fee_bps=b1_fee,
                     venue=PassivePool(fee=b1_fee / 10_000.0, **kw))
    return Venue("PropAMM", "prop", prop_half_spread_bps=prop_hs,
                 latency_steps=latency_steps)


def _prop_price(venue: Venue, side: str, ref: float) -> float:
    edge = venue.prop_half_spread_bps / 10_000.0
    return ref * (1.0 + edge) if side == "buy" else ref * (1.0 - edge)


def _exec_price(venue: Venue, side: str, amount_in: float, ref: float, prop_ref: float):
    """Average executed price for the trader, or None if it cannot fill."""
    if venue.kind == "prop":
        return _prop_price(venue, side, prop_ref)
    try:
        return venue.venue.preview(side, amount_in)
    except (ValueError, ZeroDivisionError):
        return None


def route_window(prices, *, params=None, b1_fee=1.0, prop_hs=0.5, prop_latency_s=1.0,
                 insensitive_share=0.2, slippage_bps=1.0, seed=20261006,
                 informed_max_notional=5_000.0, informed_enabled=True, include_prop=True):
    params = params or QuoteParams()
    venues = [
        _build("vault", params=params, b1_fee=b1_fee, prop_hs=prop_hs, latency_steps=1, start_price=prices[0].price),
        _build("pool", params=params, b1_fee=b1_fee, prop_hs=prop_hs, latency_steps=1, start_price=prices[0].price),
    ]
    if include_prop:
        venues.append(_build("prop", params=params, b1_fee=b1_fee, prop_hs=prop_hs,
                             latency_steps=max(1, round(prop_latency_s / 0.4)), start_price=prices[0].price))
    rng = random.Random(seed)
    noise = NoiseFlow(seed=seed, arrival_rate=NOISE_ARRIVAL_RATE, mean_size=NOISE_MEAN_SIZE)
    informed = InformedFlow()
    ref_by_step = {p.second: p.price for p in prices}
    prop_ref = prices[0].price
    prev = None

    orders_by_step: dict[int, list[tuple[str, float]]] = {}
    for step, side, size in noise.arrivals(len(prices), step_seconds=1.0):
        orders_by_step.setdefault(step, []).append((side, size))

    for point in prices:
        step, ref = point.second, point.price
        # PropAMM reprices on a delayed oracle.
        prop_ref = ref_by_step.get(max(0, step - (venues[2].latency_steps if include_prop else 1)), prop_ref)
        venues[0].venue.refresh(price=ref, confidence=0.0, age=0.0, previous_price=prev)
        prev = ref

        def record(v, side, amount_in, exec_price):
            notional = amount_in if side == "buy" else amount_in * ref
            base_amt = notional / exec_price if exec_price else 0.0
            v.trades.append((step, side, exec_price, ref, notional, base_amt))

        # --- informed: hit the most stale venue, sized to a notional cap ---
        edges = []
        for v in venues:
            p = _exec_price(v, "buy", informed_max_notional, ref, prop_ref)
            if p is not None and p < ref:
                edges.append((10_000.0 * (ref - p) / p, v, "buy"))
            p = _exec_price(v, "sell", informed_max_notional, ref, prop_ref)
            if p is not None and p > ref:
                edges.append((10_000.0 * (p - ref) / ref, v, "sell"))
        if edges and informed_enabled:
            _edge, v, side = max(edges, key=lambda e: e[0])
            amount_in = informed_max_notional if side == "buy" else informed_max_notional / ref
            _apply(v, side, amount_in, ref, prop_ref, record)

        # --- noise: price-insensitive share, else best exec within tolerance ---
        for side, size in orders_by_step.get(step, []):
            amount_in = size if side == "buy" else size / ref
            if rng.random() < insensitive_share:
                target = venues[1]  # price-insensitive -> B1
            else:
                quotes = {v.name: _exec_price(v, side, amount_in, ref, prop_ref) for v in venues}
                quotes = {k: q for k, q in quotes.items() if q is not None}
                if not quotes:
                    continue
                best = min(quotes.values()) if side == "buy" else max(quotes.values())
                tol = best * (1 + slippage_bps / 10_000.0) if side == "buy" else best * (1 - slippage_bps / 10_000.0)
                eligible = [v for v in venues
                            if quotes.get(v.name) is not None
                            and ((side == "buy" and quotes[v.name] <= tol)
                                 or (side == "sell" and quotes[v.name] >= tol))]
                target = min(eligible, key=lambda v: quotes[v.name]) if side == "buy" else max(eligible, key=lambda v: quotes[v.name])
            _apply(target, side, amount_in, ref, prop_ref, record)

    total_notional = sum(v.notional for v in venues) or 1.0
    total_fills = sum(v.fills for v in venues) or 1
    rows = []
    for v in venues:
        trades = [TradeRecord(second=s, trader_side=sd, base_amount=ba, quote_amount=nt,
                              exec_price=ep, mid_at_fill=m)
                  for (s, sd, ep, m, nt, ba) in v.trades]
        lookup = ref_by_step.get
        mo = notional_weighted_markout(trades, 2, lookup)
        halves = sorted(abs(t[2] - t[3]) / t[3] * 10_000.0 for t in v.trades)
        def _pct(p):
            return halves[min(len(halves) - 1, int(p * len(halves)))] if halves else 0.0
        rows.append({
            "venue": v.name,
            "orders": v.orders,
            "notional_quote": v.notional,
            "volume_share": v.notional / total_notional,
            "fill_share": v.fills / total_fills,
            "markout_2s_bps": mo,
            "hedged_pnl_quote": mo * v.notional / 10_000.0,  # venue 2s PnL
            "quiet_half_spread_bps": retail_half_spread_bps(trades, lookup, step_seconds=1.0),
            "half_spread_p50_bps": _pct(0.50),
            "half_spread_p95_bps": _pct(0.95),
            "gap_bps": notional_weighted_gap(trades),
            "rejection_rate": (v.rejects / v.orders) if v.orders else 0.0,
        })
    return rows


def _apply(v: Venue, side: str, amount_in: float, ref: float, prop_ref: float, record):
    v.orders += 1
    notional = amount_in if side == "buy" else amount_in * ref
    v.notional += notional
    price = _exec_price(v, side, amount_in, ref, prop_ref)
    if price is None:
        v.rejects += 1
        return
    if v.kind != "prop":
        try:
            v.venue.fill(side, amount_in)
        except (ValueError, ZeroDivisionError):
            v.rejects += 1
            return
    v.fills += 1
    record(v, side, amount_in, price)


if __name__ == "__main__":
    from simulation.sim.study import _load_slice
    from simulation.sim.windows import WINDOWS
    for w in WINDOWS:
        prices = _load_slice(w)
        print(f"== {w.label} {w.dates} ==")
        for row in route_window(prices):
            print(f"  {row['venue']:10} vol={row['volume_share']:6.1%} fill={row['fill_share']:6.1%} "
                  f"mkt={row['markout_2s_bps']:+7.3f} hs={row['quiet_half_spread_bps']:6.3f} rej={row['rejection_rate']:.1%}")
