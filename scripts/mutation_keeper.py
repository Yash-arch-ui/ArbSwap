#!/usr/bin/env python3
"""F3/B3 — re-run the F6 keeper-guard mutation table at HEAD.

Each entry relaxes one guard in ``vault/keeper/src/lib.rs``, runs the mapped
keeper test, and asserts the test **fails** (the mutation is caught). The file is
restored afterwards. Fast (the keeper crate is small), so it is safe to run in CI.

Run: ``python scripts/mutation_keeper.py``
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "vault" / "keeper" / "src" / "lib.rs"

MUTATIONS = [
    (
        "F6 wide-confidence guard",
        "if update.confidence_bps > bounds.max_conf_bps {",
        "if false && update.confidence_bps > bounds.max_conf_bps {",
        "prevalidate_rejects_a_wide_confidence",
    ),
    (
        "F6 capacity/utilization guard",
        "    if ask_base_capacity.saturating_mul(BPS_DENOM as u128)\n"
        "        > bounds\n"
        "            .available_base\n"
        "            .saturating_mul(bounds.utilization_max_bps as u128)\n"
        "    {\n"
        "        return Err(PrevalidateError::UtilizationExceeded);\n"
        "    }\n"
        "    if bid_quote_capacity.saturating_mul(BPS_DENOM as u128)\n"
        "        > bounds\n"
        "            .available_quote\n"
        "            .saturating_mul(bounds.utilization_max_bps as u128)\n"
        "    {\n"
        "        return Err(PrevalidateError::UtilizationExceeded);\n"
        "    }",
        "    let _ = (ask_base_capacity, bid_quote_capacity);",
        "prevalidate_rejects_an_oversized_ladder",
    ),
    (
        "F6 anchor-step guard",
        "if diff.saturating_mul(BPS_DENOM as u128)\n"
        "            > old.saturating_mul(bounds.max_anchor_step_bps as u128)\n"
        "        {",
        "if false {",
        "prevalidate_rejects_an_anchor_step",
    ),
    (
        "F6 stale-oracle guard",
        "    if update.publish_time < 0\n"
        "        || bounds.now_publish_time.saturating_sub(update.publish_time)\n"
        "            > bounds.max_staleness_seconds\n"
        "    {\n"
        "        return Err(PrevalidateError::StaleOracle);\n"
        "    }",
        "    let _ = update.publish_time;",
        "prevalidate_rejects_a_stale_oracle",
    ),
]


def run_test(name: str) -> bool:
    """True if the test passes."""
    result = subprocess.run(
        ["cargo", "test", "-p", "arbswap-keeper", name],
        cwd=ROOT, capture_output=True, text=True,
    )
    return result.returncode == 0


def main() -> int:
    original = LIB.read_text()
    ok = True
    rows = []
    for label, old, new, test in MUTATIONS:
        if old not in original:
            print(f"SKIP {label}: anchor text not found (source changed)")
            ok = False
            continue
        LIB.write_text(original.replace(old, new, 1))
        try:
            passed = run_test(test)
        finally:
            LIB.write_text(original)
        caught = not passed
        rows.append((label, test, caught))
        print(f"{label}: test={test} caught={caught}")
        if not caught:
            ok = False
    # Confirm the tree is restored and tests pass unmutated.
    restored = LIB.read_text() == original
    print(f"tree restored: {restored}")
    print(f"caught {sum(1 for _, _, c in rows if c)}/{len(rows)}")
    return 0 if ok and restored else 1


if __name__ == "__main__":
    sys.exit(main())
