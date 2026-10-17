"""Tests for the public LVR transparency generator (`simulation/analytics/lvr.py`).

Covers the honesty rules from `docs/PUBLIC_LVR_TRANSPARENCY_PLAN.md`: unavailable
metrics stay ``None`` (never zero), malformed/non-finite/negative values are
rejected, generation is deterministic, and no rows are fabricated or duplicated.
"""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path

import pytest

from simulation.analytics import lvr

FIXED_TS = "2026-01-01T00:00:00Z"


def _window(label: str, dates: str, theory_lvr: float, turnover: float,
            markout: float, trades: int = 100, passive_hedged: float = 100.0,
            arb_hedged: float = 700.0) -> dict:
    return {
        "dates": dates, "seconds": 604800, "label": label,
        "theory_lvr_quote": theory_lvr, "passive_initial_value_quote": 100000.0,
        "reports": {
            "ArbSwap": {"markout_2s_bps": markout, "turnover_quote": turnover,
                        "trades": trades, "hedged_pnl": arb_hedged},
            "B1_passive": {"hedged_pnl": passive_hedged},
        },
    }


def _fixture() -> dict:
    return {
        "vault_fee_bps": 1.0,
        "windows": {
            "W2": _window("W2", "2026-08-31 .. 2026-09-06", 192.895, 9_294_445.8, 5.61),
            "W3": _window("W3", "2026-09-07 .. 2026-09-13", 173.82, 9_488_852.7, 4.65),
        },
    }


def _build(**kw) -> dict:
    return lvr.build_lvr_history(_fixture(), generated_at=FIXED_TS, commit="abc1234", **kw)


# --- metric calculations -----------------------------------------------------

def test_passive_lvr_comes_from_the_modeled_theory_value():
    art = _build()
    assert [r["passive_lvr_usd"] for r in art["rows"]] == [192.895, 173.82]


def test_fees_are_turnover_times_fee_bps():
    art = _build()
    # 9,294,445.8 * 1 / 10_000
    assert art["rows"][0]["fees_usd"] == pytest.approx(929.44458, rel=1e-9)
    assert art["totals"]["fees_usd"] == pytest.approx(sum(r["fees_usd"] for r in art["rows"]))


def test_markout_is_kept_as_a_separate_proxy_not_lvr():
    art = _build()
    assert art["markout_seconds"] == 2
    row = art["rows"][0]
    assert row["arbswap_markout_2s_bps"] == pytest.approx(5.61)
    # The proxy is never relabeled as LVR.
    assert row["arbswap_lvr_usd"] is None


def test_lvr_reduction_pct_is_the_modeled_e1_metric():
    art = _build()
    # E1 = (arb_hedged - passive_hedged) / |passive_hedged| * 100 = (700-100)/100*100
    assert art["rows"][0]["lvr_reduction_pct"] == pytest.approx(600.0)
    assert art["totals"]["lvr_reduction_pct_mean"] == pytest.approx(600.0)
    # It is a modeled metric, never labeled as an LVR amount.
    assert art["rows"][0]["arbswap_lvr_usd"] is None


def test_lvr_reduction_is_none_when_the_passive_baseline_is_absent():
    w = _fixture()
    del w["windows"]["W2"]["reports"]["B1_passive"]
    art = lvr.build_lvr_history(w, generated_at=FIXED_TS)
    assert art["rows"][0]["lvr_reduction_pct"] is None


def test_totals_equal_the_sum_of_rows_and_no_rows_are_duplicated():
    art = _build()
    assert len(art["rows"]) == len(_fixture()["windows"])
    assert art["totals"]["passive_lvr_usd"] == pytest.approx(
        sum(r["passive_lvr_usd"] for r in art["rows"]))
    assert art["totals"]["swaps"] == sum(r["swaps"] for r in art["rows"])


# --- unavailable metrics are never zero --------------------------------------

def test_unavailable_metrics_are_none_not_zero():
    art = _build()
    for row in art["rows"]:
        assert row["arbswap_lvr_usd"] is None
        assert row["net_lp_impact_usd"] is None
    assert art["totals"]["arbswap_lvr_usd"] is None
    assert art["totals"]["net_lp_impact_usd"] is None
    assert "arbswap_lvr_usd" in art["unavailable"]


