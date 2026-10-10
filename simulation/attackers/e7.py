"""Run every E7 attacker bot and print a containment report (T5.1).

Usage::

    python -m attackers.e7

Prints one table row per bot: the honest vault's gap and markout, the passive
pool counterfactual markout, and the keeper's update count. The structural
containment assertions live in ``attackers/tests/test_e7.py``.
"""

from __future__ import annotations

from simulation.attackers import scenarios
from simulation.reference.quote_math import QuoteParams
from simulation.sim.experiments import e1_lvr_reduction, run_venues
from simulation.sim.flow import NoiseFlow
from simulation.sim.price_source import synthetic_series

HEADER = f"{'scenario':34} {'upd':>5} {'fill%':>7} {'gap':>9} {'mkt(2s)':>9} {'B1 mkt':>9} {'E1':>8}"
ROW = f"{{:<34}} {{:>5}} {{:>7.0%}} {{:>9.4f}} {{:>9.3f}} {{:>9.3f}} {{:>8.4f}}"


def main() -> None:
    print("E7 adversarial containment — simulator evidence (synthetic paths, "
          "not product claims).")
    print("Account/authority attacks are contained on-chain; see "
          "docs/THREAT_MODEL.md and the LiteSVM suite.")
    print(HEADER)
    for bot in scenarios.SCENARIOS:
        scenario = bot()
        prices = synthetic_series(regime=scenario.regime, length=scenario.length,
                                  seed=scenario.seed)
        reports = run_venues(
            prices,
            params=QuoteParams(),
            oracle=scenario._oracle(),
            informed=scenario.informed,
            noise=scenario.noise or NoiseFlow(seed=scenario.seed),
            seed=scenario.seed,
            keeper_update_interval_seconds=scenario.keeper_interval,
        )
        arbs = reports["ArbSwap"]
        b1 = reports["B1_passive"]
        e1 = e1_lvr_reduction(reports)
        print(ROW.format(scenario.name, arbs.update_count, arbs.fill_rate,
                         arbs.gap_bps, arbs.markout_2s_bps,
                         b1.markout_2s_bps, e1))
        print(f"    mitigation: {scenario.mitigation}")


if __name__ == "__main__":
    main()