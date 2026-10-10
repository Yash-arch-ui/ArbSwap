"""C2 - the thesis renderer and the calibration decision are well-formed."""

from __future__ import annotations

from simulation.sim import thesis


def test_calibration_is_closed_by_decision():
    cal = thesis.calibration_residual()
    assert cal["status"] == "CLOSED-BY-DECISION"
    residual = cal["real_flow_residual"]
    # The corrected residual (arbitrageur on) is sane; disabling the arbitrageur
    # inflates it (the historical artifact).
    assert abs(residual["markout_bps"]) < 100.0
    assert residual["markout_bps_arb_off"] > 1_000.0


def test_render_has_decision_and_all_criteria():
    res = {
        "T_A": {"T_A_holds": False,
                "T_A_i_real_flow_ci": {"met": False, "reason": "not run"},
                "T_A_ii_quiet_hs_le_b1": {"met": False},
                "T_A_iii_noprop_share_ge_10pct": {"met": True, "share": 0.279},
                "T_A_iv_tolerance_insensitive": {"met": False}},
        "T_B": {"0.5": {"ArbSwap": {"volume_share": 0.0, "fill_share": 0.016},
                        "B1_passive": {"volume_share": 0.003},
                        "PropAMM": {"volume_share": 0.996}}},
        "T_C": {"prop_like_half_spread_bps": 0.5, "rows": [], "arb_le_b1_all": False},
        "niche_C2_7": {"arb_volume_share": 0.279, "arb_better_price_than_b1": True},
        "calibration": thesis.calibration_residual(),
        "envelope": {"cells": 0, "deploy_ok": 0, "not_ok": 0, "losing_examples": []},
        "decision": "Option 1 not shown",
    }
    md = thesis.render(res)
    assert "Option 1 not shown" in md
    for token in ("T-A", "T-B", "T-C", "C2.2", "C2.5", "C2.7"):
        assert token in md
