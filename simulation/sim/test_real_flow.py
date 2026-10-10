"""Item F-11/F-10: real-flow and router smoke tests (skipped if the raw
aggTrades archive is not present, since raw data is gitignored)."""

from __future__ import annotations

import pytest

from simulation.sim.real_flow import RAW, load_day, run_b1
from simulation.sim.router import route_window

DAY = RAW / "SOLUSDT-aggTrades-2026-09-10.csv"
pytestmark = pytest.mark.skipif(not DAY.exists(), reason="raw aggTrades archive not present")


def test_real_flow_loads_and_b1_runs():
    prices, flow = load_day(DAY, max_seconds=600)
    assert len(prices) > 100
    assert len(flow.orders) > 0
    metrics = run_b1(prices, flow, depth_mult=100.0)
    assert metrics["trades"] > 0
    assert metrics["markout_2s_bps"] == metrics["markout_2s_bps"]  # not NaN


def test_router_allocates_all_volume_somewhere():
    prices, _flow = load_day(DAY, max_seconds=600)
    rows = route_window(prices, prop_hs=0.5, insensitive_share=0.2)
    total = sum(r["volume_share"] for r in rows)
    assert abs(total - 1.0) < 1e-6
    assert {r["venue"] for r in rows} == {"ArbSwap", "B1_passive", "PropAMM"}
