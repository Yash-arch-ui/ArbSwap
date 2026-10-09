"""C2 - pre-registered closure thesis test (Amendment 3).

Evaluates T-A / T-B / T-C and the C2.7 niche from the routed world and the
held-out artifacts. Writes ``docs/THESIS.md`` and
``simulation/data/results/thesis.json``.

The routed world uses the **real price path** (W1-W6 slices) with **synthetic
flow** (noise + informed). That is a model output, not a product result.
"""

from __future__ import annotations

import json
from pathlib import Path

from simulation.sim.router import route_window
from simulation.sim.study import _load_slice
from simulation.sim.windows import WINDOWS

ROOT = Path(__file__).resolve().parents[2]
OUT_MD = ROOT / "docs" / "THESIS.md"
OUT_JSON = ROOT / "simulation" / "data" / "results" / "thesis.json"

COMPETITOR_HS = (0.3, 0.5, 1.0, 2.0)


def _mean(rows_list, venue):
    vs = [r["volume_share"] for rows in rows_list for r in rows if r["venue"] == venue]
    fs = [r["fill_share"] for rows in rows_list for r in rows if r["venue"] == venue]
    mk = [r["markout_2s_bps"] for rows in rows_list for r in rows if r["venue"] == venue]
    n = max(1, len(vs))
    return {"volume_share": sum(vs) / n, "fill_share": sum(fs) / n,
            "markout_2s_bps": sum(mk) / n, "windows": len(vs)}


def routed(*, prop_hs: float = 0.5, include_prop: bool = True,
           insensitive_share: float = 0.2, slippage_bps: float = 1.0) -> dict:
    per_window = []
    for w in WINDOWS:
        prices = _load_slice(w)
        per_window.append(route_window(
            prices, prop_hs=prop_hs, include_prop=include_prop,
            insensitive_share=insensitive_share, slippage_bps=slippage_bps))
    venues = {v for rows in per_window for r in rows for v in [r["venue"]]}
    return {"per_window": per_window,
            "mean": {v: _mean(per_window, v) for v in venues}}


def t_b_competitor_spreads() -> dict:
    out = {}
    for hs in COMPETITOR_HS:
        out[str(hs)] = routed(prop_hs=hs)["mean"]
    return out


def t_a_iii_and_niche() -> dict:
    """Routed world WITHOUT a propAMM: ArbSwap volume share (T-A.iii, C2.7)."""
    r = routed(include_prop=False)
    arb = r["mean"].get("ArbSwap", {})
    b1 = r["mean"].get("B1_passive", {})
    return {"mean": r["mean"], "arb_volume_share": arb.get("volume_share", 0.0),
            "arb_ge_10pct": arb.get("volume_share", 0.0) >= 0.10,
            "arb_markout_bps": arb.get("markout_2s_bps"),
            "b1_markout_bps": b1.get("markout_2s_bps"),
            "arb_better_price_than_b1": (arb.get("markout_2s_bps", 0.0)
                                         >= b1.get("markout_2s_bps", 0.0))}


def t_c_retail() -> dict:
    wr = json.loads((ROOT / "simulation" / "data" / "results"
                     / "window_results.json").read_text())
    rows = []
    for label, win in wr["windows"].items():
        rep = win["reports"]
        arb = rep.get("ArbSwap", {})
        b1 = rep.get("B1_passive", {})
        rows.append({
            "window": label,
            "arb": arb.get("quiet_half_spread_bps"),
            "b1": b1.get("quiet_half_spread_bps"),
            "arb_le_b1": (arb.get("quiet_half_spread_bps", 1e9)
                          <= b1.get("quiet_half_spread_bps", -1e9)),
        })
    # the propAMM-like venue's quiet half-spread is its spread parameter.
    prop_hs = 0.5
    return {"rows": rows, "prop_like_half_spread_bps": prop_hs,
            "arb_le_b1_all": all(r["arb_le_b1"] for r in rows)}


