#!/usr/bin/env bash
# S2-41: start the keeper SUPERVISED under tmux (single-instance via flock,
# restart-on-exit) so the market stays fresh through the timelocked activation.
#
#   scripts/devnet/demo_up.sh [per_window_seconds] [tmux_session]
#
# Status: tmux attach -t <session>   |   scripts/devnet/demo_check.sh
# Logs:   logs/keeper_supervised.log  |   logs/keeper_<ts>.log
# Stop:   tmux kill-session -t <session>
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
set -a; . ../../.env; set +a
export ARBSWAP_KEYPAIR="${ARBSWAP_KEYPAIR:-$ARBSWAP_DEVNET_KEYPAIR}"
export ARBSWAP_RPC_FALLBACKS="${ARBSWAP_RPC_FALLBACKS:-https://api.devnet.solana.com}"

RUN_SECONDS="${1:-1800}"
SESSION="${2:-${KEEPER_TMUX:-arbswap-keeper}}"
LOCK="${TMPDIR:-/tmp}/arbswap-demo-keeper.lock"
mkdir -p ../../logs

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already exists; refusing a second keeper" >&2
  exit 3
fi

tmux new-session -d -s "$SESSION" \
  "cd '$PWD' && set -a && . ../../.env && set +a && export ARBSWAP_KEYPAIR='$ARBSWAP_KEYPAIR' ARBSWAP_RPC_FALLBACKS='$ARBSWAP_RPC_FALLBACKS' RUN_SECONDS='$RUN_SECONDS' && exec flock -n '$LOCK' bash keeper_supervisor.sh >> ../../logs/keeper_supervised.log 2>&1"

echo "supervised keeper started: tmux '$SESSION' (window ${RUN_SECONDS}s, lock=$LOCK)"
echo "status: tmux attach -t $SESSION ; scripts/devnet/demo_check.sh ; logs: logs/keeper_supervised.log"
