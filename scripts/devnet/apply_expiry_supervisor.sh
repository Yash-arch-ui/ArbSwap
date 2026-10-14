#!/usr/bin/env bash
# S2-41: supervise the apply-expiry runner. Restarts it if it ever exits before
# the proposal is applied (e.g. the process dies), and stops once it has applied.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
while :; do
  bash apply_expiry.sh
  rc=$?
  if grep -q "apply-expiry done" ../../logs/apply_expiry.log 2>/dev/null; then
    echo "[apply-supervisor] applied; exiting $(date -u +%FT%TZ)"
    exit 0
  fi
  echo "[apply-supervisor] runner exited rc=$rc $(date -u +%FT%TZ); restarting in 60s"
  sleep 60
done
