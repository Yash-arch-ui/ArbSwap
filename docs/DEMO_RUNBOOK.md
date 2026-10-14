# DEMO_RUNBOOK.md — operator steps (Devnet)

Read-only unless explicitly marked. No secrets. RPC URLs come from `.env`
(`ARBSWAP_RPC_URL`, gitignored) or `ARBSWAP_RPC_FALLBACKS`; never printed.

## Start / stop the keeper (bounded, single instance)

```bash
cd scripts/devnet
set -a; . ../../.env; set +a            # loads ARBSWAP_RPC_URL + PYTH_API_KEY (not echoed)
export ARBSWAP_KEYPAIR="$HOME/.config/solana/id.json"
export NODE_OPTIONS=--no-network-family-autoselection

# bounded supervised run in tmux (flock-guarded; no unbounded loop)
tmux new -s keeper "MAX_CONSECUTIVE_FAILURES=3 RUN_SECONDS=600 npx tsx keeper_live.ts 2>&1 | tee ../../logs/keeper.$(date +%s).log"
# or the loop wrapper:
# tmux new -s keeper "scripts/devnet/keeper_loop.sh 600"
```

Health checks (read-only):

```bash
npx tsx keeper_inspect.ts          # quote version/author/expiry/freshness, vault, min_bond
solana balance 8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH -u "$ARBSWAP_RPC_URL"
```

Read quote freshness: `expiry_slot >= current slot` ⇒ FRESH; else EXPIRED (swaps
disabled). The app polls every 4 s and shows the status honestly.

## What to do on AMBER / RED (keeper liveness)

- AMBER/RED is a **provider/Pyth latency** condition (measured pipeline > 2 s
  freshness), not a protocol bug. Options (operator decision): lower-latency RPC /
  second endpoint; further keeper-side latency work; a documented devnet-only
  parameter decision (would need approval + `CLAIMS.md`); or build the demo around
  the recorded replay + evidence.
- Do **not** loosen `max_staleness_seconds`/confidence/anchor/expiry to force a pass.

## Epoch parameter

- Live: `epoch_slots = 1500`, `warmup_slots = 150`, `grace_slots = 2`, `vault.epoch
  = 0`, `epoch_start = 510190432` (uncranked, ~529k slots ago), ~**0.25 s/slot**.
- A withdrawal requested now gets `ticket.epoch = 1`; a single `crank_epoch` (already
  eligible) makes it claimable ≈ immediately. A withdrawal requested after a crank
  needs the next crank (~1500 slots ≈ 6.25 min).
- **`epoch_slots` cannot be changed** by `set_params` (not in `ParamsUpdate`; set only
  at `initialize_vault`, `lib.rs:116`). No epoch proposal was built or submitted.
- `max_staleness_seconds` **is** changeable via the timelocked `set_params` →
  `apply_params` (216 000 slots ≈ 15 h) but **must not** be changed in this task.

See `docs/EPOCH_CHECK.md` for the full derivation.
