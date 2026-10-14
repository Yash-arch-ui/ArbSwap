#!/usr/bin/env bash
# S2-38/39 fresh-fraction monitor (read-only). Usage: measure_fresh.sh [secs] [interval_ms]
#
# Sampling only: it does NOT start a keeper (never run a competing instance).
# It refuses to run unless a keeper already holds the demo lock, and it tees the
# JSON summary to the gitignored logs/ directory.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
set -a; . ../../.env; set +a
SECS="${1:-1200}"; IVL="${2:-400}"
LOCK="${TMPDIR:-/tmp}/arbswap-demo-keeper.lock"
mkdir -p ../../logs
if flock -n "$LOCK" -c true 2>/dev/null; then
  echo "no keeper is running (lock $LOCK is free)." >&2
  echo "start one first: scripts/devnet/demo_up.sh $SECS" >&2
  exit 2
fi
OUT="../../logs/fresh_monitor_$(date -u +%Y%m%dT%H%M%SZ).json"
echo "sampling ${SECS}s @ ${IVL}ms with the running keeper; writing $OUT" >&2
DURATION_SEC="$SECS" INTERVAL_MS="$IVL" npx tsx fresh_monitor.ts | tee "$OUT"
