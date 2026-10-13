# ArbSwap Backend ↔ Frontend Integration Runbook

**Current, canonical.** Supersedes all earlier revisions of this file. Grounded in
the deployed Devnet program, the committed IDL, and the actual `app/` source as of
S2-29. Historical incident details live in `docs/PROGRESS.md`,
`docs/DECENTRALIZATION_AUDIT.md`, and `docs/DEVNET.md` — not here.

The active frontend is **`app/`**. `frontend/` is an empty scaffold (no `src/`);
ignore it.

## 0. Architecture (no hosted backend)

```text
vault/program     Anchor program: custody, shares, swap, quote guards, migration
vault/math        fixed-point ladder + swap math (shared, frozen)
vault/keeper      Rust quote engine + legacy `live` sender (the staged TS keeper is used)
scripts/devnet    operator tooling: keeper, migration, preflight, RPC helpers
simulation        Python reference/simulator + optional analytics/indexer
app/              Vite + React wallet client (reads RPC directly)
```

There is **no ArbSwap-operated HTTP backend**. The app reads Solana RPC + the
committed IDL and optional static/historical files. Protocol correctness always
comes from on-chain state; RPC is availability only.

## 1. Source of truth

1. Deployed program + Rust source: `vault/program/src/lib.rs`.
2. Generated IDL: `target/idl/arbswap.json` (committed copy: `app/src/idl/arbswap.json`).
3. Frontend chain client: `app/src/chain/`.
4. This runbook + `docs/S2_*` records.
5. Historical docs / mock UI.

After any ABI change: regenerate the IDL and copy it to the app. Never hand-edit it.

## 2. Current deployment (Devnet)

