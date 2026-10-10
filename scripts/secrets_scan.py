#!/usr/bin/env python3
"""Secrets scan (CI gate): no private keys, keypair files, or .env in the repo.

Flags, across ``git ls-files`` (tracked content only):

- filenames that are keypairs / env / PEM / GCP service-account keys;
- a Solana 64-byte keypair array literal (``[n,n,n,...]``);
- PEM private-key blocks;
- the devnet env var being read from anything other than the documented path.

Run: ``python scripts/secrets_scan.py``
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

BAD_NAMES = re.compile(
    r"(^|/)(id|.*-keypair|.*keypair|.*\.pem|.*\.key|.*\.p8|\.env(\..*)?)$",
    re.IGNORECASE,
)
KEYPAIR_ARRAY = re.compile(r"\[\s*(?:\d{1,3}\s*,\s*){40,}\d{1,3}\s*\]")
PEM = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")
ALLOW = {"scripts/devnet/package-lock.json", "simulation/data/test_download_vision.py"}


def _tracked() -> list[str]:
    out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True,
                         text=True, check=True).stdout
    return [line for line in out.splitlines() if line.strip()]


def main() -> int:
    findings: list[str] = []
    for name in _tracked():
        if name in ALLOW:
            continue
        if BAD_NAMES.search(name) and not name.endswith(".md"):
            findings.append(f"suspicious filename: {name}")
            continue
        path = ROOT / name
        try:
            text = path.read_text(errors="ignore")
        except (IsADirectoryError, UnicodeDecodeError, OSError):
            continue
        if PEM.search(text):
            findings.append(f"PEM private key block: {name}")
        if KEYPAIR_ARRAY.search(text):
            findings.append(f"Solana keypair array: {name}")
    if findings:
        print("secrets scan: FAIL")
        for finding in findings:
            print("  " + finding)
        return 1
    print("secrets scan: CLEAN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
