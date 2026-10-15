# Keeper Commands

Devnet quote keeper: run, inspect, restart, and diagnose.

## Check status / diagnose

```bash
# Is the keeper process running?
ps aux | grep -E "keeper_live|keeper_supervisor" | grep -v grep

# Live quote/vault freshness (FRESH vs EXPIRED, version, keeper, latency)
cd scripts/devnet && npx tsx demo_status.ts

# Deeper on-chain inspection (quote layout, config, vault status, keeper eligibility)
cd scripts/devnet && npx tsx keeper_inspect.ts

# Read-only preflight (cluster / program hash / vault / config / quote)
cd scripts/devnet && npx tsx preflight.ts

# Tail the supervised keeper log
tail -60 logs/keeper_supervised.log
```

## Stop the keeper

```bash
tmux kill-session -t arbswap-keeper
```

## Start / restart the keeper

The primary Helius RPC gets rate-limited (429), which stalls quote commits and
lets the quote go EXPIRED. Run with the public devnet RPC as primary and Helius
as fallback.

```bash
tmux kill-session -t arbswap-keeper 2>/dev/null
rm -f /tmp/arbswap-demo-keeper.lock

tmux new-session -d -s arbswap-keeper \
  "cd '/home/ash10/solana/arbswap/scripts/devnet' \
    && set -a && . ../../.env && set +a \
    && HELIUS=\"\$ARBSWAP_RPC_URL\" \
    && export ARBSWAP_KEYPAIR='/home/ash10/.config/solana/id.json' \
              ARBSWAP_RPC_URL='https://api.devnet.solana.com' \
              ARBSWAP_RPC_FALLBACKS=\"\$HELIUS\" \
              RUN_SECONDS='3600' \
    && exec flock -n '/tmp/arbswap-demo-keeper.lock' bash keeper_supervisor.sh \
      >> ../../logs/keeper_supervised.log 2>&1"

# Verify it came up and is committing
sleep 5
tmux ls
cd scripts/devnet && npx tsx demo_status.ts
```

## Alternative: standard supervised start (Helius primary)

```bash
cd scripts/devnet && ./demo_up.sh 1800
```

## Monitor freshness over time

```bash
cd scripts/devnet && ./measure_fresh.sh 1200 400
```

## Notes

- The vault status is `ACTIVE` (status 0) unless a circuit breaker trips; a
  stale quote is `EXPIRED`, not `PAUSED`.
- The supervisor (`keeper_supervisor.sh`) restarts `keeper_live.ts` on exit;
  a single `flock` on `/tmp/arbswap-demo-keeper.lock` prevents double instances.
- Never print the RPC URL: use `redactUrl` / redacted env when logging.
