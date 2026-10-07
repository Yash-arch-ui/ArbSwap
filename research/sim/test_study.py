"""Tests for the held-out study runner (Task 1.6)."""

from __future__ import annotations

import json
from dataclasses import asdict

import pytest

from research.reference.quote_math import QuoteParams
from research.sim.price_source import PricePoint
from research.sim.study import (
    AGGTRADES_DATES,
    EXPECTED_REGIMES,
    aggtrades_csv,
    extract_blocks,
    render,
    study_keys,
)
from research.sim.windows import WINDOWS


def _points(n: int) -> list[PricePoint]:
    return [PricePoint(second=i, price=100.0 + i * 0.01) for i in range(n)]


def _params_json() -> str:
    return json.dumps(asdict(QuoteParams()))


def test_extract_blocks_slices_on_the_registered_hours():
    points = _points(168 * 3600)
    blocks = extract_blocks(points, hours=(0, 14, 28))
    assert [len(block) for block in blocks] == [3600, 3600, 3600]
    assert blocks[0][0].second == 0
    assert blocks[1][0].second == 14 * 3600
    assert blocks[2][0].second == 28 * 3600


def test_extract_blocks_rejects_a_window_that_is_too_short():
    with pytest.raises(ValueError):
        extract_blocks(_points(3600), hours=(0, 1))


def test_aggtrades_paths_are_per_day():
    assert aggtrades_csv("2026-09-10").name == \
        "binance_SOLUSDT_aggtrades_100ms_2026-09-10.csv"
    assert set(AGGTRADES_DATES) == {"W3", "W4", "W6"}


def test_study_keys_splits_off_the_parameter_suffix():
    assert study_keys({"W2@1.0": 1, "W3@0.1": 2, "W2@0.1": 3}) == ["W2", "W3"]


def _fake_reports(scale: float) -> dict:
    row = {
        "hedged_pnl": scale,
        "markout_2s_bps": -1.0,
        "quiet_half_spread_bps": 3.0,
        "gap_bps": -0.5,
        "trades": 1000,
        "rejects": 100,
        "fill_rate": 0.909,
        "turnover_quote": 50_000.0,
        "update_count": 604_800,
        "update_gas_quote": 1.0,
        "update_priority_quote": 2.0,
        "cost_per_update_quote": 1e-5,
        "swap_cost_quote": 3.0,
    }
    return {name: dict(row) for name in
            ("B1_passive", "B2_fixed_spread", "B3_no_throttle", "B4_no_honesty",
             "ArbSwap")}


def _fake_window(label: str, scale: float) -> dict:
    return {
        "label": label,
        "dates": "2026-08-31 .. 2026-09-06",
        "log_return": 0.01,
        "sigma": 1e-4,
        "theory_lvr_quote": 12.0,
        "reports": _fake_reports(scale),
    }


def _fake_venues(scale: float) -> dict:
    return {"ArbSwap": {"hedged_pnl": scale, "trades": 10, "rejects": 1,
                        "updates": 700, "turnover_quote": 100.0},
            "B1_passive": {"hedged_pnl": -scale, "trades": 20, "rejects": 0,
                           "updates": 0, "turnover_quote": 200.0}}


def _fake_studies() -> dict:
    s1 = {f"{label}@{step}": {"window": label, "step_seconds": step,
                              "venues": _fake_venues(5.0)}
          for label in ("W2", "W3", "W4", "W5", "W6") for step in (1.0, 0.1)}
    s2 = {f"{label}@{slot}": {"window": label, "slot_seconds": slot,
                              "reports": _fake_reports(5.0)}
          for label in ("W3", "W4", "W6") for slot in (0.4, 0.6, 1.0)}
    s3 = {f"{label}@{lat}": {"window": label, "day": AGGTRADES_DATES[label],
                             "latency_seconds": lat, "venues": _fake_venues(5.0)}
          for label in AGGTRADES_DATES for lat in (0.05, 0.2, 0.4, 1.0)}
    s4 = {str(seed): {"seed": seed, "window": "W2", "venues": _fake_venues(5.0)}
          for seed in (20261006, 20261007)}
    return {"S1": s1, "S2": s2, "S3": s3, "S4": s4}


