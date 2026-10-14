#!/usr/bin/env bash
# S2-37 Task 6: start the keeper under tmux, single-instance (flock), redacted.
#
#   scripts/devnet/demo_up.sh [run_seconds] [tmux_session]
#
# Status:  tmux attach -t <session>      Logs: logs/keeper_*.log
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
set -a; . ../../.env; set +a
export ARBSWAP_KEYPAIR="${ARBSWAP_KEYPAIR:-$ARBSWAP_DEVNET_KEYPAIR}"
export ARBSWAP_RPC_FALLBACKS="${ARBSWAP_RPC_FALLBACKS:-}"

RUN_SECONDS="${1:-600}"
SESSION="${2:-${KEEPER_TMUX:-arbswap-keeper}}"
LOCK="${TMPDIR:-/tmp}/arbswap-demo-keeper.lock"
mkdir -p ../../logs

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already exists; refusing a second keeper" >&2
  exit 3
fi

tmux new-session -d -s "$SESSION" \
  "cd '$PWD' && flock -n '$LOCK' env RUN_SECONDS=$RUN_SECONDS ATTEMPTS=100000 MAX_FETCH_AGE_MS=1500 npx tsx keeper_live.ts >> ../../logs/keeper_\$(date -u +%Y%m%dT%H%M%SZ).log 2>&1"

echo "keeper started: tmux '$SESSION' (RUN_SECONDS=$RUN_SECONDS, lock=$LOCK)"
echo "status: tmux attach -t $SESSION ; logs: logs/keeper_*.log ; scripts/devnet/demo_check.sh"
