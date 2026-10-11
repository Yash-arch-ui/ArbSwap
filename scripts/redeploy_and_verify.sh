#!/usr/bin/env bash
# P3 - deploy the EXACT HEAD build to devnet and verify byte-for-byte.
#
# Blocked by default: a funded devnet keypair is required. Per the repo rule
# (docs/STATUS.md, rule 6) the devnet key is supplied only via the env var
# ARBSWAP_DEVNET_KEYPAIR (a path OUTSIDE the repo); if it is unset this script
# exits with the exact remaining command sequence and marks the item SKIPPED.
#
# Read-only provenance check (needs no keypair):
#   .venv/bin/python scripts/devnet_program_hash.py \
#       --program-id 2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm \
#       --so target/deploy/arbswap.so
#
# Full redeploy + verify:
#   ARBSWAP_DEVNET_KEYPAIR=/abs/path/devnet.json bash scripts/redeploy_and_verify.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROGRAM_ID="${PROGRAM_ID:-2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm}"
RPC="${RPC:-https://api.devnet.solana.com}"

echo "== build exact HEAD (deployed method: cargo build-sbf, no idl-build) =="
( cd vault/program && cargo build-sbf )
cp target/cu/deploy/arbswap.so target/deploy/arbswap.so 2>/dev/null || true

if [ -z "${ARBSWAP_DEVNET_KEYPAIR:-}" ]; then
  echo
  echo "SKIPPED: ARBSWAP_DEVNET_KEYPAIR is unset."
  echo "To complete the live check later, run exactly:"
  echo "  ARBSWAP_DEVNET_KEYPAIR=/abs/path/devnet.json \\"
  echo "    solana program deploy target/deploy/arbswap.so \\"
  echo "    --program-id target/deploy/arbswap-keypair.json --url $RPC"
  echo "  .venv/bin/python scripts/devnet_program_hash.py --program-id $PROGRAM_ID --so target/deploy/arbswap.so"
  echo "  (then initialize_program if the program PDA is unset; see docs/DEVNET.md)"
  exit 0
fi

echo "== deploy =="
solana program deploy target/deploy/arbswap.so \
  --program-id target/deploy/arbswap-keypair.json \
  --url "$RPC" \
  --keypair "$ARBSWAP_DEVNET_KEYPAIR"

echo "== verify bytes match the local build =="
.venv/bin/python scripts/devnet_program_hash.py --program-id "$PROGRAM_ID" --rpc "$RPC" \
  --so target/deploy/arbswap.so
