#!/usr/bin/env bash
# B1 - reproducible CU measurement.
#
# The CU test loads `target/deploy/arbswap.so`, so the number depends on HOW the
# .so was built: `cargo build-sbf` (no `idl-build`) gives ~48,296 CU for
# update_quote; `anchor build` (with `idl-build`) gives ~51,296. Measuring against
# a stale .so is the historical source of the 48,296 -> 51,296 "regression".
# This script forces a clean `cargo build-sbf` build, records the .so hash, and
# writes simulation/data/results/cu.json.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Dedicated, clean target dir so the .so is never a stale artifact from a
# previous `anchor build` (the historical 48,296 -> 51,296 cause).
CUDIR="$ROOT/target/cu"
rm -rf "$CUDIR"
cd "$ROOT/vault/program"
CARGO_TARGET_DIR="$CUDIR" cargo build-sbf
mkdir -p "$ROOT/target/deploy"
cp "$CUDIR/deploy/arbswap.so" "$ROOT/target/deploy/arbswap.so"
cd "$ROOT"
cargo test -p arbswap --test litesvm_lifecycle measure_instruction_compute_units -- --nocapture \
  2>&1 | rg "^cu_" | sort > /tmp/cu_raw.txt
PY="${PYTHON:-python3}"; [ -x .venv/bin/python ] && PY=.venv/bin/python
"$PY" - <<'PY'
import hashlib, json, re, pathlib
root = pathlib.Path(".")
so = root / "target/deploy/arbswap.so"
rows = {}
for ln in open("/tmp/cu_raw.txt"):
    m = re.match(r"cu_(\w+)=(\d+)", ln.strip())
    if m:
        rows[m.group(1)] = int(m.group(2))
data = {
    "source": "cargo build-sbf + vault/program/tests/litesvm_lifecycle.rs::measure_instruction_compute_units",
    "build_method": "cargo build-sbf (no idl-build)",
    "so_bytes": so.stat().st_size if so.exists() else None,
    "so_sha256": hashlib.sha256(so.read_bytes()).hexdigest() if so.exists() else None,
    "instructions": rows,
    "note": "anchor build (idl-build) is ~3k CU higher for update_quote (51,296 vs 48,296); no source regression. See docs/PROGRESS.md B1.",
}
pathlib.Path("simulation/data/results/cu.json").write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
print("wrote cu.json:", rows)
print("so_bytes:", data["so_bytes"])
PY
