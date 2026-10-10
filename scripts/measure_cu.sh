#!/usr/bin/env bash
# P3 - reproducible CU measurement with repeated sampling.
#
# The LiteSVM measurement is not perfectly deterministic: transfer-heavy
# instructions (deposit, request_withdraw, swap) vary run-to-run by up to a few
# thousand CU. A single sample is therefore not interpretable. This script:
#   1. builds the program once with a clean `cargo build-sbf` (the deployed
#      build method), records the .so hash;
#   2. runs the measurement test `SAMPLES` times (fresh LiteSVM per run);
#   3. writes `instructions` as the per-instruction median plus full stats
#      (n, min, median, max, range, mean, stdev) to cu.json.
#
# Usage: bash scripts/measure_cu.sh [SAMPLES]   (default 5)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SAMPLES="${1:-5}"
CUDIR="$ROOT/target/cu"
rm -rf "$CUDIR"
cd "$ROOT/vault/program"
CARGO_TARGET_DIR="$CUDIR" cargo build-sbf
mkdir -p "$ROOT/target/deploy"
cp "$CUDIR/deploy/arbswap.so" "$ROOT/target/deploy/arbswap.so"
cd "$ROOT"
RAW=/tmp/cu_raw.txt
: > "$RAW"
for _ in $(seq 1 "$SAMPLES"); do
  cargo test -p arbswap --test litesvm_lifecycle measure_instruction_compute_units -- --nocapture \
    2>&1 | rg "^cu_" >> "$RAW"
done
PY="${PYTHON:-python3}"; [ -x .venv/bin/python ] && PY=.venv/bin/python
"$PY" - "$SAMPLES" <<'PY'
import hashlib, json, pathlib, re, statistics, sys
root = pathlib.Path(".")
so = root / "target/deploy/arbswap.so"
samples = int(sys.argv[1])
lines = [ln.strip() for ln in open("/tmp/cu_raw.txt")
         if re.match(r"cu_\w+=\d+", ln.strip())]
names: list[str] = []
for ln in lines:
    name = re.match(r"cu_(\w+)=", ln).group(1)
    if name not in names:
        names.append(name)
per = len(names)
vals: dict[str, list[int]] = {name: [] for name in names}
for run in range(samples):
    for ln in lines[run * per:(run + 1) * per]:
        m = re.match(r"cu_(\w+)=(\d+)", ln)
        vals[m.group(1)].append(int(m.group(2)))
stats = {}
for name in names:
    v = vals[name]
    if not v:
        continue
    stats[name] = {
        "n": len(v), "min": min(v), "median": int(statistics.median(v)),
        "max": max(v), "range": max(v) - min(v),
        "mean": round(statistics.fmean(v), 1),
        "stdev": round(statistics.pstdev(v), 1) if len(v) > 1 else 0.0,
    }
instructions = {name: s["median"] for name, s in stats.items()}
data = {
    "source": "cargo build-sbf + litesvm_lifecycle.rs::measure_instruction_compute_units",
    "build_method": "cargo build-sbf (no idl-build)",
    "samples_per_instruction": samples,
    "so_bytes": so.stat().st_size if so.exists() else None,
    "so_sha256": hashlib.sha256(so.read_bytes()).hexdigest() if so.exists() else None,
    "instructions": instructions,
    "instructions_stats": stats,
    "note": ("LiteSVM CU varies run-to-run (transfer-heavy instructions up to a "
             "few thousand CU); `instructions` is the per-instruction median over "
             "`samples_per_instruction` fresh runs. See docs/SECURITY_CHECKLIST.md §3."),
}
pathlib.Path("simulation/data/results/cu.json").write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
print("wrote cu.json (median of", samples, "samples):")
for name in sorted(instructions):
    s = stats[name]
    print(f"  {name:32} median={s['median']:>7}  min={s['min']:>7} max={s['max']:>7} range={s['range']:>6}")
print("so_bytes:", data["so_bytes"])
PY