def test_render_produces_every_registered_section():
    payload = {
        "frozen_params": asdict(QuoteParams()),
        "regimes": dict(EXPECTED_REGIMES),
        "regimes_match_pre_registration": True,
        "windows": {label: _fake_window(label, 10.0 * i)
                    for i, label in enumerate(("W2", "W3", "W4", "W5", "W6"), 1)},
    }
    text = render(payload, _fake_studies())
    for heading in ("## Pre-registration", "## Pre-registration amendment",
                    "# Held-out windows (W2-W6)", "## S1:", "## S2:", "## S3:",
                    "## S4:", "## S5:", "## Honest limitations"):
        assert heading in text, heading
    assert "W3" in text and "crash" in text
    assert "regimes match pre-registration" in text
    assert "+" in text  # E1 values are rendered with an explicit sign


# --- smoke tests: every study phase must return a well-formed dict ----------
# (F-02 in docs/AUDIT_REPORT.md: a stray tuple in _s2_job made S2 non-executable.)

import research.sim.study as study  # noqa: E402


def test_s1_job_returns_a_well_formed_row(monkeypatch):
    monkeypatch.setattr(study, "_load_window", lambda window: _points(400))
    row = study._s1_job(("W2", 1.0, _params_json()))
    assert row["window"] == "W2"
    assert row["step_seconds"] == 1.0
    assert set(row["venues"]) == {"ArbSwap", "B1_passive"}
    assert isinstance(row["venues"]["ArbSwap"]["hedged_pnl"], float)


def test_s2_job_returns_a_well_formed_row(monkeypatch):
    monkeypatch.setattr(study, "_load_slice", lambda window: _points(400))
    row = study._s2_job(("W3", 0.6, _params_json()))
    assert isinstance(row, dict), "F-02 regression: _s2_job must return a dict"
    assert row["window"] == "W3"
    assert row["slot_seconds"] == 0.6
    assert row["step_seconds"] == 0.2
    assert "ArbSwap" in row["reports"]
    assert "quiet_half_spread_bps" in row["reports"]["ArbSwap"]


def test_s3_job_returns_a_well_formed_row(monkeypatch):
    monkeypatch.setattr(study, "_load_agg_slice", lambda day: _points(400))
    row = study._s3_job(("W4", 0.2, _params_json()))
    assert row["window"] == "W4"
    assert row["day"] == AGGTRADES_DATES["W4"]
    assert row["latency_seconds"] == 0.2
    assert set(row["venues"]) == {"ArbSwap", "B1_passive"}


def test_s4_job_returns_a_well_formed_row(monkeypatch):
    monkeypatch.setattr(study, "_load_window", lambda window: _points(400))
    row = study._s4_job((20261007, _params_json()))
    assert row["seed"] == 20261007
    assert row["window"] == "W2"
    assert "ArbSwap" in row["venues"]


def test_evaluate_window_returns_every_venue(monkeypatch):
    monkeypatch.setattr(study, "_load_window", lambda window: _points(400))
    row = study._evaluate_window(("W3", _params_json()))
    assert row["label"] == "W3"
    assert set(row["reports"]) == {
        "B1_passive", "B2_fixed_spread", "B3_no_throttle", "B4_no_honesty", "ArbSwap"}
    assert row["theory_lvr_quote"] >= 0.0
    assert "fill_rate" in row["reports"]["ArbSwap"]
    assert "cost_per_update_quote" in row["reports"]["ArbSwap"]


def test_parse_params_round_trips_json_lists_back_to_tuples():
    params = study.parse_params(json.loads(json.dumps(asdict(QuoteParams()))))
    assert params == QuoteParams()
    assert isinstance(params.offsets_bps, tuple)
