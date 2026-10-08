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
    venues = venue_set(params, start_price=points[0].price)
    arb = report("ArbSwap", _run(points, "ArbSwap", venues["ArbSwap"], pre=pre))
    b1 = report("B1_passive", _run(points, "B1_passive", venues["B1_passive"], pre=pre))
    return arb, b1


if __name__ == "__main__":
    print(f"{'window':6} {'pre E1':>9} {'post E1':>9} {'pre Arb':>9} {'post Arb':>9} {'pre B1':>8} {'post B1':>8}")
    for w in WINDOWS:
        if w.is_calibration:
            continue
        points = _load_slice(w)
        pre_arb, pre_b1 = pair(points, pre=True)
        post_arb, post_b1 = pair(points, pre=False)
        e1_pre = (pre_arb.hedged_pnl - pre_b1.hedged_pnl) / abs(pre_b1.hedged_pnl) if pre_b1.hedged_pnl else 0.0
        e1_post = (post_arb.hedged_pnl - post_b1.hedged_pnl) / abs(post_b1.hedged_pnl) if post_b1.hedged_pnl else 0.0
        print(f"{w.label:6} {e1_pre:+9.1%} {e1_post:+9.1%} "
              f"{pre_arb.hedged_pnl:9.1f} {post_arb.hedged_pnl:9.1f} "
              f"{pre_b1.hedged_pnl:8.1f} {post_b1.hedged_pnl:8.1f}")
