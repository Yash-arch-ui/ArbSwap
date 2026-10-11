#!/usr/bin/env bash
# B3/P4 - short, bounded fuzz run over the three targets (used by CI).
#
# Requires the nightly toolchain and cargo-fuzz:
#   rustup toolchain install nightly && cargo install cargo-fuzz
#
# Usage: bash scripts/fuzz_short.sh [SECONDS_PER_TARGET]   (default 30)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SECS="${1:-30}"
for target in arb_math walk_ladder quote_validation; do
  echo "== fuzz ${target} (${SECS}s) =="
  cargo +nightly fuzz run "${target}" -- -max_total_time="${SECS}" -runs=200000
done
echo "fuzz: all targets clean"
