#!/usr/bin/env python3
"""F3 — fail if the published artifact bundle is stale relative to HEAD.

A bundle cannot record the hash of the commit that contains it (the hash would
depend on itself), so the check enforces the strongest achievable guarantee:

1. every file's sha256 matches the manifest (no post-generation drift);
2. the manifest's recorded commit is an **ancestor of HEAD**;
3. **no commit after the recorded commit changed any source** (anything outside
   ``artifacts/`` and ``docs/``); if it did, the bundle must be regenerated.

Run: ``.venv/bin/python scripts/check_bundle_freshness.py``
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "artifacts" / "public"
MANIFEST = PUBLIC / "manifest.json"
BUNDLE = ROOT / "simulation" / "data" / "results" / "artifacts.json"


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True,
                          text=True).stdout.strip()


def main() -> int:
    if not MANIFEST.exists():
        print("missing artifacts/public/manifest.json; run scripts/publish_artifacts.py")
        return 1
    manifest = json.loads(MANIFEST.read_text())
    recorded = manifest.get("commit", "")
    head = _git("rev-parse", "HEAD")
    ok = True

    for name, meta in manifest.get("files", {}).items():
        path = PUBLIC / name
        if not path.exists():
            print(f"missing published file: {name}")
            ok = False
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != meta.get("sha256"):
            print(f"{name}: sha256 {digest[:12]} != manifest {str(meta.get('sha256'))[:12]}")
            ok = False

    if not recorded or not head:
        print("cannot resolve manifest/HEAD commit")
        return 1

    ancestor = subprocess.run(
        ["git", "merge-base", "--is-ancestor", recorded, head], cwd=ROOT
    ).returncode == 0
    if not ancestor:
        print(f"manifest commit {recorded[:12]} is not an ancestor of HEAD {head[:12]}")
        ok = False
    else:
        changed = _git("diff", "--name-only", recorded, head, "--",
                       ":(exclude)artifacts", ":(exclude)docs")
        changed = [line for line in changed.splitlines() if line.strip()]
        if changed:
            print(f"source changed after the bundle was generated ({recorded[:12]}):")
            for line in changed[:20]:
                print("  " + line)
            print("regenerate: scripts/measure_cu.sh && python scripts/export_artifacts.py "
                  "&& python scripts/publish_artifacts.py")
            ok = False

    if BUNDLE.exists():
        bundle = json.loads(BUNDLE.read_text())
        if bundle.get("meta", {}).get("short") not in (recorded, recorded[:7]):
            print("artifacts.json meta commit and manifest commit disagree")
            ok = False

    if ok:
        note = "at HEAD" if recorded == head else f"ancestor of HEAD ({recorded[:12]})"
        print(f"bundle fresh: {len(manifest.get('files', {}))} files verified, {note}")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
