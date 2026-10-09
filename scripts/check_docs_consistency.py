#!/usr/bin/env python3
"""C1.2 - fail if any generated number in the docs drifts from the C1 bundle.

CI runs this after ``scripts/render_docs.py``. It re-renders the generated block
from ``artifacts.json`` and diffs it against ``docs/RESULTS.md``; it also checks
that the README and CLAIMS test counts match the bundle. Exit 1 on drift.

Run: ``.venv/bin/python scripts/check_docs_consistency.py``
"""

from __future__ import annotations

import difflib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import render_docs  # noqa: E402

BUNDLE = ROOT / "simulation" / "data" / "results" / "artifacts.json"


def main() -> int:
    bundle = json.loads(BUNDLE.read_text())
    expected = render_docs.render()
    actual = render_docs.RESULTS.read_text()
    ok = True
    if expected != actual:
        ok = False
        print("docs/RESULTS.md is out of sync with artifacts.json:")
        diff = difflib.unified_diff(actual.splitlines(), expected.splitlines(),
                                    "docs/RESULTS.md", "rendered", lineterm="")
        print("\n".join(list(diff)[:40]))
        print("run: .venv/bin/python scripts/render_docs.py")

    tc = bundle["test_counts"]
    for doc in ("README.md", "docs/CLAIMS.md"):
        text = (ROOT / doc).read_text()
        if str(tc["rust"]) not in text or str(tc["python"]) not in text:
            ok = False
            print(f"{doc}: test counts {tc['rust']} Rust / {tc['python']} Python not found")

    if ok:
        print(f"docs consistent with bundle (commit {bundle['meta']['short']})")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
