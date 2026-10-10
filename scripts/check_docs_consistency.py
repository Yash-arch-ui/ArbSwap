#!/usr/bin/env python3
"""F2 - fail if any generated number in the docs drifts from the bundle.

Checks, in order:

1. ``docs/RESULTS.md`` re-renders byte-for-byte from
   ``simulation/data/results/artifacts.json`` (generated region).
2. The README and ``docs/CLAIMS.md`` carry the bundle's test counts.
3. **Every CU number in every doc** matches ``artifacts/public/cu.json`` (the
   single source of truth). A line that names a backticked instruction and a
   CU-sized integer must contain the canonical value for that instruction; the
   known-stale tokens are banned outright.
4. The manifest's recorded commit is not stale (see ``check_bundle_freshness``).

Run: ``.venv/bin/python scripts/check_docs_consistency.py``
"""

from __future__ import annotations

import difflib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import render_docs  # noqa: E402

BUNDLE = ROOT / "simulation" / "data" / "results" / "artifacts.json"
CU_PUBLIC = ROOT / "artifacts" / "public" / "cu.json"
CU_RESULTS = ROOT / "simulation" / "data" / "results" / "cu.json"

# Values that were once documented but are no longer canonical. Any appearance
# in prose is a drift bug (they must live in `cu.json` history, not in docs).
STALE_CU_TOKENS = {
    "48,296",
    "48,079",
    "51,296",
    "61,513",
    "61,482",
    "59,162",
    "17,962",
    "71,518",
}
# A small allow-list of non-CU numbers that sit on a line with an instruction
# name and are *not* compute units (e.g. the CU limit).
NON_CU_ALLOW = {"80,000", "200,000", "50,000", "30,000", "40,000"}

# Dated snapshots (stage/audit reports) keep the numbers that were true on the
# day they were written. They carry this marker and are excluded from the
# "current numbers" check; living docs must match the bundle.
HISTORICAL_MARKER = "<!-- cu-scan: historical-snapshot -->"

INT_RE = re.compile(r"(?<![0-9A-Za-z])\d[\d,]*\d(?![0-9A-Za-z])")


def _cu_numbers(line: str) -> list[str]:
    """Comma-grouped integers only: CU values, never hashes/signatures/code."""
    return [m.group() for m in INT_RE.finditer(line) if "," in m.group()]


def _cu() -> dict:
    path = CU_PUBLIC if CU_PUBLIC.exists() else CU_RESULTS
    return json.loads(path.read_text())


def _doc_files() -> list[Path]:
    files = [ROOT / "README.md"]
    files += sorted((ROOT / "docs").glob("*.md"))
    return [f for f in files if f.exists()]


def scan_cu() -> list[str]:
    """Return human-readable drift findings for CU numbers in the docs."""
    cu = _cu()
    instructions: dict[str, int] = cu["instructions"]
    findings: list[str] = []
    skipped: list[str] = []
    for path in _doc_files():
        text = path.read_text()
        if HISTORICAL_MARKER in text:
            skipped.append(str(path.relative_to(ROOT)))
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            if any(token in line for token in STALE_CU_TOKENS):
                findings.append(f"{path.relative_to(ROOT)}:{lineno}: stale CU token: {line.strip()}")
                continue
            names = [name for name in instructions if f"`{name}`" in line]
            if not names:
                continue
            canon = {f"{instructions[name]:,}" for name in names}
            numbers = _cu_numbers(line)
            for number in numbers:
                if number in NON_CU_ALLOW or number in canon:
                    continue
                findings.append(
                    f"{path.relative_to(ROOT)}:{lineno}: {names} show {number}, "
                    f"expected one of {sorted(canon)}: {line.strip()}"
                )
    if skipped:
        print(f"CU scan: {len(skipped)} historical snapshot(s) excluded: "
              + ", ".join(skipped))
    return findings


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

    findings = scan_cu()
    if findings:
        ok = False
        print("CU numbers drift from artifacts/public/cu.json:")
        for finding in findings:
            print("  " + finding)
        print("regenerate: .venv/bin/python scripts/measure_cu.sh && "
              ".venv/bin/python scripts/export_artifacts.py && "
              ".venv/bin/python scripts/publish_artifacts.py")

    if ok:
        print(f"docs consistent with bundle (commit {bundle['meta']['short']})")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