def t_a() -> dict:
    # T-A.i (real aggTrades flow, bootstrap CI above zero in >=3 windows incl. a
    # stress window) is NOT met: the real-flow study is not run here and the
    # measured real-flow B1 saturates at ~-7.9/13 bps (F-08). T-A.ii (quiet
    # half-spread <= B1) is NOT met (see T-C). T-A.iii is the no-propAMM share.
    iii = t_a_iii_and_niche()
    tc = t_c_retail()
    return {
        "T_A_i_real_flow_ci": {"met": False,
                               "reason": "real aggTrades held-out study with bootstrap CIs not "
                                         "run; measured real-flow B1 saturates at ~-7.9/13 bps (F-08)"},
        "T_A_ii_quiet_hs_le_b1": {"met": tc["arb_le_b1_all"], "detail": tc["rows"]},
        "T_A_iii_noprop_share_ge_10pct": {"met": iii["arb_ge_10pct"],
                                          "share": iii["arb_volume_share"]},
        "T_A_iv_tolerance_insensitive": {"met": False,
                                         "reason": "depends on T-A.i real-flow run"},
        "T_A_holds": False,
    }


def calibration_residual() -> dict:
    b1 = json.loads((ROOT / "simulation" / "data" / "results"
                     / "b1_calibration.json").read_text())
    best = b1.get("best", {})
    return {
        "paper_markout_bps": b1.get("target_markout"),
        "accept_markout_bps": b1.get("accept_markout"),
        "fit_markout_bps": best.get("markout_2s_bps"),
        "paper_half_spread_bps": b1.get("target_half_spread"),
        "accept_half_spread_bps": b1.get("accept_half_spread"),
        "fit_half_spread_bps": best.get("half_spread_bps"),
        "real_flow_residual": {"markout_bps": -7.9, "half_spread_bps": 13.1,
                               "source": "docs/AUDIT_FULL.md (real flow saturates)"},
        "status": "CLOSED-BY-DECISION",
        "reason": "synthetic W1 fit is within tolerance (-0.02/2.41); real-flow "
                  "adverse selection saturates at ~-7.9/13.1 bps (~40x/5x the "
                  "paper), a venue/flow-definition gap that parameter tuning "
                  "cannot close. Bounded impact: all headline numbers are model "
                  "outputs and labelled so.",
    }


def envelope_summary() -> dict:
    path = ROOT / "simulation" / "data" / "results" / "envelope.json"
    if not path.exists():
        return {"cells": 0}
    rows = json.loads(path.read_text())
    lose = [r for r in rows if not r["deploy_ok"]]
    return {"cells": len(rows), "deploy_ok": len(rows) - len(lose),
            "not_ok": len(lose),
            "losing_examples": sorted(
                ({"regime": r["regime"], "vault_fee_bps": r["vault_fee_bps"],
                  "prop_half_spread_bps": r["prop_half_spread_bps"],
                  "arb_volume_share": r["arb_volume_share"],
                  "arb_markout_2s_bps": r["arb_markout_2s_bps"]} for r in lose),
                key=lambda r: (r["arb_volume_share"] or 0))[:5]}


def evaluate() -> dict:
    print("routed: competitor spreads (T-B)...")
    tb = t_b_competitor_spreads()
    print("routed: no-propAMM (T-A.iii / C2.7)...")
    niche = t_a_iii_and_niche()
    tc = t_c_retail()
    ta = t_a()
    return {"T_A": ta, "T_B": tb, "T_C": tc, "niche_C2_7": niche,
            "calibration": calibration_residual(),
            "envelope": envelope_summary(),
            "decision": "Option 1 not shown" if not ta["T_A_holds"]
                        else "Option 1 secondary claim allowed"}


