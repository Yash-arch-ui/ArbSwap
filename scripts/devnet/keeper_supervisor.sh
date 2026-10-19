#!/usr/bin/env bash
# Legacy entrypoint: delegate to the continuous, single-instance keeper runner.
# Run under systemd or tmux; keeper_loop.sh owns the flock and restart policy.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec ./keeper_loop.sh "${1:-${ARBSWAP_RPC_URL:-https://api.devnet.solana.com}}"
