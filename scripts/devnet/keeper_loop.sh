#!/usr/bin/env bash
# Bounded, single-instance operator runner for the staged-quote keeper.
#
# This is intentionally NOT an unbounded `while true`:
#   * it holds an exclusive `flock`, so a second copy cannot start by accident;
#   * it restarts a failed invocation with exponential backoff, but exits
#     non-zero after MAX_CONSECUTIVE_FAILURES so a supervisor can decide;
#   * success is decided inside `keeper_live.ts` by an independently reread
#     QuoteState version increase (never by the process merely returning).
#
# The driver still owns the authorization semantics: it only ever sends Pyth
# pushes plus `stage_quote`/`commit_quote`. No swaps are sent.
#
# Usage:  scripts/devnet/keeper_loop.sh [rpc] [run_seconds]
# Env:    MAX_CONSECUTIVE_FAILURES (default 3), BACKOFF_BASE_S (default 5)
set -euo pipefail

RPC="${1:-https://api.devnet.solana.com}"
RUN_SECONDS="${2:-600}"
MAX_CONSECUTIVE_FAILURES="${MAX_CONSECUTIVE_FAILURES:-3}"
BACKOFF_BASE_S="${BACKOFF_BASE_S:-5}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="${TMPDIR:-/tmp}/arbswap-keeper.$(printf '%s' "$RPC" | cksum | awk '{print $1}').lock"

if [[ -z "${PYTH_API_KEY:-}" ]]; then
  echo "PYTH_API_KEY is not set; load .env first (set -a; . ./.env; set +a)" >&2
  exit 2
fi

export ARBSWAP_KEYPAIR="${ARBSWAP_KEYPAIR:-$HOME/.config/solana/id.json}"
# The driver reads the endpoint from `ARBSWAP_RPC_URL`; without this export the
# positional `rpc` argument would only name the lock file and the driver would
# silently fall back to the default provider.
export ARBSWAP_RPC_URL="$RPC"
# Optional comma-separated fallbacks (e.g. a public endpoint alongside Helius).
export ARBSWAP_RPC_FALLBACKS="${ARBSWAP_RPC_FALLBACKS:-}"
export MAX_FETCH_AGE_MS="${MAX_FETCH_AGE_MS:-1000}"

# Single-instance guard for the whole lifetime of this runner.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another keeper runner already holds $LOCK; refusing to start a second instance" >&2
  exit 3
fi

echo "keeper runner: rpc=$RPC run=${RUN_SECONDS}s max_consecutive_failures=$MAX_CONSECUTIVE_FAILURES lock=$LOCK"
trap 'echo "keeper runner stopping" >&2' INT TERM

consecutive_failures=0
while :; do
  if ( cd "$HERE" && ATTEMPTS=100000 RUN_SECONDS="$RUN_SECONDS" SIMULATE_SWAP=0 npx tsx keeper_live.ts ); then
    # The invocation reached its run window (and may have committed quotes).
    consecutive_failures=0
    echo "keeper invocation finished its run window; restarting"
    continue
  fi
  consecutive_failures=$((consecutive_failures + 1))
  if (( consecutive_failures >= MAX_CONSECUTIVE_FAILURES )); then
    echo "keeper failed $consecutive_failures consecutive times; exiting non-zero (supervisor action required)" >&2
    exit 1
  fi
  backoff=$(( BACKOFF_BASE_S * (2 ** (consecutive_failures - 1)) ))
  echo "keeper invocation failed ($consecutive_failures/$MAX_CONSECUTIVE_FAILURES); retrying in ${backoff}s" >&2
  sleep "$backoff"
done