def render(res: dict) -> str:
    def pct(x):
        return f"{100 * x:.1f}%"
    lines = ["# THESIS.md — pre-registered closure thesis test (Amendment 3)", "",
             "Model output (real price path, synthetic flow). Not a product result.", ""]
    lines += ["## T-A — \"Beats passive\" (Option 1)", "",
              f"**Holds: {res['T_A']['T_A_holds']}**", "",
              f"- T-A.i real aggTrades flow with CI>0: **{res['T_A']['T_A_i_real_flow_ci']['met']}** "
              f"— {res['T_A']['T_A_i_real_flow_ci']['reason']}",
              f"- T-A.ii quiet half-spread ≤ B1 (all windows): **{res['T_A']['T_A_ii_quiet_hs_le_b1']['met']}**",
              f"- T-A.iii no-propAMM volume share ≥ 10%: **{res['T_A']['T_A_iii_noprop_share_ge_10pct']['met']}** "
              f"(share {pct(res['T_A']['T_A_iii_noprop_share_ge_10pct']['share'])})",
              f"- T-A.iv tolerance 1 bp + 20% insensitive: **{res['T_A']['T_A_iv_tolerance_insensitive']['met']}**",
              "", "## T-B — competitiveness vs propAMM-like venues", "",
              "| competitor half-spread (bps) | ArbSwap vol | B1 vol | prop vol | ArbSwap fill |",
              "|---|---|---|---|---|"]
    for hs, m in res["T_B"].items():
        a = m.get("ArbSwap", {})
        b = m.get("B1_passive", {})
        p = m.get("PropAMM", {})
        lines.append(f"| {hs} | {pct(a.get('volume_share',0))} | {pct(b.get('volume_share',0))} "
                     f"| {pct(p.get('volume_share',0))} | {pct(a.get('fill_share',0))} |")
    lines += ["", "## T-C — retail execution (E4)", "",
              f"propAMM-like half-spread = {res['T_C']['prop_like_half_spread_bps']} bps", "",
              "| window | ArbSwap quiet half-spread | B1 | ArbSwap ≤ B1 |",
              "|---|---|---|---|"]
    for r in res["T_C"]["rows"]:
        lines.append(f"| {r['window']} | {r['arb']:.2f} | {r['b1']:.2f} | {r['arb_le_b1']} |")
    lines += ["", "## C2.7 — niche (no propAMM)", "",
              f"ArbSwap volume share {pct(res['niche_C2_7']['arb_volume_share'])}; "
              f"better markout than B1: {res['niche_C2_7']['arb_better_price_than_b1']}", ""]
    cal = res["calibration"]
    lines += ["## C2.2 — calibration vs the paper", "",
              f"| | 2s markout (bps) | quiet half-spread (bps) |", "|---|---|---|",
              f"| paper target | {cal['paper_markout_bps']} | {cal['paper_half_spread_bps']} |",
              f"| accept | {cal['accept_markout_bps']} | {cal['accept_half_spread_bps']} |",
              f"| synthetic W1 fit | {cal['fit_markout_bps']:.3f} | {cal['fit_half_spread_bps']:.3f} |",
              f"| real-flow residual | {cal['real_flow_residual']['markout_bps']} | "
              f"{cal['real_flow_residual']['half_spread_bps']} |", "",
              f"**{cal['status']}.** {cal['reason']}", ""]
    env = res["envelope"]
    lines += ["## C2.5 — operating envelope (routed world)", "",
              f"{env.get('cells',0)} cells: **{env.get('deploy_ok',0)} deploy-ok**, "
              f"**{env.get('not_ok',0)} not**. Axes: vault fee {{1,3,5,10,20}} bps, "
              "competitor half-spread {0.3,0.5,1,2,4} bps, regime {calm,trend,crash}. "
              "Not-ok = zero volume share or negative markout. Worst cells:", ""]
    for r in env.get("losing_examples", []):
        lines.append(f"- {r['regime']} vault_fee={r['vault_fee_bps']} prop_hs={r['prop_half_spread_bps']}: "
                     f"share {pct(r['arb_volume_share'] or 0)}, markout {r['arb_markout_2s_bps']:+.2f} bps")
    lines += ["", "## Decision", "", f"**{res['decision']}**", ""]
    return "\n".join(lines)


def main() -> None:
    res = evaluate()
    OUT_JSON.write_text(json.dumps(res, indent=2, sort_keys=True) + "\n")
    OUT_MD.write_text(render(res))
    print(f"wrote {OUT_JSON.relative_to(ROOT)} and {OUT_MD.relative_to(ROOT)}")
    print("decision:", res["decision"])


if __name__ == "__main__":
    main()
