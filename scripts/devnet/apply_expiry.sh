#!/usr/bin/env bash
# S2-37 Task 3: single-instance, admin-signed application of the authorized
# `expiry_slots` 10 -> 120 change once the timelock elapses. Waits (60 s poll,
# bounded 24 h), applies once eligible, then verifies that ONLY `expiry_slots`
# changed. Logs to the gitignored `logs/` directory. No secret is written.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
set -a; . ../../.env; set +a
export ARBSWAP_DEVNET_KEYPAIR="${ARBSWAP_DEVNET_KEYPAIR:-$HOME/.config/solana/id.json}"

LOCK="${TMPDIR:-/tmp}/arbswap-apply-expiry.lock"
mkdir -p ../../logs
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another apply-expiry run holds $LOCK; refusing to start a second" >&2
  exit 3
fi
exec >> ../../logs/apply_expiry.log 2>&1
echo "[$(date -u +%FT%TZ)] apply-expiry starting (lock=$LOCK)"
npx tsx apply_params.ts apply --wait
rc=$?
echo "[$(date -u +%FT%TZ)] apply-expiry finished rc=$rc"
exit "$rc"
