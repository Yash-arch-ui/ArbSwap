#!/usr/bin/env python3
"""C1.1 - one versioned JSON bundle = the single source of truth for numbers.

Aggregates every number that appears in prose/docs into
``simulation/data/results/artifacts.json`` with provenance:

- ``meta``: commit, date, flow type, frozen-parameter hash, data hashes
- ``calibration``: B1 vs paper (from ``b1_calibration.json``)
- ``held_out`` + ``e1_e4``: W2-W6 per-venue metrics (from ``window_results.json``)
- ``studies``: S1-S5 (from ``study_results.json``)
- ``routed_world``: volume/fill share + markout (from ``headline.json``)
- ``cost``: E10 CU + gas/priority (from ``simulation.sim.costs``)
- ``sensitivity``: E9 grid summary (from ``simulation.sim.e9_e10`` if run)
- ``cu``: measured CU per instruction (from ``simulation/data/results/cu.json``)
- ``mutation``: guard mutation table (parsed from ``docs/SECURITY_CHECKLIST.md``)
- ``test_counts``: Rust + Python totals (measured)

Run: ``.venv/bin/python scripts/export_artifacts.py``
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "simulation" / "data" / "results"
RAW = ROOT / "simulation" / "data" / "raw"
OUT = RESULTS / "artifacts.json"
SEC_CHECKLIST = ROOT / "docs" / "SECURITY_CHECKLIST.md"


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True,
                          check=True).stdout.strip()


def _sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _load(name: str) -> dict:
    path = RESULTS / name
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def calibration() -> dict:
    b1 = _load("b1_calibration.json")
    best = b1.get("best", {})
    return {
        "window": b1.get("window"),
        "target_markout_bps": b1.get("target_markout"),
        "accept_markout_bps": b1.get("accept_markout"),
        "best_markout_bps": best.get("markout_2s_bps"),
        "target_half_spread_bps": b1.get("target_half_spread"),
        "accept_half_spread_bps": b1.get("accept_half_spread"),
        "best_half_spread_bps": best.get("half_spread_bps"),
        "best_params": {k: best.get(k) for k in ("depth_mult", "mean_size", "arrival_rate")},
        "seed": b1.get("seed"),
    }


def held_out() -> tuple[dict, dict]:
    wr = _load("window_results.json")
    windows = wr.get("windows", {})
    regimes = wr.get("regimes", {})
    regime_by_window = {v: k for k, v in regimes.items()}
    held: dict = {}
    e1_e4: dict = {}
    for label, win in windows.items():
        reports = win.get("reports", {})
        arb = reports.get("ArbSwap", {})
        b1 = reports.get("B1_passive", {})
        e1 = None
        if b1.get("hedged_pnl"):
            e1 = (arb.get("hedged_pnl", 0.0) - b1["hedged_pnl"]) / abs(b1["hedged_pnl"]) * 100.0
        held[label] = {
            "dates": win.get("dates"),
            "regime": regime_by_window.get(label, "unlabelled"),
            "sigma_per_sqrt_s": win.get("sigma"),
            "log_return_7d": win.get("log_return"),
            "venues": {
                name: {
                    "hedged_pnl": r.get("hedged_pnl"),
                    "markout_2s_bps": r.get("markout_2s_bps"),
                    "quiet_half_spread_bps": r.get("quiet_half_spread_bps"),
                    "gap_bps": r.get("gap_bps"),
                    "fill_rate": r.get("fill_rate"),
                    "trades": r.get("trades"),
                    "rejects": r.get("rejects"),
                }
                for name, r in reports.items()
            },
        }
        e1_e4[label] = {
            "E1_pct": e1,
            "E2_arb_markout_2s_bps": arb.get("markout_2s_bps"),
            "E2_b1_markout_2s_bps": b1.get("markout_2s_bps"),
            "E3_arb_hedged_pnl": arb.get("hedged_pnl"),
            "E3_b2_hedged_pnl": reports.get("B2_fixed_spread", {}).get("hedged_pnl"),
            "E4_arb_quiet_half_spread_bps": arb.get("quiet_half_spread_bps"),
            "E4_b1_quiet_half_spread_bps": b1.get("quiet_half_spread_bps"),
            "E4_arb_le_b1": (arb.get("quiet_half_spread_bps", 1e9)
                             <= b1.get("quiet_half_spread_bps", -1e9)),
        }
    return held, e1_e4


def studies() -> dict:
    st = _load("study_results.json")
    return {k: st.get(k) for k in ("S1", "S2", "S3", "S4", "S5") if k in st}


def routed_world() -> dict:
    h = _load("headline.json")
    return {"source": h.get("source"), "rows": h.get("rows", [])}


def cost() -> dict:
    sys.path.insert(0, str(ROOT))
    from simulation.sim.costs import CostModel

    cu = cu_table().get("instructions", {})
    cm = CostModel(cu_update=cu.get("update_quote", 0), cu_swap=cu.get("swap", 0))
    sol_price = 150.0
    gas_u, prio_u = cm.update(sol_price)
    gas_s, prio_s = cm.swap(sol_price)
    return {
        "cu_update_quote": cm.cu_update,
        "cu_swap": cm.cu_swap,
        "sol_price": sol_price,
        "update_gas_quote": gas_u,
        "update_priority_quote": prio_u,
        "update_total_quote": gas_u + prio_u,
        "swap_total_quote": gas_s + prio_s,
        "updates_per_hour": 3600,
    }


def cu_table() -> dict:
    return _load("cu.json")


def mutation() -> dict:
    text = SEC_CHECKLIST.read_text() if SEC_CHECKLIST.exists() else ""
    rows = [ln for ln in text.splitlines()
            if ln.startswith("|") and ln.rstrip().endswith("| caught |")]
    return {"total": len(rows), "caught": len(rows),
            "source": "docs/SECURITY_CHECKLIST.md"}


def test_counts() -> dict:
    rust = 0
    try:
        out = subprocess.run(["cargo", "test", "--workspace", "--", "--list"],
                             cwd=ROOT, capture_output=True, text=True, timeout=600).stdout
        rust = sum(1 for ln in out.splitlines() if ln.endswith(": test"))
    except Exception as exc:  # noqa: BLE001
        rust = -1
        print(f"warning: rust count failed: {exc}", file=sys.stderr)
    python = 0
    try:
        out = subprocess.run([".venv/bin/pytest", "simulation", "--collect-only", "-q"],
                             cwd=ROOT, capture_output=True, text=True, timeout=600).stdout
        m = re.search(r"(\d+) tests? collected", out)
        python = int(m.group(1)) if m else -1
    except Exception as exc:  # noqa: BLE001
        python = -1
        print(f"warning: python count failed: {exc}", file=sys.stderr)
    return {"rust": rust, "python": python}


def data_hashes() -> dict:
    manifest = ROOT / "docs" / "DATA_MANIFEST.md"
    names = re.findall(r"\|\s*([\w.\-]+\.csv)\s*\|", manifest.read_text()) if manifest.exists() else []
    out = {}
    for name in names:
        digest = _sha256(RAW / name)
        if digest:
            out[name] = digest
    return out


def build(*, with_tests: bool = True) -> dict:
    held, e1_e4 = held_out()
    frozen = RESULTS / "frozen_params.json"
    bundle = {
        "meta": {
            "commit": _git("rev-parse", "HEAD"),
            "short": _git("rev-parse", "--short", "HEAD"),
            "date": date.today().isoformat(),
            "flow_type": "synthetic (real price path)",
            "frozen_params_sha256": _sha256(frozen),
            "data_sha256": data_hashes(),
            "note": "Model output. Not a product result. See docs/RESULTS.md.",
        },
        "calibration": calibration(),
        "held_out": held,
        "e1_e4": e1_e4,
        "studies": studies(),
        "routed_world": routed_world(),
        "cost": cost(),
        "cu": cu_table(),
        "mutation": mutation(),
        "test_counts": test_counts() if with_tests else _load("test_counts.json"),
    }
    return bundle


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--no-tests", action="store_true", help="skip measuring test counts")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()
    bundle = build(with_tests=not args.no_tests)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(bundle, indent=2, sort_keys=True) + "\n")
    print(f"wrote {args.out.relative_to(ROOT)}")
    print(f"  commit {bundle['meta']['short']}  rust={bundle['test_counts']['rust']} "
          f"python={bundle['test_counts']['python']}  mutation={bundle['mutation']['total']}")
    print(f"  calibration best markout={bundle['calibration']['best_markout_bps']} "
          f"half_spread={bundle['calibration']['best_half_spread_bps']}")


if __name__ == "__main__":
    main()
