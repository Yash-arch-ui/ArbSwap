#!/usr/bin/env bash
# S2-37 Task 6: one-shot keeper/quote status (read-only).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
set -a; . ../../.env; set +a
export ARBSWAP_KEYPAIR="${ARBSWAP_KEYPAIR:-$ARBSWAP_DEVNET_KEYPAIR}"
npx tsx demo_status.ts
