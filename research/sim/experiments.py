"""Experiments E1-E6 (Build Plan §8.4, T1.6).

Runs the venues side by side on a shared price path and reports the headline
metrics. Regimes are chosen in advance and losing regimes are reported, per the
methodology rules in §8.5.

Baselines (Build Plan §8.2):
  B1 passive pool | B2 fixed spread | B3 no depth throttle | B4 no honesty
  ArbSwap = the full product (engine + throttle + honest execution).
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from research.reference.quote_math import QuoteParams
from research.sim.costs import CostModel
from research.sim.engine import SimResult, simulate
from research.sim.flow import InformedFlow, NoiseFlow
from research.sim.metrics import (
    hedged_pnl,
    notional_weighted_gap,
    notional_weighted_markout,
    realized_volatility_per_sqrt_second,
    retail_half_spread_bps,
)
from research.sim.oracle import OracleModel
from research.sim.price_source import PricePoint, Regime, synthetic_series
from research.sim.venues import PassivePool, VaultVenue
from research.sim.windows import (
    CALIBRATION_SEED,
    HEADLINE_STEP_SECONDS,
    KEEPER_INTERVAL_SECONDS,
    SLOT_SECONDS,
    SOURCE_STEP_SECONDS,
)

VENUE_ORDER = ("B1_passive", "B2_fixed_spread", "B3_no_throttle",
               "B4_no_honesty", "ArbSwap")


@dataclass(frozen=True)
class RunConfig:
    """Pre-registered clock, seed and cost settings for a batch of runs.

    Defaults come from ``research/sim/windows.py`` (the pre-registration
    amendment), so any run that forgets to choose a clock still lands on the
    registered one.
    """

    seed: int = CALIBRATION_SEED
    step_seconds: float = HEADLINE_STEP_SECONDS
    source_step_seconds: float = SOURCE_STEP_SECONDS
    slot_seconds: float = SLOT_SECONDS
    keeper_update_interval_seconds: float = KEEPER_INTERVAL_SECONDS
    costs: CostModel = field(default_factory=CostModel)

    def replace(self, **kwargs) -> "RunConfig":
        from dataclasses import replace as _replace

        return _replace(self, **kwargs)

    def simulate_kwargs(self) -> dict:
        return {
            "seed": self.seed,
            "step_seconds": self.step_seconds,
            "source_step_seconds": self.source_step_seconds,
            "slot_seconds": self.slot_seconds,
            "keeper_update_interval_seconds": self.keeper_update_interval_seconds,
            "costs": self.costs,
        }


@dataclass
class VenueReport:
    name: str
    hedged_pnl: float
    markout_2s_bps: float
    quiet_half_spread_bps: float
    gap_bps: float
    sigma: float
    trades: int
    rejects: int
    turnover_quote: float = 0.0
    update_count: int = 0
    update_cost_quote: float = 0.0
    update_gas_quote: float = 0.0
    update_priority_quote: float = 0.0
    swap_cost_quote: float = 0.0

    @property
    def fill_rate(self) -> float:
        """Share of attempted fills that executed (1.0 when nothing was tried)."""
        attempted = self.trades + self.rejects
        return self.trades / attempted if attempted else 1.0

    @property
    def cost_per_update_quote(self) -> float:
        return self.update_cost_quote / self.update_count if self.update_count else 0.0


def venue_set(params: QuoteParams, *, passive_fee: float = 0.0001,
              vault_fee_bps: float = 1.0) -> dict[str, object]:
    """Instantiate B1-B4 and the full ArbSwap vault with equal starting capital.

    The passive pool fee defaults to 1 bps (typical of a major SOL/USDC pool);
    E9 sweeps it. The vault fee defaults to the Build Plan §5.16 ``fee_bps``.
    """
    return {
        "B1_passive": PassivePool(fee=passive_fee),
        "B2_fixed_spread": VaultVenue(params=params, engine_enabled=False,
                                      fee_bps=vault_fee_bps),
        "B3_no_throttle": VaultVenue(params=params, throttle_enabled=False,
                                     fee_bps=vault_fee_bps),
        "B4_no_honesty": VaultVenue(params=params, honest_enabled=False,
                                    fee_bps=vault_fee_bps),
        "ArbSwap": VaultVenue(params=params, fee_bps=vault_fee_bps),
    }


def _price_lookup(result: SimResult):
    by_second = {i: price for i, price in enumerate(result.price_path)}
    return by_second.get


def report(name: str, result: SimResult) -> VenueReport:
    lookup = _price_lookup(result)
    step = result.step_seconds
    markout_steps = max(1, round(2.0 / step))
    return VenueReport(
        name=name,
        hedged_pnl=hedged_pnl(result.value_path, result.base_path, result.price_path),
        markout_2s_bps=notional_weighted_markout(result.trades, markout_steps, lookup),
        quiet_half_spread_bps=retail_half_spread_bps(result.trades, lookup,
                                                     step_seconds=step),
        gap_bps=notional_weighted_gap(result.trades),
        sigma=realized_volatility_per_sqrt_second(result.price_path, step_seconds=step),
        trades=len(result.trades),
        rejects=result.rejects,
        turnover_quote=sum(trade.quote_amount for trade in result.trades),
        update_count=result.quote_updates,
        update_cost_quote=result.update_cost_quote,
        update_gas_quote=result.update_gas_quote,
        update_priority_quote=result.update_priority_quote,
        swap_cost_quote=result.swap_cost_quote,
    )


def run_venues(points: list[PricePoint], *, params: QuoteParams,
               config: RunConfig | None = None,
               depth_budget: float = 1.0,
               noise: NoiseFlow | None = None,
               informed: InformedFlow | None = None,
               passive_fee: float = 0.0001,
               vault_fee_bps: float = 1.0,
               oracle: OracleModel | None = None,
               seed: int | None = None,
               step_seconds: float | None = None,
               source_step_seconds: float | None = None,
               slot_seconds: float | None = None,
               keeper_update_interval_seconds: float | None = None,
               costs: CostModel | None = None,
               record_quotes: bool = False) -> dict[str, VenueReport]:
    """Run every venue on the same path with the same flow draws.

    ``config`` supplies the pre-registered clock/seed/costs; any keyword given
    explicitly overrides it. All oracle-anchored vaults (B2/B3/B4/ArbSwap) pay
    the keeper's measured gas and priority fee; the passive pool B1 has no
    keeper and pays nothing. Swap transaction costs are recorded on the result
    but never debited, because the swapper signs that transaction.

    Every venue gets its **own fresh copy** of the oracle (and the same
    ``NoiseFlow`` seed), so the venues differ only in their quoting logic. A
    shared ``OracleModel`` is stateful: handing one instance to every venue
    gives each a different stretch of the noise stream and silently breaks the
    paired comparison.
    """
    config = config or RunConfig()
    step_seconds = config.step_seconds if step_seconds is None else step_seconds
    source_step_seconds = (config.source_step_seconds if source_step_seconds is None
                           else source_step_seconds)
    slot_seconds = config.slot_seconds if slot_seconds is None else slot_seconds
    keeper_update_interval_seconds = (
        config.keeper_update_interval_seconds if keeper_update_interval_seconds is None
        else keeper_update_interval_seconds)
    costs = config.costs if costs is None else costs
    seed = config.seed if seed is None else seed

    noise = noise or NoiseFlow(seed=seed)
    informed = informed or InformedFlow()
    oracle_template = oracle
    reports: dict[str, VenueReport] = {}
    for name, venue in venue_set(params, passive_fee=passive_fee,
                                 vault_fee_bps=vault_fee_bps).items():
        venue_oracle = (OracleModel() if oracle_template is None
                        else replace(oracle_template))
        result = simulate(
            venue_name=name,
            venue=venue,
            prices=points,
            oracle=venue_oracle,
            noise=noise,
            informed=informed,
            depth_budget=depth_budget,
            costs=costs,
            step_seconds=step_seconds,
            source_step_seconds=source_step_seconds,
            slot_seconds=slot_seconds,
            keeper_update_interval_seconds=keeper_update_interval_seconds,
            seed=seed,
            record_quotes=record_quotes,
        )
        reports[name] = report(name, result)
    return reports


def run_regime(regime: Regime, *, length: int = 3_600, seed: int = 20261006,
               params: QuoteParams | None = None,
               passive_fee: float = 0.0001) -> dict[str, VenueReport]:
    prices = synthetic_series(regime=regime, length=length, seed=seed)
    return run_venues(prices, params=params or QuoteParams(), seed=seed,
                      passive_fee=passive_fee)


def e1_lvr_reduction(reports: dict[str, VenueReport], *, venue: str = "ArbSwap",
                     baseline: str = "B1_passive") -> float:
    """Fractional hedged-PnL improvement of a venue over the passive pool.

    A positive number means the venue kept more value than the passive pool on
    the same path.
    """
    passive = reports[baseline].hedged_pnl
    arbs = reports[venue].hedged_pnl
    if passive == 0:
        return 0.0
    return (arbs - passive) / abs(passive)


def e2_markouts(reports: dict[str, VenueReport]) -> dict[str, float]:
    return {name: report.markout_2s_bps for name, report in reports.items()}


def e3_hedged_return(reports: dict[str, VenueReport]) -> dict[str, float]:
    return {name: report.hedged_pnl for name, report in reports.items()}


def e4_retail_quality(reports: dict[str, VenueReport]) -> dict[str, float]:
    return {name: report.quiet_half_spread_bps for name, report in reports.items()}


def e5_throttle_ablation(reports: dict[str, VenueReport]) -> float:
    """Hedged-PnL difference of ArbSwap (throttle on) over B3 (throttle off)."""
    return reports["ArbSwap"].hedged_pnl - reports["B3_no_throttle"].hedged_pnl


def e6_honesty_cost(reports: dict[str, VenueReport]) -> dict[str, float]:
    """Fill-rate and gap cost of honest execution versus the B4 ablation."""
    full = reports["ArbSwap"]
    dishonest = reports["B4_no_honesty"]
    return {
        "fills_full": float(full.trades),
        "fills_no_honesty": float(dishonest.trades),
        "rejected_honest_fills": float(full.rejects),
        "gap_full_bps": full.gap_bps,
        "gap_no_honesty_bps": dishonest.gap_bps,
        "pnl_full": full.hedged_pnl,
        "pnl_no_honesty": dishonest.hedged_pnl,
    }


def main() -> None:
    print("PRELIMINARY: parameters are not walk-forward calibrated (T1.5).")
    print("These numbers test the pipeline, not the product; do not headline them.")
    for regime in ("calm", "trend", "crash"):
        reports = run_regime(regime)
        print(f"== {regime} ==")
        print(f"  E1 hedged improvement ArbSwap vs B1: {e1_lvr_reduction(reports):+.4f}")
        print(f"  E2 markout 2s (bps): {e2_markouts(reports)}")
        print(f"  E3 hedged PnL: {e3_hedged_return(reports)}")
        print(f"  E4 quiet half-spread (bps): {e4_retail_quality(reports)}")
        print(f"  E5 throttle ablation (ArbSwap - B3): {e5_throttle_ablation(reports):+.2f}")
        print(f"  E6 honesty cost: {e6_honesty_cost(reports)}")


if __name__ == "__main__":
    main()
