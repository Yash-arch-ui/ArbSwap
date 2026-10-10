"""S0.3 simulator sanity guards: startup and runtime assertions.

A past bug initialized every venue at price 150 against a ~100 market and
invalidated results. These tests fail if the guards stop catching that class of
error, negative reserves, or a fill that does not conserve value.
"""

from __future__ import annotations

import pytest

from simulation.sim.guards import (
    assert_conservation,
    assert_initial_price,
    assert_price_within_band,
    assert_sane,
)
from simulation.sim.metrics import TradeRecord
from simulation.sim.venues import PassivePool


def test_initial_price_guard_rejects_a_mispriced_venue():
    good = PassivePool(base=1000.0, quote=100_000.0)
    assert_initial_price(good, 100.0)
    bad = PassivePool(base=1000.0, quote=150_000.0)
    with pytest.raises(AssertionError):
        assert_initial_price(bad, 100.0)


def test_band_guard_rejects_out_of_band_prices():
    assert_price_within_band(100.0, 100.0, max_rel_dev=0.5)
    assert_price_within_band(120.0, 100.0, max_rel_dev=0.5)
    with pytest.raises(AssertionError):
        assert_price_within_band(160.0, 100.0, max_rel_dev=0.5)


def test_sane_guard_rejects_negative_and_nan_reserves():
    assert_sane(PassivePool(base=1000.0, quote=100_000.0))
    with pytest.raises(AssertionError):
        assert_sane(PassivePool(base=-1.0, quote=1.0))
    with pytest.raises(AssertionError):
        assert_sane(PassivePool(base=float("nan"), quote=1.0))


def test_conservation_guard_matches_the_trade_log():
    pool = PassivePool(base=1000.0, quote=100_000.0)
    fill = pool.fill("buy", 1000.0)
    trade = TradeRecord(
        second=0,
        trader_side="buy",
        base_amount=fill.amount_out,
        quote_amount=fill.amount_in,
        exec_price=fill.exec_price,
        mid_at_fill=fill.exec_price,
    )
    # Reconstructing from the log must match the reserves.
    assert_conservation(pool, 1000.0, 100_000.0, [trade])
    # A fill that is not in the log is a conservation failure.
    with pytest.raises(AssertionError):
        assert_conservation(pool, 1000.0, 100_000.0, [])
    # Gas debited from the vault must be accounted for.
    with pytest.raises(AssertionError):
        assert_conservation(pool, 1000.0, 100_000.0, [trade], gas_quote=1.0)
