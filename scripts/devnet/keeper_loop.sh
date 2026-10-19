#!/usr/bin/env bash
# Continuous, single-instance operator runner for the staged-quote keeper.
#
# Design:
#   * `keeper_live.ts` runs continuously (ATTEMPTS=0 RUN_SECONDS=0); there is no
#     fixed 600 s handover window, so there is no gap on a window boundary.
#   * one exclusive flock is held for the whole lifetime of the runner, so two
#     keeper processes can never write concurrently.
#   * a crashed invocation is restarted after a short, capped backoff; the loop
#     never exits on consecutive failures (systemd may still restart the unit).
#   * RPC endpoints (primary + ARBSWAP_RPC_FALLBACKS) rotate on each failed
#     invocation, so a 429/outage on one provider does not pin the keeper.
#
# Usage:  scripts/devnet/keeper_loop.sh [rpc-url] [legacy_run_seconds]
# Env:    BACKOFF_BASE_S (default 2), BACKOFF_CAP_S (default 10)
#         MAX_CONSECUTIVE_FAILURES (default 3) is logged, not fatal.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LEGACY_WINDOW=""
FIRST="${1:-}"
if [[ "$FIRST" =~ ^https?:// ]]; then
  PRIMARY="$FIRST"
  LEGACY_WINDOW="${2:-}"
elif [[ "$FIRST" =~ ^[0-9]+$ ]]; then
  PRIMARY="${ARBSWAP_RPC_URL:-https://api.devnet.solana.com}"
  LEGACY_WINDOW="$FIRST"
else
  PRIMARY="${ARBSWAP_RPC_URL:-https://api.devnet.solana.com}"
fi
BACKOFF_BASE_S="${BACKOFF_BASE_S:-2}"
BACKOFF_CAP_S="${BACKOFF_CAP_S:-10}"
FAILURE_LOG_EVERY="${MAX_CONSECUTIVE_FAILURES:-3}"

if [[ -n "$LEGACY_WINDOW" ]]; then
  echo "keeper runner: ignoring legacy ${LEGACY_WINDOW}s window; running continuously" >&2
fi

# Resolve the quote-engine binary for this checkout unless explicitly provided.
if [[ -z "${KEEPER_BIN:-}" ]]; then
  for candidate in "$ROOT/target/release/arbswap-keeper" "$ROOT/target/debug/arbswap-keeper"; do
    if [[ -x "$candidate" ]]; then export KEEPER_BIN="$candidate"; break; fi
  done
fi

if [[ -z "${PYTH_API_KEY:-}" ]]; then
  echo "PYTH_API_KEY is not set; load .env first (set -a; . ./.env; set +a)" >&2
  exit 2
fi

export ARBSWAP_KEYPAIR="${ARBSWAP_KEYPAIR:-${ARBSWAP_DEVNET_KEYPAIR:-$HOME/.config/solana/id.json}}"
export MAX_FETCH_AGE_MS="${MAX_FETCH_AGE_MS:-1000}"

# Prefer the local tsx binary: no npm cache writes (important under
# ProtectHome=read-only) and a faster restart.
if [[ -x "$HERE/node_modules/.bin/tsx" ]]; then
  KEEPER_TSX=("$HERE/node_modules/.bin/tsx")
else
  KEEPER_TSX=(npx tsx)
fi

# Optional comma-separated fallbacks (e.g. a public endpoint alongside Helius).
IFS=',' read -r -a FALLBACKS <<< "${ARBSWAP_RPC_FALLBACKS:-}"
ENDPOINTS=("$PRIMARY")
for fb in "${FALLBACKS[@]}"; do
  fb="${fb#"${fb%%[![:space:]]*}"}"
  fb="${fb%"${fb##*[![:space:]]}"}"
  [[ -n "$fb" ]] && ENDPOINTS+=("$fb")
done

# Single-instance guard shared by every entrypoint (systemd, tmux, manual).
if [[ -n "${KEEPER_LOCK:-}" ]]; then
  LOCK="$KEEPER_LOCK"
elif [[ -d /run/arbswap-keeper && -w /run/arbswap-keeper ]]; then
  LOCK="/run/arbswap-keeper/keeper.lock"
elif [[ -w /run ]]; then
  LOCK="/run/arbswap-keeper.lock"
else
  LOCK="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/arbswap-keeper.lock"
fi
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another keeper runner already holds $LOCK; refusing to start a second instance" >&2
  exit 3
fi

redact() {
  local url="$1"
  if command -v node >/dev/null 2>&1; then
    URL="$url" node -e 'try{const u=new URL(process.env.URL);process.stdout.write(u.protocol+"//"+u.host)}catch{process.stdout.write("<invalid-url>")}'
  else
    printf '%s' "$url" | sed -E 's#(https?://[^/]+).*#\1#'
  fi
}

echo "keeper runner: endpoints=$((${#ENDPOINTS[@]})) rpc=$(redact "${ENDPOINTS[0]}") continuous=1 lock=$LOCK" >&2
trap 'echo "keeper runner stopping" >&2; exit 0' INT TERM

consecutive_failures=0
endpoint_index=0
while :; do
  export ARBSWAP_RPC_URL="${ENDPOINTS[$endpoint_index]}"
  # Continuous: the driver's own loop never stops on success and never exits on
  # transient errors; this outer loop only restarts a crashed/hung process.
  if ( cd "$HERE" && ATTEMPTS=0 RUN_SECONDS=0 SIMULATE_SWAP=0 "${KEEPER_TSX[@]}" keeper_live.ts ); then
    consecutive_failures=0
    echo "[$(date -u +%FT%TZ)] keeper invocation exited cleanly; restarting immediately" >&2
    sleep 1
    continue
  fi

  consecutive_failures=$((consecutive_failures + 1))
  endpoint_index=$(( (endpoint_index + 1) % ${#ENDPOINTS[@]} ))
  backoff=$(( BACKOFF_BASE_S * (2 ** (consecutive_failures - 1)) ))
  (( backoff > BACKOFF_CAP_S )) && backoff="$BACKOFF_CAP_S"
  echo "[$(date -u +%FT%TZ)] keeper invocation failed (${consecutive_failures} consecutive); next_rpc=$(redact "${ENDPOINTS[$endpoint_index]}") retry_in=${backoff}s" >&2
  if (( consecutive_failures % FAILURE_LOG_EVERY == 0 )); then
    echo "[$(date -u +%FT%TZ)] ${consecutive_failures} consecutive failures; staying alive (systemd Restart=always)" >&2
  fi
  sleep "$backoff"
done
