"""Experiments E1-E4 (Build Plan §8.4, T1.6).

Runs the venues side by side on a shared price path and reports the headline
metrics. Regimes are chosen in advance and losing regimes are reported, per the
methodology rules in §8.5.
"""

from __future__ import annotations

from dataclasses import dataclass

from research.reference.quote_math import QuoteParams
from research.sim.engine import SimResult, simulate
from research.sim.flow import InformedFlow, NoiseFlow
from research.sim.metrics import (
    hedged_pnl,
    notional_weighted_markout,
    realized_volatility_per_sqrt_second,
    retail_half_spread_bps,
)
from research.sim.oracle import OracleModel
from research.sim.price_source import Regime, synthetic_series
from research.sim.venues import PassivePool, VaultVenue


@dataclass
class VenueReport:
    name: str
    hedged_pnl: float
    markout_2s_bps: float
    quiet_half_spread_bps: float
    sigma: float
    trades: int


def _price_lookup(result: SimResult):
    by_second = {i: price for i, price in enumerate(result.price_path)}

    def price_at(second: int):
        return by_second.get(second)

    return price_at


def report(name: str, result: SimResult) -> VenueReport:
    lookup = _price_lookup(result)
    return VenueReport(
        name=name,
        hedged_pnl=hedged_pnl(result.value_path, result.base_path, result.price_path),
        markout_2s_bps=notional_weighted_markout(result.trades, 2, lookup),
        quiet_half_spread_bps=retail_half_spread_bps(result.trades, lookup),
        sigma=realized_volatility_per_sqrt_second(result.price_path),
        trades=len(result.trades),
    )


def run_regime(regime: Regime, *, length: int = 3_600, seed: int = 20261006,
               params: QuoteParams | None = None) -> dict[str, VenueReport]:
    prices = synthetic_series(regime=regime, length=length, seed=seed)
    params = params or QuoteParams()
    noise = NoiseFlow(seed=seed)
    informed = InformedFlow()

    venues = {
        "B1_passive": PassivePool(),
        "B2_fixed_spread": VaultVenue(params=params, engine_enabled=False),
        "B3_arbswap": VaultVenue(params=params),
        "B4_no_throttle": VaultVenue(params=params, depth_override=1.0),
    }
    reports: dict[str, VenueReport] = {}
    for name, venue in venues.items():
        result = simulate(
            venue_name=name,
            venue=venue,
            prices=prices,
            oracle=OracleModel(),
            noise=noise,
            informed=informed,
        )
        reports[name] = report(name, result)
    return reports


def e1_lvr_reduction(reports: dict[str, VenueReport]) -> float:
    """Fractional hedged-PnL improvement of B3 over the passive pool B1.

    A positive number means B3 kept more value than B1 on the same path.
    """
    passive = reports["B1_passive"].hedged_pnl
    arbs = reports["B3_arbswap"].hedged_pnl
    if passive == 0:
        return 0.0
    return (arbs - passive) / abs(passive)


def e2_markouts(reports: dict[str, VenueReport]) -> dict[str, float]:
    return {name: report.markout_2s_bps for name, report in reports.items()}


def e3_hedged_return(reports: dict[str, VenueReport]) -> dict[str, float]:
    return {name: report.hedged_pnl for name, report in reports.items()}


def e4_retail_quality(reports: dict[str, VenueReport]) -> dict[str, float]:
    return {name: report.quiet_half_spread_bps for name, report in reports.items()}


def main() -> None:
    print("PRELIMINARY: parameters are not yet walk-forward calibrated (T1.5).")
    print("These numbers test the pipeline, not the product; do not headline them.")
    for regime in ("calm", "trend", "crash"):
        reports = run_regime(regime)
        print(f"== {regime} ==")
        print(f"  E1 LVR/hedged improvement B3 vs B1: {e1_lvr_reduction(reports):+.4f}")
        print(f"  E2 markout 2s (bps): {e2_markouts(reports)}")
        print(f"  E3 hedged PnL: {e3_hedged_return(reports)}")
        print(f"  E4 quiet half-spread (bps): {e4_retail_quality(reports)}")


if __name__ == "__main__":
    main()
