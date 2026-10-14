#!/usr/bin/env bash
# S2-37 Task 6: fresh-fraction monitor (read-only). Usage: measure_fresh.sh [secs] [interval_ms]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
set -a; . ../../.env; set +a
DURATION_SEC="${1:-1200}" INTERVAL_MS="${2:-400}" npx tsx fresh_monitor.ts
