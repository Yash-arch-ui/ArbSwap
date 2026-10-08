"""Differential tests: Python reference vs golden expectations (T1.2).

These mirror `vault/math/src/lib.rs` unit tests. The full vector set
(>= 500 cases) is generated in T1.2 and consumed by both Rust and Python.
"""
import pytest

from simulation.reference.arb_math_ref import BPS_DENOMINATOR, add_bps, mul_div_ceil, mul_div_floor


def test_floor_and_ceil_agree_on_exact_division():
    assert mul_div_floor(9, 3, 3) == 9
    assert mul_div_ceil(9, 3, 3) == 9
    # Non-trivial exact case: 12*5/4 = 15.
    assert mul_div_floor(12, 5, 4) == 15
    assert mul_div_ceil(12, 5, 4) == 15


def test_ceil_rounds_up_only_when_needed():
    assert mul_div_ceil(10, 1, 3) == 4
    assert mul_div_floor(10, 1, 3) == 3


def test_division_by_zero_raises():
    with pytest.raises(ValueError):
        mul_div_floor(1, 1, 0)
    with pytest.raises(ValueError):
        mul_div_ceil(1, 1, 0)


def test_bps_rounding_favors_the_vault():
    assert add_bps(1_000_000, 1, True) == 1_000_100
    assert add_bps(1_000_001, 1, True) == 1_000_102
    assert add_bps(1_000_001, 1, False) == 1_000_101


def test_bps_denominator_constant():
    assert BPS_DENOMINATOR == 10_000
