"""Venues: B1 passive pool, B2 fixed-spread vault, B3/B4 ArbSwap (T1.4).

All venues operate on real-valued reserves and return fills in the *input*
token of the trade:
- a buy means the trader pays quote and receives base (vault ask side);
- a sell means the trader pays base and receives quote (vault bid side).

The ArbSwap venue calls the same Section 5 code as the keeper
(`research.reference.quote_math`), satisfying the Build Plan §4 rule that the
backtest describes the product.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from research.reference.quote_math import (
    Quote,
    QuoteParams,
    VolatilityState,
    compute_quote,
    walk_ladder,
)


@dataclass
class Fill:
    side: str  # trader side: "buy" or "sell"
    amount_in: float
    amount_out: float
    exec_price: float
    vault_cash_delta: float  # quote received by the vault
    vault_base_delta: float  # base received by the vault (negative when paid out)


@dataclass
class PassivePool:
    """B1: constant-product pool with a proportional fee."""

    base: float = 1_000.0
    quote: float = 150_000.0
    fee: float = 0.0003

    @property
    def price(self) -> float:
        return self.quote / self.base

    def fill(self, side: str, amount_in: float) -> Fill:
        if amount_in <= 0:
            raise ValueError("amount_in must be positive")
        if side == "buy":
            quote_in = amount_in
            net = quote_in * (1 - self.fee)
            base_out = self.base * net / (self.quote + net)
            self.base -= base_out
            self.quote += quote_in
            return Fill(side, quote_in, base_out, quote_in / base_out, quote_in, -base_out)
        base_in = amount_in
        net = base_in * (1 - self.fee)
        quote_out = self.quote * net / (self.base + net)
        self.base += base_in
        self.quote -= quote_out
        return Fill(side, base_in, quote_out, quote_out / base_in, -quote_out, base_in)


@dataclass
class VaultVenue:
    """B2/B3/B4: oracle-anchored vault quoting a ladder.

    ``engine_enabled`` toggles whether volatility, inventory, confidence, and
    age feed the spread/throttle and inventory skew (B3/B4) or a fixed spread is
    used (B2). ``depth_override`` supports the B3 ablation (no throttle).
    """

    params: QuoteParams = field(default_factory=QuoteParams)
    base: float = 1_000.0
    quote: float = 150_000.0
    engine_enabled: bool = True
    depth_override: float | None = None
    volatility: VolatilityState = field(default_factory=VolatilityState)
    quote_state: Quote | None = None

    def refresh(self, *, price: float, confidence: float, age: float,
                previous_price: float | None, depth_budget: float = 1.0) -> None:
        if self.engine_enabled:
            self.quote_state = compute_quote(
                price=price,
                base_reserve=self.base,
                quote_reserve=self.quote,
                confidence=confidence,
                age=age,
                volatility=self.volatility,
                params=self.params,
                previous_price=previous_price,
                depth_budget=depth_budget,
            )
        else:
            self.quote_state = compute_quote(
                price=price,
                base_reserve=self.base,
                quote_reserve=self.quote,
                confidence=0.0,
                age=0.0,
                volatility=VolatilityState(),
                params=QuoteParams(
                    spread_floor=self.params.spread_floor,
                    spread_min=self.params.spread_min,
                    spread_max=self.params.spread_max,
                    inventory_coeff=0.0,
                    volatility_coeff=0.0,
                    confidence_coeff=0.0,
                    age_coeff=0.0,
                    jump_extra=0.0,
                    directional_coeff=0.0,
                ),
                previous_price=None,
                depth_budget=self.depth_override if self.depth_override is not None else 1.0,
            )
        if self.depth_override is not None:
            self.quote_state = replace(self.quote_state, depth_mult=self.depth_override)

    def fill(self, side: str, amount_in: float) -> Fill:
        if self.quote_state is None:
            raise ValueError("refresh must be called before fill")
        if amount_in <= 0:
            raise ValueError("amount_in must be positive")
        levels = self.quote_state.asks if side == "buy" else self.quote_state.bids
        output, _, _ = walk_ladder(levels, amount_in, flow_n=0.0)
        if side == "buy":
            self.base -= output
            self.quote += amount_in
            return Fill(side, amount_in, output, amount_in / output, amount_in, -output)
        self.base += amount_in
        self.quote -= output
        return Fill(side, amount_in, output, output / amount_in, -output, amount_in)

    def value(self, reference_price: float) -> float:
        return self.base * reference_price + self.quote