def test_validate_rejects_substituted_zero_for_unavailable_metric():
    art = _build()
    bad = copy.deepcopy(art)
    bad["rows"][0]["arbswap_lvr_usd"] = 0
    with pytest.raises(ValueError):
        lvr.validate(bad)


# --- provenance / schema -----------------------------------------------------

def test_provenance_is_modeled_and_traceable():
    art = _build()
    assert art["provenance"]["kind"] == "modeled"
    assert art["provenance"]["generator"] == "simulation/analytics/lvr.py"
    assert art["provenance"]["commit"] == "abc1234"
    assert "simulation/data/results/window_results.json" in art["provenance"]["inputs"]


def test_validate_rejects_unsupported_schema_version():
    art = _build()
    bad = copy.deepcopy(art)
    bad["schema_version"] = 2
    with pytest.raises(ValueError):
        lvr.validate(bad)


def test_validate_rejects_missing_benchmark():
    art = _build()
    bad = copy.deepcopy(art)
    bad["benchmark"] = None
    with pytest.raises(ValueError):
        lvr.validate(bad)


def test_validate_rejects_inconsistent_units():
    art = _build()
    bad = copy.deepcopy(art)
    bad["units"]["lvr"] = "wei"
    with pytest.raises(ValueError):
        lvr.validate(bad)


# --- invalid / non-finite / negative values ----------------------------------

def test_validate_rejects_negative_coverage():
    art = _build()
    bad = copy.deepcopy(art)
    bad["rows"][0]["coverage_bps"] = -1
    with pytest.raises(ValueError):
        lvr.validate(bad)


def test_validate_rejects_non_finite_numbers():
    art = _build()
    bad = copy.deepcopy(art)
    bad["rows"][0]["passive_lvr_usd"] = math.nan
    with pytest.raises(ValueError):
        lvr.validate(bad)
    bad2 = copy.deepcopy(art)
    bad2["rows"][0]["fees_usd"] = math.inf
    with pytest.raises(ValueError):
        lvr.validate(bad2)


def test_validate_rejects_malformed_dates():
    art = _build()
    bad = copy.deepcopy(art)
    bad["rows"][0]["period_start"] = "31-08-2026"
    with pytest.raises(ValueError):
        lvr.validate(bad)


def test_validate_rejects_missing_row_field():
    art = _build()
    bad = copy.deepcopy(art)
    del bad["rows"][0]["fees_usd"]
    with pytest.raises(ValueError):
        lvr.validate(bad)


# --- no / partial observations -----------------------------------------------

def test_build_rejects_no_windows():
    with pytest.raises(ValueError):
        lvr.build_lvr_history({"vault_fee_bps": 1.0, "windows": {}}, generated_at=FIXED_TS)


def test_build_rejects_partial_window_missing_report():
    w = _fixture()
    del w["windows"]["W2"]["reports"]
    with pytest.raises(ValueError):
        lvr.build_lvr_history(w, generated_at=FIXED_TS)


def test_build_rejects_malformed_window_dates():
    w = _fixture()
    w["windows"]["W2"]["dates"] = "not-a-range"
    with pytest.raises(ValueError):
        lvr.build_lvr_history(w, generated_at=FIXED_TS)


# --- determinism -------------------------------------------------------------

def test_generation_is_deterministic():
    a = lvr.dumps(_build())
    b = lvr.dumps(_build())
    assert a == b
    json.loads(a)  # valid JSON


def test_generated_at_defaults_to_source_mtime_and_is_reproducible():
    # Two calls without an explicit timestamp are identical (both use the mtime).
    a = lvr.build_lvr_history(_fixture(), commit="x")
    b = lvr.build_lvr_history(_fixture(), commit="x")
    assert a["generated_at"] == b["generated_at"]


# --- real repository artifact ------------------------------------------------

def test_real_window_results_build_and_validate():
    path = Path(lvr.WINDOW_RESULTS)
    if not path.exists():
        pytest.skip("window_results.json not present")
    art = lvr.build_lvr_history(json.loads(path.read_text()), generated_at=FIXED_TS)
    assert len(art["rows"]) >= 5
    assert all(r["status"] == "modeled" for r in art["rows"])
    assert all(r["arbswap_lvr_usd"] is None for r in art["rows"])
