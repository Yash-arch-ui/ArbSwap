"""USDT -> USDC conversion tests (Task 1.1)."""

from __future__ import annotations

import pytest

from research.sim.price_source import PricePoint, load_price_window
from research.sim.usdt_usdc import convert_legs, convert_price


def test_identity_when_peg_is_one():
    assert convert_price(150.0, 1.0) == 150.0


def test_division_not_multiplication():
    # 1 USDC buys 0.999 USDT, so 150 USDT of SOL is 150/0.999 USDC.
    assert convert_price(150.0, 0.999) == pytest.approx(150.0 / 0.999)
    assert convert_price(150.0, 0.999) > 150.0


def test_rejects_non_positive_inputs():
    with pytest.raises(ValueError):
        convert_price(0.0, 1.0)
    with pytest.raises(ValueError):
        convert_price(150.0, 0.0)


def _leg(prices: list[float], second_offset: int = 0) -> list[PricePoint]:
    return [PricePoint(second=index + second_offset, price=price)
            for index, price in enumerate(prices)]


def test_convert_legs_applies_the_division_elementwise():
    sol = _leg([100.0, 100.0, 100.0])
    peg = _leg([1.0, 0.95, 1.05])
    out = convert_legs(sol, peg)
    assert [p.price for p in out] == [100.0 / 1.0, 100.0 / 0.95, 100.0 / 1.05]


def test_convert_legs_rejects_mismatched_lengths():
    with pytest.raises(ValueError, match="same length"):
        convert_legs(_leg([100.0]), _leg([1.0, 1.0]))


def test_convert_legs_rejects_misaligned_grids():
    with pytest.raises(ValueError, match="aligned"):
        convert_legs(_leg([100.0, 101.0]), _leg([1.0, 1.0], second_offset=1))


def test_convert_legs_rejects_a_broken_peg():
    with pytest.raises(ValueError, match="peg"):
        convert_legs(_leg([100.0, 100.0]), _leg([1.0, 0.5]))


def test_conversion_is_applied_end_to_end(tmp_path):
    """The report path must divide: the converted series differs from the raw
    one exactly by the peg, for every second of the window."""
    sol_path = tmp_path / "sol.csv"
    peg_path = tmp_path / "peg.csv"
    sol_rows = ["timestamp_ms,price", "1000,150.0000000000", "2000,151.0000000000"]
    peg_rows = ["timestamp_ms,price", "1000,0.9990000000", "2000,0.9995000000"]
    sol_path.write_text("\n".join(sol_rows) + "\n")
    peg_path.write_text("\n".join(peg_rows) + "\n")

    sol = load_price_window(sol_path, start_ms=1_000, end_ms=3_000)
    peg = load_price_window(peg_path, start_ms=1_000, end_ms=3_000)
    converted = convert_legs(sol, peg)

    assert [p.price for p in sol] == [150.0, 151.0]
    assert converted[0].price == pytest.approx(150.0 / 0.999)
    assert converted[1].price == pytest.approx(151.0 / 0.9995)
    # The conversion is actually doing something: raw != converted.
    assert [p.price for p in converted] != [p.price for p in sol]
    assert [p.second for p in converted] == [0, 1]