| Item | Value |
|---|---|
| Cluster | Devnet (genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`) |
| Program | `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` |
| ProgramData | `4156VC8Vzc8wQDqtLe9rdRHtRj9UpRysp2uBTNGW93Mh` |
| Upgrade authority | `ddGs6hk5E4oPzSnwFfX4pD4DDhDTLTwRddv1VQym7bH` (single key) |
| Base mint | `So11111111111111111111111111111111111111112` (WSOL, 9 dp) |
| Quote mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Circle devnet USDC, 6 dp) |
| Vault | `8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt` |
| Config | `ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT` |
| QuoteState | `5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG` (897 B current layout) |
| Pyth feed ID | `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` |
| Token program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Deployed ELF | sha256 `b4df2b0f…f7096` (MATCHES local artifact) |

The older tSOL/tUSDC vault (`52cNnsip…`, config `HhBCf2Xo…`) is **reference only**
and is not used by the app. `app/src/chain/config.ts` is the app's single source of
truth and asserts the derived PDAs match at startup.

**Live state is not guaranteed fresh.** At the last S2-29 read: QuoteState v28,
author `8R3VDePS…`, expired; vault Active; `min_bond = 0`. Always reread.

## 3. Cluster + RPC configuration (env)

The app and keeper read RPC config from the environment (no secrets in the browser):

| Var | Purpose |
|---|---|
| `ARBSWAP_CLUSTER` / `VITE_ARBSWAP_CLUSTER` | `devnet` (default) \| `mainnet-beta` |
| `ARBSWAP_RPC_URL` / `VITE_SOLANA_RPC_URL` | primary endpoint |
| `ARBSWAP_RPC_FALLBACKS` / `VITE_SOLANA_RPC_FALLBACKS` | comma-separated fallbacks |
| `PYTH_API_KEY` | Hermes access token (keeper only; `.ENV`, gitignored) |
| `ARBSWAP_KEYPAIR` | keeper signer path (default `~/.config/solana/id.json`) |

- Node tooling: `scripts/devnet/rpc.ts` (`RpcPool`: cluster-guarded, redaction,
  error classification, bounded jittered backoff, ordered failover, genesis check).
- Browser: `app/src/chain/rpcConfig.ts` + `app/src/chain/rpcFailover.ts`
  (`APP_RPC_FAILOVER`); app reads **and** transaction construction use it.
- **Limitation:** the wallet adapter's `ConnectionProvider` still points at the
  primary endpoint for its internal calls; there is no supported API to swap its
  `Connection` dynamically without risking signer/extension compatibility. The app
  never mixes clusters (cross-cluster public URLs are rejected at config load).
- `app/.env.example` documents the browser variables (placeholders only).

## 4. Program accounts / PDAs

```text
program_config = [b"program"]
vault          = [b"vault", base_mint, quote_mint]
config         = [b"config", vault]
quote_state    = [b"quote", vault]            (897-byte account)
bond_vault     = [b"bond", vault]
keeper_bond    = [b"keeper", vault, keeper]
pending_quote  = [b"pending_quote", vault, keeper]
keeper_reward  = [b"reward", vault, keeper]   (per-keeper reward)
deposit_ticket = [b"dep", vault, user]
withdraw_ticket= [b"wd", vault, user]
pending_config = [b"pending", vault]
pending_claim  = [b"claim", vault]
```

## 5. Quote lifecycle and the keeper

**The normal path is staged** (`scripts/devnet/keeper_live.ts`), not the legacy
direct `update_quote` loop:

1. Fetch a fresh Pyth update from Hermes (official receiver SDK for the VAA/push).
2. Compute the quote payload with the Rust engine (`arbswap-keeper quote-json`).
3. `stage_quote` (Tx A) — writes the `pending_quote` PDA for that keeper.
4. Pyth receiver VAA post (Tx V) — Wormhole verify.
5. Pyth push oracle **+ `commit_quote`** in one transaction (Tx B): the oracle write
   and the quote commit are atomic. `commit_quote` re-runs the full oracle/mint/
   anchor/ladder/inventory/capacity guard set.
6. Reread `QuoteState`; success requires a **confirmed** tx and a strictly greater
   version (never `version > 0`, never a missing `getTransaction`).

Operator tooling:
- `scripts/devnet/keeper_live.ts` — the keeper (`DRY_RUN=1` builds/size-checks only).
- `scripts/devnet/keeper_loop.sh` — bounded, `flock`-guarded runner (no unbounded loop).
- `scripts/devnet/keeper_commit.ts` — `SUBMITTED/CONFIRMED/FAILED/UNOBSERVED/COMMITTED_AND_VERIFIED`.
- `scripts/devnet/keeper_inspect.ts` — read-only live quote/eligibility.

Deployed safety rules (unchanged, must not be loosened): 2 s Pyth freshness,
10 bps confidence cap, 25-slot stage age, anchor step/dev bounds, expiry, ladder/
inventory/capacity/flow.

## 6. Authorization and attribution

- `config.min_bond == 0` ⇒ **permissionless**: any valid signer may
  `update_quote`/`stage_quote`/`commit_quote`. `min_bond > 0` ⇒ any keeper meeting
  the on-chain bond rule.
- Keeper eligibility is **immutable** (`min_bond`/`keeper` are not in `ParamsUpdate`).
- `QuoteState.keeper` records the author of the committed quote. `swap` credits the
  keeper share to that keeper's `KeeperReward` PDA; `claim_keeper_reward` pays only
  the signer's own PDA, capped by the vault's aggregate keeper buckets.
- A migrated/legacy quote has `keeper = Pubkey::default()` and **cannot** be swapped
  (`UnattributedQuote`).

## 7. Instruction interfaces (exact accounts, from the committed IDL)

```text
update_quote:  keeper, vault, config, quote_state, price_update, keeper_bond,
               base_reserve, quote_reserve, base_mint, quote_mint
stage_quote:   keeper, vault, config, quote_state, pending_quote,
               base_reserve, quote_reserve, keeper_bond, system_program
commit_quote:  keeper, vault, config, quote_state, pending_quote, price_update,
               base_reserve, quote_reserve, keeper_bond, base_mint, quote_mint
swap:          trader, vault, config, quote_state, base_reserve, quote_reserve,
               trader_base, trader_quote, keeper_reward, system_program, token_program
deposit:       user, vault, config, base_reserve, quote_reserve, share_mint,
               share_lock, user_base, user_quote, user_shares, deposit_ticket,
               token_program, system_program
request_withdraw: user, vault, share_lock, deposit_ticket, user_shares,
               withdraw_ticket, token_program, system_program
claim_withdraw: user, vault, base_reserve, quote_reserve, share_mint, share_lock,
               withdraw_ticket, user_base, user_quote, token_program
crank_epoch:   vault, config
claim_keeper_reward: keeper, vault, keeper_reward, base_reserve, quote_reserve,
               keeper_base, keeper_quote, token_program
migrate_quote_state: payer, vault, quote_state, system_program   (operator-only)
```

Admin/ops (not user-facing): `initialize_program`, `initialize_vault`,
`set_params`, `apply_params`, `propose_admin`, `accept_admin`, `cancel_admin`,
`propose_fee_claim`, `execute_fee_claim`, `bond_keeper`, `unbond_keeper`,
`slash_keeper`, `trip_breaker`, `reset_breaker`, `wind_down`.

Args: `QuoteUpdate` carries no `oracle_price` (derived on-chain); `LevelUpdate` is
`{sqrt_lo, sqrt_hi, liquidity}` only.

## 8. Frontend integration

- **Chain layer** (`app/src/chain/`): `program.ts` (IDL client, PDA derivation,
  builders), `config.ts` (deployment constants + env RPC), `live.ts`
  (on-chain → UI decode incl. `QuoteState.keeper`), `solana.ts` (wallet balances),
  `rpcConfig.ts`/`rpcFailover.ts`, `swapMath.ts`/`amounts.ts` (integer math),
  `gating.ts` (fail-closed swap gate).
- **State** (`app/src/context/ProtocolContext.tsx`): polls live state every 4 s via
  the failover pool; exposes quote/vault/risk/tickets/balances/status; empty state
  is zero or unavailable, never mock.
- **Pages**: Overview, Swap, Vault (deposit / request-withdraw / claim), Risk
  (+ keeper rewards), Analytics (+ optional historical panel).
- **Gating**: swaps require vault Active, a fresh attributed quote, and correct
  `min_out`/version/expiry. USDC 6 dp, WSOL 9 dp. Missing price is never `$0.00`.
- **Transaction lifecycle**: constructed → signature requested → submitted →
  confirmed → reread. No optimistic balance changes; no auto-submit on render.
- **Wallet**: connect/disconnect via wallet adapter; balances are the **connected**
  wallet's ATAs; the app never uses the admin/keeper wallet by assumption.
- **Keeper rewards**: `fetchKeeperReward`/`claimKeeperReward` +
  `components/KeeperRewards.tsx` (Risk page) show only the connected wallet's own
  `KeeperReward` and handle disconnected / no-account / zero / RPC-error states.

## 9. Analytics

- **Static bundle** `app/public/artifacts/*` → `app/src/data/backend.ts` →
  AnalyticsPage (labeled model/replay, not live).
- **Optional historical export** `/analytics/onchain.json` (written by
  `simulation/analytics/export.py`) → `app/src/data/onchainAnalytics.ts` +
  `components/OnchainAnalyticsPanel.tsx`, with available / stale (>1 h) / missing /
  malformed states. Currently absent in this deployment → shown unavailable.
- Live balances/quotes/reserves are **never** sourced from analytics. No hosted
  analytics backend; the indexer is optional local tooling.

## 10. Migration and release preflight

- `migrate_quote_state` upgrades a legacy 865-byte QuoteState to 897 bytes, appends
  `keeper = default`, preserves all fields; permissionless payer. See
  `docs/S2_21A_MIGRATION.md`; driver `scripts/devnet/migrate_quote_state.ts`
  (dry-run default, `SUBMIT=1` to submit).
- `scripts/devnet/release_preflight.ts` (read-only) validates cluster, program id/
  authority, QuoteState owner/disc/size/PDA, rent, payer, artifact + IDL.
- `scripts/devnet/release_manifest.ts` writes `docs/release_manifest.json`.

## 11. Commands

```bash
# program + math
cargo fmt --all --check && cargo test --workspace

# frontend
cd app && yarn install && yarn test && yarn lint && yarn build && yarn dev

# keeper (operator)
cd scripts/devnet && set -a; . ../../.ENV; set +a
NODE_OPTIONS=--no-network-family-autoselection npx tsx keeper_inspect.ts   # read-only
DRY_RUN=1 npx tsx keeper_live.ts                                           # dry-run
npx tsx keeper_loop.sh                                                      # bounded runner

# migration / release
npx tsx migrate_quote_state.ts            # dry-run
npx tsx release_preflight.ts              # read-only preflight

# analytics
.venv/bin/python -m pytest simulation/analytics/tests -q
```

Browser E2E (headless Chromium over CDP): `app/e2e/browser-smoke.mjs` — see
`docs/S2_27_BROWSER_E2E.md`.

## 12. Chronology (why earlier revisions differ)

tSOL/tUSDC demo → canonical WSOL/USDC; Pyth entitlement blocker → unblocked;
packet-size blocker on direct `update_quote` → staged quotes; keeper allowlist →
permissionless + immutable eligibility; `QuoteState` gained `keeper` (865 → 897,
migrated on Devnet); program upgraded to the current artifact. Do not treat any
single historical state as current.

## 13. Remaining work (integration status)

**Blocking the core live proof**
1. **Independent-keeper live commit** — blocked by provider/Pyth latency: the 3-tx
   staged pipeline takes 3–8 s vs the deployed 2 s freshness window (S2-29). Keeper
   B is provisioned/funded (`6FqSc5…`); needs a lower-latency RPC
   (`ARBSWAP_RPC_URL`) or co-located Hermes. **No code blocker.**

**Backend / governance**
2. Move the single-key upgrade authority (`ddGs6hk5…`) to a multisig.
3. Define objective on-chain slashing criteria (currently admin-discretionary).
4. Re-propose any in-flight `PendingConfig` after an upgrade (transient account).

**Frontend**
5. Wallet-adapter `ConnectionProvider` endpoint consistency (documented limitation).
6. Browser E2E for **connected-wallet** flows (deposit/withdraw/claim/keeper-claim)
   with a mocked wallet — only disconnected states are rendered-tested today.
7. Keeper telemetry (volatility/inventory/jump) has no on-chain source → keep
   rendering `unavailable` (verify no mock remains).
8. Archive/ignore the empty `frontend/` scaffold.

**Release / demo**
9. Produce (or intentionally omit) the `/analytics/onchain.json` export in the
   deployment; the UI already handles absence.

Count: **1 blocking live-proof task (provider), 3 backend/governance, 4 frontend,
1 release** — ~9 distinct items. Only #1 gates the decentralization proof; the
rest are governance hardening, UX/E2E depth, or optional analytics.
