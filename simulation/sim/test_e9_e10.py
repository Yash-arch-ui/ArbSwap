"""Tests for E9 sensitivity and E10 cost (T5.5).

These assert structural, seed-independent guarantees:
- E9 is deterministic (same inputs, same outputs) and honest gap never worse
  than quoted (<= ~0);
- E10 reports the measured CU constants and stays under the 200k transaction
  default for both instruction paths.
"""

from __future__ import annotations

from simulation.sim import e9_e10


def test_e9_is_deterministic():
    tiny = dict(length=300, regimes=("calm",),
                passive_fees=(0.0001,), vault_fees_bps=(1,), latencies=(1.0,))
    first = e9_e10.e9_sensitivity(**tiny)
    second = e9_e10.e9_sensitivity(**tiny)
    assert first == second
    assert len(first) == 1


def test_e9_honest_gap_never_worse_than_quoted():
    small = dict(length=300, regimes=("trend",),
                 passive_fees=(0.0001,), vault_fees_bps=(1, 3),
                 latencies=(0.2, 1.0))
    for row in e9_e10.e9_sensitivity(**small):
        # A materially positive gap would mean fills worse than the quote.
        assert row["gap_bps"] <= 0.5, row


def test_e10_reports_measured_cu_and_is_under_the_default_budget():
    summary = e9_e10.e10_cost_summary()
    assert summary["cu_update_quote"] == e9_e10.CU_UPDATE_QUOTE
    assert summary["cu_swap"] == e9_e10.CU_SWAP
    assert summary["under_200k_default"] is True
    assert summary["update_total_quote"] > 0
    assert summary["swap_total_quote"] > 0