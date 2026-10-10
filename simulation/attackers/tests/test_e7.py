"""E7 containment tests (T5.1).

These assert the *structural* guarantees that hold by construction, so they are
stable rather than tuned to a seed:

- the honest vault never fills worse than the last displayed quote
  (``gap ~ 0``; the B4 no-honesty ablation shows a positive gap);
- a dead keeper lets quotes expire and stops fills while a live keeper keeps
  trading on the same path;
- accepted honest fills are (nearly) identical to the quoted output.

The Regime/seed sweep is intentionally light so the suite stays fast; the
E9 sensitivity script broadens it.
"""

from __future__ import annotations

import pytest

from simulation.attackers import scenarios
from simulation.reference.quote_math import QuoteParams
from simulation.sim.experiments import run_venues
from simulation.sim.flow import NoiseFlow
from simulation.sim.oracle import OracleModel
from simulation.sim.price_source import synthetic_series


def _run(scenario: scenarios.Scenario) -> dict:
    prices = synthetic_series(regime=scenario.regime, length=scenario.length,
                              seed=scenario.seed)
    return run_venues(
        prices,
        params=QuoteParams(),
        oracle=scenario._oracle(),
        informed=scenario.informed,
        noise=scenario.noise or NoiseFlow(seed=scenario.seed),
        seed=scenario.seed,
        keeper_update_interval_seconds=scenario.keeper_interval,
    )


VAULT_BOTS = [
    scenarios.stale_feed(),
    scenarios.bad_tick(),
    scenarios.sandwich(),
    scenarios.phantom_liquidity(),
    scenarios.toxic_flow(),
    scenarios.oracle_update_sandwich(),
]


@pytest.mark.parametrize("bot", VAULT_BOTS, ids=lambda b: b.name)
def test_honest_gap_is_never_worse_than_quoted(bot) -> None:
    reports = _run(bot)
    arbs = reports["ArbSwap"]
    # The honest venue rejects fills worse than the last displayed quote, so its
    # gap is never materially positive (>= 0 worse-for-trader). A negative gap
    # means the fill was *better* than quoted, which honesty permits.
    assert arbs.gap_bps <= 0.5, arbs.gap_bps
    assert arbs.markout_2s_bps == arbs.markout_2s_bps  # not NaN
    assert arbs.hedged_pnl == arbs.hedged_pnl


def test_no_honesty_ablation_has_a_nonnegative_gap():
    """B4 fills worse-than-quoted fills, so its gap >= 0; honest ArbSwap stays ~0."""
    reports = _run(scenarios.sandwich())
    assert reports["B4_no_honesty"].gap_bps > reports["ArbSwap"].gap_bps + 1e-9
    assert reports["ArbSwap"].gap_bps <= 0.1


def test_keeper_down_stops_fills_after_expiry():
    """On the same path a dead keeper (interval=1e9) trades far less than a live one."""
    alive = _run(scenarios.keeper_alive())
    down = _run(scenarios.keeper_down())
    # The dead keeper gets one initial refresh; fills only during the expiry
    # window (~expiry_slots * slot_seconds), so it trades almost nothing.
    assert down["ArbSwap"].trades <= 5
    assert down["ArbSwap"].update_count == pytest.approx(1, abs=1)
    assert alive["ArbSwap"].trades > 10