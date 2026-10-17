# DEMO_RUNBOOK.md — operator steps (Devnet)

Read-only unless explicitly marked. No secrets. RPC URLs come from `.env`
(`ARBSWAP_RPC_URL`, gitignored) or `ARBSWAP_RPC_FALLBACKS`; never printed.

> **Devnet demo configuration (scheduled; not yet active).** Quotes remain valid
> for 120 slots (~30 s) so a person can swap; the oracle must still be within 2 s
> at quote commit, but the swap does not re-check oracle age, so a longer
> validity increases exposure to stale-price fills; test funds only; the
> realized-edge breaker and the per-window flow cap remain active. This is a
> configuration, not a protocol guarantee.

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

## Operator checklist (S2-37 demo)

1. **Start the keeper** (single instance, redacted):
   `scripts/devnet/demo_up.sh 600` → tmux `arbswap-keeper`; status `tmux attach -t arbswap-keeper`.
2. **Check fresh**: `scripts/devnet/demo_check.sh` (shows FRESH/EXPIRED, version, author, seconds to expiry, keeper SOL, RPC latency).
3. **Fund the wallet**: Devnet SOL from `https://faucet.solana.com/`; USDC from `https://faucet.circle.com/` (select Solana Devnet, mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`).
4. **Wrap SOL**: the Swap page creates the WSOL ATA and offers the depth/Use-max controls; wrapping keeps >= 0.05 SOL for fees.
5. **Live swap**: with a fresh quote, BuyBase <= 0.5 USDC (<= 0.5lippage). The app re-reads the live quote at submit time and refuses after expiry.
6. **If the keeper stalls** (Hermes auth/rate-limit, RPC outage): use the **Demo** tab (offline, deterministic) and the **Evidence** tab (recorded devnet signatures); do not present those as live.
7. **After the timelocked apply** (Task 3): re-measure with `scripts/devnet/measure_fresh.sh 1800 400` (30 min, 400 ms) — baseline for expiry=10 is `logs/fresh_baseline.json`.

## Single-token deposit / withdrawal (flag-gated; default off)

The single-token Vault controls are hidden unless the build sets
`VITE_ENABLE_SINGLE_SIDED=true` **and** transactions are enabled. Keep it **off**
for the default demo build. An on-chain CLI smoke of `deposit_single` /
`claim_withdraw_single` has passed for both directions (2026-10-17,
`docs/DEVNET.md` STEP 4), but the **browser wallet-signed** path has not been
exercised, so the flag stays off; the default demo uses the two-sided Vault flow.

If (and only if) you have also completed a browser wallet-signed single-token
smoke and want to show the path:

1. Build/run with the flag:
   `VITE_ENABLE_SINGLE_SIDED=true yarn --cwd app dev` (or set it in the demo
   build configuration). Confirm the Vault page shows the **Deposit with:
   Both / Single token** and **Receive as: Both / One token** toggles.
2. Deposit: pick **Single token**, choose SOL or USDC, enter an amount, and read
   the preview — swap portion, internal swap out, fee, price impact vs the
   reservation mid, expected shares and `min_shares` (0.5% slippage default). A
   fresh quote is required; when expired the action is disabled with the reason
   and, if the size is too large, "Max swap depth now: X".
3. Withdraw: pick **Receive as: One token**, choose the payout token, and read
   the base/quote legs, converted leg, fee, impact, expected payout and
   `min_out`. If the quote is expired, fall back to **Both tokens** (the normal
   claim works with an expired quote).
4. The app builds, simulates, shows a preview, then asks the wallet to sign; it
   re-reads the on-chain quote at submit time and refuses if it has expired.

What to say: this is a trade against the vault's **own committed ladder** at the
committed quote, so it shares the same stale-quote exposure as a swap; it is
bounded by the anchor-deviation bound, the per-window flow cap and the
realized-edge breaker; test funds only. See `docs/SINGLE_SIDED_DESIGN.md`.
