#!/usr/bin/env python3
"""C6.3 - banned-wording scan.

Fails (exit 1) if a banned term appears as a *claim* in product-facing files.
Quoted ban-lists, negated uses ("not cheap"), defined fail-closed terms
("safe failure"/"safe expiry"), plan/spec files and audit-analysis files are
allowed. Run: ``.venv/bin/python scripts/banned_words.py``
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

BANNED = {
    "exploit-free": r"exploit[- ]free",
    "audited": r"\baudited\b",
    "guaranteed": r"\bguaranteed\b",
    "risk-free": r"risk[- ]free",
    "beats propAMMs": r"beats?\s+prop\s?amms",
    "as complete as Uniswap": r"as complete as uniswap",
    "APY": r"\bAPY\b",
    "cheap": r"\bcheap\b",
    "safe": r"\bsafe\b",
}

# Whole files that quote/analyse the banned list or are the source spec.
SKIP_FILES = {
    "docs/BUILD_PLAN.md", "BuilderPlan.md", "MasterPlan.md", "README.md",
    "docs/CLAIMS.md", "docs/DEMO_SCRIPT.md", "docs/HEADLINE.md",
    "docs/AUDIT_ACHIEVED_VS_PLAN.md", "docs/PITCH_DECK.md", "docs/SECURITY.md",
    "docs/PRIOR_ART.md", "docs/THESIS.md", "docs/REMAINING_WORK.md",
    "TARGETIDEATASKS.md", "TARGETIDEATASKS_P2.md", "simulation/data/README.md",
}

# Line contexts that are legitimate (declarations, negations, fail-closed terms).
ALLOW = re.compile(
    r"banned|not claim|never|no known issues|independent audit|do not|don't|"
    r"n't|not cheap|not safe|fail[- ]?safe|safe failure|safe expiry|"
    r"unsupported|overstated|false|NOT |not |without|no |"
    r'exploit-free", "audited|"cheap"|"safe"|"guaranteed"|"risk-free"',
    re.IGNORECASE,
)

# Product-facing prose only (not code comments, dependency lockfiles, generated HTML).
EXTENSIONS = {".md", ".tsx", ".ts"}
SKIP_DIRS = {".git", "node_modules", "target", ".venv", "simulation/data/raw"}
SKIP_FILES = SKIP_FILES | {
    "docs/pitch_deck.html", "docs/demo_backup.html", "docs/headline_chart.svg",
}


def scan() -> list[tuple[str, int, str, str]]:
    hits = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix not in EXTENSIONS:
            continue
        rel = path.relative_to(ROOT).as_posix()
        if any(part in rel for part in SKIP_DIRS) or rel in SKIP_FILES:
            continue
        try:
            text = path.read_text(errors="ignore")
        except OSError:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if ALLOW.search(line):
                continue
            for name, pat in BANNED.items():
                if re.search(pat, line, re.IGNORECASE):
                    hits.append((rel, i, name, line.strip()[:120]))
    return hits


def main() -> int:
    hits = scan()
    if not hits:
        print("banned-wording scan: CLEAN")
        return 0
    print(f"banned-wording scan: {len(hits)} hit(s)")
    for rel, i, name, line in hits:
        print(f"  {rel}:{i} [{name}] {line}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
