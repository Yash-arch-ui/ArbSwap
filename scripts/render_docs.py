#!/usr/bin/env python3
"""C1.2 - render the number-bearing blocks in docs FROM the C1 bundle.

``docs/RESULTS.md`` (and the README test-count line) contain generated regions
delimited by ``<!-- BEGIN GENERATED NUMBERS -->`` / ``<!-- END GENERATED NUMBERS -->``.
This script regenerates those regions from ``simulation/data/results/artifacts.json``
so the docs can never drift from the bundle. ``scripts/check_docs_consistency.py``
re-renders and diffs; CI runs it.

Run: ``.venv/bin/python scripts/render_docs.py``
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "simulation" / "data" / "results" / "artifacts.json"
RESULTS = ROOT / "docs" / "RESULTS.md"

BEGIN = "<!-- BEGIN GENERATED NUMBERS -->"
END = "<!-- END GENERATED NUMBERS -->"


def _fmt(v, nd=2):
    return "n/a" if v is None else f"{v:+.{nd}f}"


def generated_block(b: dict) -> str:
    cal = b["calibration"]
    cost = b["cost"]
    tc = b["test_counts"]
    mut = b["mutation"]
    meta = b["meta"]
    lines = []
    lines.append(BEGIN)
    lines.append("")
    lines.append(f"_Generated from `simulation/data/results/artifacts.json` "
                 f"(commit `{meta['short']}`, {meta['date']}, flow: {meta['flow_type']}). "
                 f"Do not edit by hand; run `scripts/render_docs.py`._")
    lines.append("")
    lines.append("**Calibration (W1):** B1 best 2s markout "
                 f"**{_fmt(cal['best_markout_bps'])} bps** "
                 f"(target {cal['target_markout_bps']}, accept {cal['accept_markout_bps']}); "
                 f"quiet half-spread **{cal['best_half_spread_bps']:.3f} bps** "
                 f"(target {cal['target_half_spread_bps']}, accept {cal['accept_half_spread_bps']}).")
    lines.append("")
    lines.append("**Routed world (W1-W6 mean; flow synthetic, price path "
                 f"{b['routed_world']['source']}):**")
    lines.append("")
    lines.append("| Venue | Volume share | Fill share | 2s markout (bps) |")
    lines.append("|---|---|---|---|")
    for row in b["routed_world"]["rows"]:
        lines.append(f"| {row['venue']} | {row['volume_share']:.1%} | "
                     f"{row['fill_share']:.1%} | {row['markout_2s_bps']:+.2f} |")
    lines.append("")
    e1 = b["e1_e4"]
    parts = [f"{w} {_fmt(e1[w]['E1_pct'], 1)}%" for w in ("W2", "W3", "W4", "W5", "W6") if w in e1]
    lines.append("**Held-out E1 (ArbSwap vs B1):** " + ", ".join(parts) + ".")
    lines.append("")
    lines.append("**Retail execution (E4):** ArbSwap quiet half-spread "
                 + ", ".join(f"{w} {e1[w]['E4_arb_quiet_half_spread_bps']:.2f}"
                             for w in e1)
                 + " bps; B1 "
                 + ", ".join(f"{e1[w]['E4_b1_quiet_half_spread_bps']:.2f}" for w in e1)
                 + " bps.")
    lines.append("")
    lines.append(f"**Cost (E10, source: `{b['cu'].get('source', 'n/a')}`):** "
                 f"`update_quote` **{cost['cu_update_quote']:,} CU**, "
                 f"`swap` **{cost['cu_swap']:,} CU**; "
                 f"cost/update {cost['update_total_quote']:.5f} quote @ SOL={cost['sol_price']:.0f}.")
    lines.append("")
    lines.append(f"**Compute units (single source: `artifacts/public/cu.json`; build "
                 f"`{b['cu'].get('build_method', 'n/a')}`; `.so` sha256 "
                 f"`{str(b['cu'].get('so_sha256', 'n/a'))[:12]}…`).**")
    lines.append("")
    lines.append("| Instruction | CU |")
    lines.append("|---|---|")
    for name, value in sorted(b["cu"]["instructions"].items()):
        lines.append(f"| `{name}` | {value:,} |")
    lines.append("")
    lines.append(f"**Tests:** {tc['rust']} Rust / {tc['python']} Python. "
                 f"**Guard mutations:** {mut['total']} caught "
                 f"({mut['source']}).")
    lines.append("")
    lines.append(END)
    return "\n".join(lines)


def render() -> str:
    bundle = json.loads(BUNDLE.read_text())
    block = generated_block(bundle)
    text = RESULTS.read_text()
    if BEGIN not in text or END not in text:
        raise SystemExit(f"{RESULTS} is missing the generated-number markers")
    pre = text.split(BEGIN)[0]
    post = text.split(END)[1]
    return pre + block + post


def main() -> None:
    RESULTS.write_text(render())
    print(f"rendered generated numbers into {RESULTS.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
