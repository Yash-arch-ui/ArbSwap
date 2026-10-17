"""Phase 5 — simulation tests that run **actual swaps** and verify the LVR machinery.

These tests drive the simulator (`run_regime` executes real swap fills on a
synthetic price path), not fixtures. They verify the modeled LVR benchmark and the
repository's E1 LVR-reduction metric. They deliberately do **not** tune any
parameter to inflate the result: the assertions only check that the numbers are
finite, correctly signed, and computed by the documented formulas.
"""

from __future__ import annotations

import pytest

from simulation.sim.experiments import e1_lvr_reduction, run_regime
from simulation.sim.metrics import TradeRecord, lvr_discrete, markout_bps

SEED = 20261006
LENGTH = 600


@pytest.fixture(scope="module")
def calm() -> dict:
    return run_regime("calm", length=LENGTH, seed=SEED)


def test_swaps_actually_execute(calm):
    # The point of Phase 5: real simulated fills, not empty reports.
    assert calm["ArbSwap"].trades > 0
    assert calm["B1_passive"].trades > 0
    assert calm["ArbSwap"].turnover_quote > 0


def test_passive_modeled_lvr_matches_the_formula(calm):
    sigma = calm["ArbSwap"].sigma
    value = 100_000.0
    seconds = float(LENGTH)
    assert sigma > 0
    assert lvr_discrete(sigma, value, seconds) == pytest.approx((sigma ** 2 / 8.0) * value * seconds)
    assert lvr_discrete(sigma, value, seconds) > 0
    # Degenerate inputs and negative inputs are handled explicitly.
    assert lvr_discrete(0.0, value, seconds) == 0.0
    assert lvr_discrete(sigma, 0.0, seconds) == 0.0
    with pytest.raises(ValueError):
        lvr_discrete(-1.0, value, seconds)


def test_e1_lvr_reduction_matches_the_manual_formula(calm):
    arb = calm["ArbSwap"].hedged_pnl
    passive = calm["B1_passive"].hedged_pnl
    if passive == 0:
        pytest.skip("passive hedged PnL is zero on this seed")
    expected = (arb - passive) / abs(passive)
    got = e1_lvr_reduction(calm, venue="ArbSwap", baseline="B1_passive")
    assert got == pytest.approx(expected)
    assert got == got  # not NaN


def test_markout_sign_convention(calm):
    # A finite modeled markout for the venue (not NaN).
    assert calm["ArbSwap"].markout_2s_bps == calm["ArbSwap"].markout_2s_bps
    # Venue bought base (trader sells) and price rises -> venue gained (> 0).
    buy = TradeRecord(second=1, trader_side="sell", base_amount=1.0,
                      quote_amount=100.0, exec_price=100.0, mid_at_fill=100.0)
    assert markout_bps(buy, future_price=110.0) > 0
    # Venue sold base (trader buys) and price rises -> venue lost (< 0).
    sell = TradeRecord(second=2, trader_side="buy", base_amount=1.0,
                       quote_amount=100.0, exec_price=100.0, mid_at_fill=100.0)
    assert markout_bps(sell, future_price=110.0) < 0


def test_determinism_same_seed(calm):
    again = run_regime("calm", length=LENGTH, seed=SEED)
    assert again["ArbSwap"].hedged_pnl == pytest.approx(calm["ArbSwap"].hedged_pnl)
    assert again["ArbSwap"].trades == calm["ArbSwap"].trades
    assert again["B1_passive"].hedged_pnl == pytest.approx(calm["B1_passive"].hedged_pnl)
