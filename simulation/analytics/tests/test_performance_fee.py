"""C4.4 - high-water-mark performance fee and the insurance-buffer invariant."""

from __future__ import annotations

from simulation.analytics.performance_fee import hedged_profit_fee, insurance_buffer


def test_fee_only_on_new_high_water_profit():
    # up 10 -> fee on 10; down 4 -> no fee; up to 8 (below old peak 10) -> no fee;
    # up to 20 -> fee on 10 (20 - 10).
    fees = hedged_profit_fee([10.0, -4.0, 2.0, 12.0], rate_bps=2_000)
    assert fees == [2.0, 0.0, 0.0, 2.0]


def test_no_fee_in_a_losing_path():
    assert hedged_profit_fee([-1.0, -2.0, -3.0]) == [0.0, 0.0, 0.0]


def test_high_water_mark_never_recharges_the_same_profit():
    a = hedged_profit_fee([5.0, -5.0, 5.0], rate_bps=1_000)
    assert a[0] == 0.5 and a[2] == 0.0  # second recovery to +5 is not new profit


def test_insurance_buffer_is_never_negative_and_capped():
    buf = insurance_buffer([3.0, -5.0, 2.0, 100.0], cap=10.0)
    assert all(0.0 <= b <= 10.0 for b in buf)
    assert buf == [3.0, 0.0, 2.0, 10.0]
