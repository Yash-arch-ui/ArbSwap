#!/usr/bin/env bash
# S2.1c — fund an operator/tester wallet with ArbSwap devnet TEST TOKENS.
#
# These tokens are worthless: "TEST TOKEN, devnet". They are classic SPL tokens
# (Token-2022 is rejected by the program), minted under a hard per-call cap, and
# this script REFUSES to run on any cluster except devnet.
#
# Usage:
#   scripts/test_tokens.sh <mint> <amount_base_units> <recipient> [--url U]
#
#   mint       tSOL=76XvqdSVi2LhYWgeWjx6E1V2c7oBeB6ndUEp6xC44jp2 (dec 9)
#              tUSDC=q3xHxvxCBvYCMwuA6dFtTDHHwbqkrruTYWAWXdPuNFX (dec 6)
#   amount     in base units (1 tSOL = 1e9, 1 tUSDC = 1e6). Hard cap per call.
#   recipient  token account owner pubkey (the operator's ATA is auto-created).
#
# Mint authority is the devnet admin key given by ARBSWAP_DEVNET_KEYPAIR
# (public key 8R3V...). Do NOT revoke it yet; see the rotation note in
# docs/DEVNET.md before any public release.

set -euo pipefail

TSOL="76XvqdSVi2LhYWgeWjx6E1V2c7oBeB6ndUEp6xC44jp2"
TUSDC="q3xHxvxCBvYCMwuA6dFtTDHHwbqkrruTYWAWXdPuNFX"
# Hard per-call mint caps (base units). NOTE: plain integers only — bash does
# NOT accept `_` digit separators, so `5_000_000_000` made the cap check throw
# and silently bypass enforcement (S2.3 bugfix).
CAP_TSOL=5000000000      # 5 tSOL
CAP_TUSDC=5000000000     # 5,000 tUSDC

URL="https://api.devnet.solana.com"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    *) break ;;
  esac
done

MINT="${1:?usage: test_tokens.sh <mint> <amount> <recipient>}"
AMOUNT="${2:?amount in base units required}"
RECIPIENT="${3:?recipient pubkey required}"

# Refuse any non-devnet cluster.
case "$URL" in
  *devnet*) ;;
  *) echo "REFUSED: only devnet is allowed (got $URL)"; exit 1 ;;
esac
# Belt and braces: never let a mainnet hostname slip through.
case "$URL" in
  *mainnet*) echo "REFUSED: mainnet URL"; exit 1 ;;
esac

if [[ -z "${ARBSWAP_DEVNET_KEYPAIR:-}" ]]; then
  echo "REFUSED: ARBSWAP_DEVNET_KEYPAIR must point at the devnet admin keypair (8R3V...)"
  exit 1
fi

case "$MINT" in
  "$TSOL") CAP="$CAP_TSOL" ;;
  "$TUSDC") CAP="$CAP_TUSDC" ;;
  *) echo "REFUSED: unknown test mint $MINT (use tSOL or tUSDC addresses)"; exit 1 ;;
esac
if (( AMOUNT > CAP )); then
  echo "REFUSED: amount $AMOUNT exceeds per-call cap $(printf '%d' "$CAP")"
  exit 1
fi
if (( AMOUNT <= 0 )); then
  echo "REFUSED: amount must be positive"
  exit 1
fi

echo "TEST TOKEN, devnet: mint=$MINT amount=$AMOUNT recipient=$RECIPIENT"
ATA=$(spl-token address --verbose --token "$MINT" --owner "$RECIPIENT" --url "$URL" \
  | awk '/Associated token address:/{print $NF}')
if [[ -z "$ATA" ]]; then
  echo "REFUSED: could not derive the recipient associated token account"
  exit 1
fi
echo "recipient ATA: $ATA"
echo "creating / using ATA and minting (mint authority = admin keypair)"
spl-token create-account "$MINT" --owner "$RECIPIENT" --fee-payer "$ARBSWAP_DEVNET_KEYPAIR" --url "$URL" || true
spl-token mint "$MINT" "$AMOUNT" "$ATA" \
  --mint-authority "$ARBSWAP_DEVNET_KEYPAIR" \
  --fee-payer "$ARBSWAP_DEVNET_KEYPAIR" --url "$URL"

echo "balances:"
spl-token accounts --owner "$RECIPIENT" --url "$URL" || true