#!/usr/bin/env python3
"""F-idea mutation check: relax each NEW on-chain guard, rebuild the SBF program,
and confirm the mapped LiteSVM test fails (the guard is caught). Restores source
after each mutation.

Run: ``python scripts/mutation_program.py``
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "vault" / "program" / "src" / "lib.rs"

MUTATIONS = [
    (
        "M7 permissionless keeper gate",
        "        if ctx.accounts.config.min_bond == 0 {\n"
        "            require!(\n"
        "                ctx.accounts.keeper.key() == ctx.accounts.config.keeper,\n"
        "                ErrorCode::NotKeeper\n"
        "            );\n"
        "        }\n",
        "        require!(\n"
        "            ctx.accounts.keeper.key() == ctx.accounts.config.keeper,\n"
        "            ErrorCode::NotKeeper\n"
        "        );\n",
        "permissionless_bonded_keeper_may_quote_when_min_bond_is_set",
    ),
    (
        "§7.3 spread-step guard",
        "        if ctx.accounts.quote_state.version > 0 && ctx.accounts.config.max_spread_step_bps > 0 {\n"
        "            let spread_step = update\n"
        "                .half_spread_bps\n"
        "                .abs_diff(ctx.accounts.quote_state.half_spread_bps);\n"
        "            require!(\n"
        "                spread_step <= ctx.accounts.config.max_spread_step_bps,\n"
        "                ErrorCode::SpreadStepTooLarge\n"
        "            );\n"
        "        }\n",
        "        let _ = update.half_spread_bps;\n",
        "spread_step_is_bounded_per_update",
    ),
    (
        "§5.9 flow_n reset",
        "        quote.update_slot = update.update_slot;\n"
        "        // Spec §5.9: the flow accumulator resets on every quote update.\n"
        "        quote.flow_n = 0;\n",
        "        quote.update_slot = update.update_slot;\n",
        "flow_accumulator_tracks_net_base_and_resets",
    ),
]


def build_sbf() -> bool:
    result = subprocess.run(["cargo", "build-sbf"], cwd=ROOT / "vault" / "program",
                            capture_output=True, text=True)
    return result.returncode == 0


def run_test(name: str) -> bool:
    result = subprocess.run(["cargo", "test", "-p", "arbswap", name],
                            cwd=ROOT, capture_output=True, text=True)
    return result.returncode == 0


def main() -> int:
    original = LIB.read_text()
    ok = True
    rows = []
    for label, old, new, test in MUTATIONS:
        if old not in original:
            print(f"SKIP {label}: anchor not found")
            ok = False
            continue
        LIB.write_text(original.replace(old, new, 1))
        try:
            built = build_sbf()
            passed = run_test(test) if built else True
        finally:
            LIB.write_text(original)
        caught = not passed
        rows.append((label, test, caught))
        print(f"{label}: built={built} caught={caught}")
        if not caught:
            ok = False
    restored = LIB.read_text() == original
    print(f"tree restored: {restored}; caught {sum(1 for _, _, c in rows if c)}/{len(rows)}")
    return 0 if ok and restored else 1


if __name__ == "__main__":
    sys.exit(main())
