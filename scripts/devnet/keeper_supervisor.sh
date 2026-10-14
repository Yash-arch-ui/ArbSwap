#!/usr/bin/env bash
# S2-41: supervised keeper loop. Re-invokes `keeper_live.ts` in bounded windows and
# restarts it if it exits, so the market stays fresh through the ~22:12Z activation
# and across transient failures. Run under `flock` (single instance) by demo_up.sh.
# ENV: RUN_SECONDS (per-window, default 1800), MAX_FETCH_AGE_MS (default 1000).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
WINDOW="${RUN_SECONDS:-1800}"
echo "[supervisor] start $(date -u +%FT%TZ) window=${WINDOW}s"
while :; do
  RUN_SECONDS="$WINDOW" ATTEMPTS=100000 MAX_FETCH_AGE_MS="${MAX_FETCH_AGE_MS:-1000}" npx tsx keeper_live.ts
  code=$?
  echo "[supervisor] keeper exited rc=$code $(date -u +%FT%TZ); restarting in 3s"
  sleep 3
done
