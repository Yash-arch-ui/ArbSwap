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
(``simulation.reference.quote_math``), satisfying the Build Plan §4 rule that the
backtest describes the product.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace

from simulation.reference.quote_math import (
    LadderLevel,
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

    def preview(self, side: str, amount_in: float) -> float:
        """Average execution price of a single fill from the current reserves.

        Pure: the pool state is untouched. The informed trader uses this (and
        :meth:`preview_size`) to size an arbitrage without copying the venue on
        every bisection probe; the numbers are identical to ``fill`` on a copy.
        """
        if amount_in <= 0:
            raise ValueError("amount_in must be positive")
        if side == "buy":
            net = amount_in * (1 - self.fee)
            base_out = self.base * net / (self.quote + net)
            if base_out <= 0:
                raise ZeroDivisionError("no base out")
            return amount_in / base_out
        net = amount_in * (1 - self.fee)
        quote_out = self.quote * net / (self.base + net)
        return quote_out / amount_in

    def preview_size(self, side: str, amount_in: float) -> tuple[float, float]:
        """``(amount_out, exec_price)`` for a single fill, without mutating."""
        if amount_in <= 0:
            raise ValueError("amount_in must be positive")
        if side == "buy":
            net = amount_in * (1 - self.fee)
            base_out = self.base * net / (self.quote + net)
            if base_out <= 0:
                raise ZeroDivisionError("no base out")
            return base_out, amount_in / base_out
        net = amount_in * (1 - self.fee)
        quote_out = self.quote * net / (self.base + net)
        return quote_out, quote_out / amount_in

    def fill(self, side: str, amount_in: float) -> Fill:
        if side == "buy":
            quote_in = amount_in
            base_out, exec_price = self.preview_size("buy", quote_in)
            self.base -= base_out
            self.quote += quote_in
            return Fill(side, quote_in, base_out, exec_price, quote_in, -base_out)
        base_in = amount_in
        quote_out, exec_price = self.preview_size("sell", base_in)
        self.base += base_in
        self.quote -= quote_out
        return Fill(side, base_in, quote_out, exec_price, -quote_out, base_in)


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
    consume_ladder: bool = True
    volatility: VolatilityState = field(default_factory=VolatilityState)
    quote_state: Quote | None = None
    displayed_quote: Quote | None = None
    # Item 3: accrued (LP-excluded) liabilities, in tokens. Ladder capacity must
    # be built from reserves *minus* these buckets, never from the gross reserve,
    # so the vault cannot quote away the insurance/keeper/protocol liabilities.
    fee_buckets_base: float = 0.0
    fee_buckets_quote: float = 0.0
    # Item 1g: rejection-reason counters for the actual execution path only
    # (not for the informed trader's `preview` probes).
    honesty_rejects: int = 0
    capacity_rejects: int = 0
    reserve_rejects: int = 0
    # Item 2a: trader slippage tolerance on min_out, in bps. 0 = the strict
    # honesty rule (reject any fill worse than the displayed quote).
    min_out_tol_bps: float = 0.0
    # Item 2b: the would-be quote-vs-fill gap (bps) of every *attempted* fill,
    # recorded BEFORE the honesty decision, for the survivorship analysis.
    attempt_gaps: list = field(default_factory=list)
    _last_attempt_gap: tuple | None = None
    # S3.2: realized-edge breaker, mirroring the on-chain tracker. The stored
    # oracle is the price from the last refresh; the edge is signed quote units
    # (positive = the vault traded better than the oracle). A window rolls on the
    # simulation clock; a trip pauses the vault for the rest of the run.
    edge_window_seconds: float = 1_000.0
    max_edge_loss_bps: float = 500.0
    last_oracle_price: float = 0.0
    realized_edge: float = 0.0
    edge_window_start: float | None = None
    edge_trips: int = 0
    edge_min: float = 0.0
    tripped: bool = False

    @property
    def available_base(self) -> float:
        """Base reserve net of the tracked (LP-excluded) fee buckets."""
        return max(0.0, self.base - self.fee_buckets_base)

    @property
    def available_quote(self) -> float:
        """Quote reserve net of the tracked (LP-excluded) fee buckets."""
        return max(0.0, self.quote - self.fee_buckets_quote)

    def _record_edge(self, side: str, amount_in: float, output: float, now: float) -> None:
        """S3.2: accumulate the signed execution edge vs the stored oracle."""
        oracle = self.last_oracle_price
        if oracle <= 0 or self.tripped:
            return
        if side == "buy":  # vault sells base: receives quote, pays base
            edge = amount_in - output * oracle
        else:  # vault buys base: receives base, pays quote
            edge = amount_in * oracle - output
        if self.edge_window_start is None or now - self.edge_window_start >= self.edge_window_seconds:
            self.edge_window_start = now
            self.realized_edge = 0.0
        self.realized_edge += edge
        self.edge_min = min(self.edge_min, self.realized_edge)
        available_value = self.available_base * oracle + self.available_quote
        bound = self.max_edge_loss_bps / 10_000.0 * available_value
        if self.realized_edge < -bound:
            self.edge_trips += 1
            self.tripped = True

    def refresh(self, *, price: float, confidence: float, age: float,
                previous_price: float | None, depth_budget: float = 1.0) -> None:
        # The quote a trader could have read at the end of the previous slot.
        self.displayed_quote = self.quote_state
        # S3.2: the verified oracle stored at this update, used by the edge tracker.
        self.last_oracle_price = price
        # Item 3: capacity is sized from the LP-available reserves, excluding the
        # insurance/keeper/protocol fee buckets.
        base_avail = self.available_base
        quote_avail = self.available_quote
        if self.engine_enabled:
            quote = compute_quote(
                price=price,
                base_reserve=base_avail,
                quote_reserve=quote_avail,
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
                base_reserve=base_avail,
                quote_reserve=quote_avail,
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

    def _preview_fill(self, side: str, amount_in: float
                      ) -> tuple[float, float, float, float | None]:
        """Pure version of :meth:`fill`: ``(amount_out, exec_price, gap_bps, quoted_out)``.

        Applies exactly the same checks (state present, positive input, ladder
        walk, honest-execution rejection) but never mutates the venue, so the
        informed trader can probe prices without copying the object.
        """
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
        # The ladder was sized from the reserves at the last refresh; several
        # fills can land before the next one. Never pay out more than the vault
        # actually holds — on chain this is an insufficient-liquidity failure.
        if side == "buy" and output > self.base:
            raise ValueError("insufficient base reserve")
        if side == "sell" and output > self.quote:
            raise ValueError("insufficient quote reserve")

        quoted_out = _output_for(self.displayed_quote, side, amount_in, self.fee_bps)
        # Item 2b: gap is computed BEFORE the honesty decision so the rejected
        # fills can be recorded (the post-rejection gap is non-positive by
        # construction; this is the would-be gap).
        gap_bps = 0.0
        if quoted_out is not None and quoted_out > 0:
            gap_bps = 10_000.0 * (quoted_out - output) / quoted_out
        notional = amount_in if side == "buy" else output
        self._last_attempt_gap = (gap_bps, notional)
        # Item 2a: honesty rejects a fill worse than the displayed quote by more
        # than the trader's slippage tolerance.
        if (
            self.honest_enabled
            and quoted_out is not None
            and output < quoted_out * (1.0 - self.min_out_tol_bps / 10_000.0)
        ):
            raise HonestyRejected("fill would be worse than the last displayed quote")

        if side == "buy":
            return output, amount_in / output, gap_bps, quoted_out
        return output, output / amount_in, gap_bps, quoted_out

    def preview(self, side: str, amount_in: float) -> float:
        """Average execution price of a single fill, without mutating state."""
        return self._preview_fill(side, amount_in)[1]

    def _consume(self, side: str, net_in: float) -> None:
        """Remove the filled capacity from the displayed ladder.

        On chain a swap moves the stored quote and every later swap in the same
        quote window sees the remaining depth. Without this, ``preview``/``fill``
        would keep re-walking the original ladder and a fast arbitrageur could
        drain the vault many times over between two ``update_quote`` calls.
        """
        if self.quote_state is None or net_in <= 0:
            return
        is_ask = side == "buy"
        levels = self.quote_state.asks if is_ask else self.quote_state.bids
        remaining = net_in
        updated: list[LadderLevel] = []
        for level in levels:
            if remaining <= 1e-15:
                updated.append(level)
                continue
            if is_ask:
                max_in = level.liquidity * (math.sqrt(level.hi) - math.sqrt(level.lo))
                used = min(remaining, max_in)
                if used <= 0:
                    updated.append(level)
                    continue
                remaining -= used
                if used >= max_in * (1 - 1e-12):
                    continue
                new_lo = (math.sqrt(level.lo) + used / level.liquidity) ** 2
                updated.append(replace(level, lo=new_lo))
            else:
                max_in = level.liquidity * (1.0 / math.sqrt(level.lo)
                                            - 1.0 / math.sqrt(level.hi))
                used = min(remaining, max_in)
                if used <= 0:
                    updated.append(level)
                    continue
                remaining -= used
                if used >= max_in * (1 - 1e-12):
                    continue
                new_hi = 1.0 / (1.0 / math.sqrt(level.hi) + used / level.liquidity) ** 2
                updated.append(replace(level, hi=new_hi))
        if is_ask:
            self.quote_state = replace(self.quote_state, asks=tuple(updated))
        else:
            self.quote_state = replace(self.quote_state, bids=tuple(updated))

    def fill(self, side: str, amount_in: float, now: float = 0.0) -> Fill:
        if self.tripped:
            # S3.2: the edge breaker has paused the vault.
            raise ValueError("vault tripped by the realized-edge breaker")
        try:
            output, exec_price, gap_bps, quoted_out = self._preview_fill(side, amount_in)
            if self._last_attempt_gap is not None:
                self.attempt_gaps.append(self._last_attempt_gap)
        except HonestyRejected:
            self.honesty_rejects += 1
            if self._last_attempt_gap is not None:
                self.attempt_gaps.append(self._last_attempt_gap)
            raise
        except ValueError as exc:
            # Distinguish "the ladder cannot absorb this" from "the vault would
            # pay out more than it holds"; both are capacity-side failures.
            if "insufficient" in str(exc):
                self.reserve_rejects += 1
            else:
                self.capacity_rejects += 1
            raise
        fee = amount_in * self.fee_bps / 10_000.0
        if self.consume_ladder:
            self._consume(side, amount_in - fee)
        if side == "buy":
            # The fee is retained in quote; book it to the LP-excluded bucket.
            self.fee_buckets_quote += fee
            self.base -= output
            self.quote += amount_in
            self._record_edge(side, amount_in, output, now)
            return Fill(side, amount_in, output, exec_price, amount_in,
                        -output, quoted_out, gap_bps)
        # sell: the fee is retained in base.
        self.fee_buckets_base += fee
        self.base += amount_in
        self.quote -= output
        self._record_edge(side, amount_in, output, now)
        return Fill(side, amount_in, output, exec_price, -output, amount_in,
                    quoted_out, gap_bps)

    def value(self, reference_price: float) -> float:
        return self.base * reference_price + self.quote
