"""T5: pre-fix vs post-fix engine on the held-out windows.

Pre-fix (commit 3eccd1a^): the arbitrageur sized by *average-price* breakeven and
a fill did NOT consume the displayed ladder. Post-fix: profit-maximising sizing
and ladder consumption. We run both on a one-hour slice of each held-out window.
"""

from __future__ import annotations

from simulation.reference.quote_math import QuoteParams
from simulation.sim.engine import simulate
from simulation.sim.experiments import report, venue_set
from simulation.sim.flow import InformedFlow, NoiseFlow
from simulation.sim.flow_config import NOISE_ARRIVAL_RATE, NOISE_MEAN_SIZE
from simulation.sim.oracle import OracleModel
from simulation.sim.bootstrap import bootstrap_ci, hedged_increments
from simulation.sim.study import _load_slice
from simulation.sim.windows import WINDOWS

SEED = 20261006


def _run(points, name, venue, *, pre: bool):
    if pre and hasattr(venue, "consume_ladder"):
        venue.consume_ladder = False
    return simulate(
        venue_name=name, venue=venue, prices=points, oracle=OracleModel(seed=SEED),
        noise=NoiseFlow(seed=SEED, arrival_rate=NOISE_ARRIVAL_RATE, mean_size=NOISE_MEAN_SIZE),
        informed=InformedFlow(), depth_budget=1.0, step_seconds=0.4,
        source_step_seconds=1.0, slot_seconds=0.4, keeper_update_interval_seconds=1.0,
        seed=SEED, informed_sizing=("average" if pre else "marginal"),
    )


def pair(points, *, pre: bool):
    params = QuoteParams()
    # The "pre" side predates the init fix (b083ba5), so it uses the OLD
    # hard-coded price-150 initialization AND the pre-fix macros.
    start_price = 150.0 if pre else points[0].price
    venues = venue_set(params, start_price=start_price)
    arb = report("ArbSwap", _run(points, "ArbSwap", venues["ArbSwap"], pre=pre))
    b1 = report("B1_passive", _run(points, "B1_passive", venues["B1_passive"], pre=pre))
    return arb, b1, _run(points, "ArbSwap", venue_set(QuoteParams(), start_price=start_price)["ArbSwap"], pre=pre), _run(points, "B1_passive", venue_set(QuoteParams(), start_price=start_price)["B1_passive"], pre=pre)


if __name__ == "__main__":
    from simulation.sim.bootstrap import bootstrap_ci, hedged_increments
    print(f"{'win':4} {'pre PnL [CI]':>26} {'post PnL [CI]':>26} {'pre B1':>9} {'post B1':>9}")
    for w in WINDOWS:
        if w.is_calibration:
            continue
        points = _load_slice(w)
        _pa, _pb, pre_arb, pre_b1 = pair(points, pre=True)
        _qa, _qb, post_arb, post_b1 = pair(points, pre=False)
        pre_ci = bootstrap_ci(hedged_increments(pre_arb.value_path, pre_arb.base_path, pre_arb.price_path))
        post_ci = bootstrap_ci(hedged_increments(post_arb.value_path, post_arb.base_path, post_arb.price_path))
        preb = sum(hedged_increments(pre_b1.value_path, pre_b1.base_path, pre_b1.price_path))
        postb = sum(hedged_increments(post_b1.value_path, post_b1.base_path, post_b1.price_path))
        print(f"{w.label:4} {pre_ci[0]:9.1f} [{pre_ci[1]:8.1f},{pre_ci[2]:8.1f}] "
              f"{post_ci[0]:9.1f} [{post_ci[1]:8.1f},{post_ci[2]:8.1f}] {preb:9.1f} {postb:9.1f}")
