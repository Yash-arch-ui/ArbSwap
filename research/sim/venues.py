"""Venues: B1-B4 baselines plus the full ArbSwap vault (T1.4).

Baselines follow Build Plan §8.2 exactly:

- **B1_passive**: constant-product pool with a proportional fee.
- **B2_fixed_spread**: the vault with a fixed spread and no engine.
- **B3_no_throttle**: ArbSwap with the depth throttle disabled (ablation).
- **B4_no_honesty**: ArbSwap with honest-execution enforcement disabled
  (ablation; the venue fills at the repriced state even when that is worse than
  the state the trader last read).
- **ArbSwap**: the full product (engine + throttle + honest execution).

All venues operate on real-valued reserves and return fills in the *input*
token of the trade:

- a buy means the trader pays quote and receives base (vault ask side);
- a sell means the trader pays base and receives quote (vault bid side).

The ArbSwap venue calls the same Section 5 code as the keeper
(``research.reference.quote_math``), satisfying the Build Plan §4 rule that the
backtest describes the product.
"""

from __future__ import annotations

from dataclasses import dataclass, field

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
    quoted_out: float | None = None  # output implied by the previously displayed quote
    gap_bps: float = 0.0  # quote-versus-fill gap (positive = worse for the trader)


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


class HonestyRejected(ValueError):
    """Raised when a fill would execute worse than the last displayed quote.

    Mirrors the on-chain ``SlippageExceeded`` path (Build Plan §6.4): the honest
    program fails the swap instead of silently filling worse than the state the
    trader or aggregator last read.
    """


def _output_for(quote: Quote | None, side: str, amount_in: float,
                fee_bps: float = 0.0) -> float | None:
    if quote is None:
        return None
    levels = quote.asks if side == "buy" else quote.bids
    if not levels:
        return None
    net_in = amount_in - amount_in * fee_bps / 10_000.0
    try:
        output, _, _ = walk_ladder(levels, net_in, flow_n=0.0)
    except ValueError:
        return None
    return output


@dataclass
class VaultVenue:
    """B2/B3/B4 and the full ArbSwap vault.

    ``engine_enabled`` toggles whether volatility, inventory, confidence, and
    age feed the spread and inventory skew (ArbSwap/B3/B4) or a fixed spread is
    used (B2). ``throttle_enabled`` toggles the depth throttle (B3 ablation).
    ``honest_enabled`` toggles versioned-quote/min-out enforcement (B4 ablation).
    ``depth_override`` forces a fixed depth multiplier (test hook).
    """

    params: QuoteParams = field(default_factory=QuoteParams)
    base: float = 1_000.0
    quote: float = 150_000.0
    engine_enabled: bool = True
    throttle_enabled: bool = True
    honest_enabled: bool = True
    fee_bps: float = 1.0
    depth_override: float | None = None
    volatility: VolatilityState = field(default_factory=VolatilityState)
    quote_state: Quote | None = None
    displayed_quote: Quote | None = None

    def refresh(self, *, price: float, confidence: float, age: float,
                previous_price: float | None, depth_budget: float = 1.0) -> None:
        # The quote a trader could have read at the end of the previous slot.
        self.displayed_quote = self.quote_state
        if self.engine_enabled:
            quote = compute_quote(
                price=price,
                base_reserve=self.base,
                quote_reserve=self.quote,
                confidence=confidence,
                age=age,
                volatility=self.volatility,
                params=self.params,
                previous_price=previous_price,
                depth_budget=depth_budget,
                apply_throttle=self.throttle_enabled,
                depth_override=self.depth_override,
            )
        else:
            quote = compute_quote(
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
                    utilization_max=self.params.utilization_max,
                ),
                previous_price=None,
                apply_throttle=False,
                depth_override=self.depth_override,
            )
        self.quote_state = quote

    def fill(self, side: str, amount_in: float) -> Fill:
        if self.quote_state is None:
            raise ValueError("refresh must be called before fill")
        if amount_in <= 0:
            raise ValueError("amount_in must be positive")
        levels = self.quote_state.asks if side == "buy" else self.quote_state.bids
        # Deterministic fee (Build Plan §5.13): ceil(amount_in * fee_bps / 10_000),
        # retained by the vault. The ladder walks on the net input.
        fee = amount_in * self.fee_bps / 10_000.0
        net_in = amount_in - fee
        output, _, _ = walk_ladder(levels, net_in, flow_n=0.0)

        quoted_out = _output_for(self.displayed_quote, side, amount_in, self.fee_bps)
        if (
            self.honest_enabled
            and quoted_out is not None
            and output < quoted_out * (1 - 1e-12)
        ):
            raise HonestyRejected("fill would be worse than the last displayed quote")

        gap_bps = 0.0
        if quoted_out is not None and quoted_out > 0:
            gap_bps = 10_000.0 * (quoted_out - output) / quoted_out

        if side == "buy":
            self.base -= output
            self.quote += amount_in
            return Fill(side, amount_in, output, amount_in / output, amount_in,
                        -output, quoted_out, gap_bps)
        self.base += amount_in
        self.quote -= output
        return Fill(side, amount_in, output, output / amount_in, -output, amount_in,
                    quoted_out, gap_bps)

    def value(self, reference_price: float) -> float:
        return self.base * reference_price + self.quote
