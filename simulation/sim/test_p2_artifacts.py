"""P2 - guards for the calibration pipeline and the F5 evaluation result.

These assert the **honest outcome** of the pre-registered economic evaluation so
it cannot silently change, and that the calibration artifacts are present and
consistent. They do not re-run the (hours-long) simulator; they validate the
committed, reproducible artifacts and their provenance.

Reproduce the F5 artifact with:
    .venv/bin/python -m simulation.sim.real_flow_study
Reproduce the thesis artifact with:
    .venv/bin/python -m simulation.sim.thesis
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "simulation" / "data" / "results"


def _load(name: str) -> dict:
    return json.loads((RESULTS / name).read_text())


def test_f5_real_flow_artifact_records_the_honest_outcome():
    f5 = _load("f5_real_flow.json")
    assert f5["T_A_i"]["met"] is False
    assert f5["T_A_i"]["days_with_ci_above_zero"] == []
    # Two genuinely high-volatility windows (>= 2x the reference sigma).
    for day, row in f5["high_vol_held_out"].items():
        assert row["sigma_ratio_vs_ref"] >= 2.0, f"{day} is not a 2x window"
    # ArbSwap's real-flow markout is worse than B1's on every held-out day
    # (the honest F5 finding; not tuned away).
    for row in f5["real_flow_rows"]:
        assert row["markout_diff_2s_bps"] < 0


def test_thesis_artifact_matches_the_f5_result():
    thesis = _load("thesis.json")
    assert thesis["T_A"]["T_A_i_real_flow_ci"]["met"] is False
    assert thesis["T_A"]["T_A_holds"] is False
    assert thesis["decision"] == "Option 1 not shown"


def test_calibration_artifacts_are_present_and_reproducible():
    frozen = _load("frozen_params.json")
    for key in ("seed", "step_seconds", "block_hours", "candidates", "params"):
        assert key in frozen, f"frozen_params.json missing {key}"
    b1 = _load("b1_calibration.json")
    best = b1["best"]
    # The synthetic W1 fit is inside the pre-registered accept window.
    assert b1["accept_markout"][0] <= best["markout_2s_bps"] <= b1["accept_markout"][1]
    assert b1["accept_half_spread"][0] <= best["half_spread_bps"] <= b1["accept_half_spread"][1]


def test_cu_artifact_carries_sampling_statistics():
    cu = _load("cu.json")
    assert cu["samples_per_instruction"] >= 5
    for name, stats in cu["instructions_stats"].items():
        assert stats["n"] >= 5, f"{name} has too few samples"
        assert stats["min"] <= stats["median"] <= stats["max"]
        assert stats["range"] == stats["max"] - stats["min"]
