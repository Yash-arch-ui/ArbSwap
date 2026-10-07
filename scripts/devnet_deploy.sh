#!/usr/bin/env bash
# P2 devnet gate: deploy the program and claim the program admin.
#
# Prerequisites (owned by the operator, never committed):
#   - a funded devnet keypair at ~/.config/solana/id.json
#   - ANCHOR_PROVIDER_URL=https://api.devnet.solana.com (or
#     `solana config set --url devnet`)
#
# The program's `initialize_program` must be called by the deployer immediately
# after deploy so a vault PDA cannot be front-run (see the security tests).
# This script deploys, then prints the bootstrap instruction to submit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CLUSTER="${CLUSTER:-devnet}"
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-https://api.${CLUSTER}.solana.com}"

echo "== cluster =="
solana config get
echo "== balance (deploy needs ~5 SOL) =="
solana balance

echo "== build =="
anchor build

echo "== deploy =="
anchor deploy --provider.cluster "$CLUSTER"

PROGRAM_ID="$(solana address -k target/deploy/arbswap-keypair.json 2>/dev/null || \
  sed -n 's/.*declare_id!("\(.*\)").*/\1/p' programs/arbswap/src/lib.rs | head -1)"
echo
echo "program id: $PROGRAM_ID"
echo
echo "== next step (REQUIRED before any vault) =="
echo "Claim the program admin from the deployer keypair so initialize_vault"
echo "cannot be front-run. Use any Anchor/Solana client to submit"
echo "  instruction: InitializeProgram {}"
echo "  accounts:    admin (signer), program_config PDA [b\"program\"], system_program"
echo "The LiteSVM suite (tests/litesvm_security.rs) asserts that only this admin"
echo "may later call initialize_vault."
echo
echo "Then run the full money-path smoke on devnet (deposit -> update_quote ->"
echo "swap -> request_withdraw -> crank_epoch -> claim_withdraw) with your client."
