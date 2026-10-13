# Integration gaps — `docs/INTEGRATION.md` drift + frontend↔backend wiring

Status: **analysis only (no code changed here).** Grounded in the current tree as of
S2-22. Read alongside `docs/INTEGRATION.md` (the runbook) and
`docs/FINAL_INTEGRATION_GAP_AUDIT.md`.

## 1. `INTEGRATION.md` is stale (correctness risk if followed literally)

The runbook predates S2-7…S2-22. Following it verbatim would produce wrong
transactions. Specific drift:

| INTEGRATION.md | Reality in source |
|---|---|
| §2/§6 use **tSOL/tUSDC** as the demo pair | Active app uses canonical **WSOL/USDC** (`app/src/chain/config.ts`, `ACTIVE_VAULT.canonical = true`). tSOL/tUSDC is reference-only. |
| §8 `update_quote` args include `oracle_price`, `inv_lo`, `inv_hi` | Removed in S2-9 (`vault/program/src/lib.rs`); `QuoteUpdate` has neither. |
| §7 keeper is the Rust `live` loop posting `update_quote` every 400 ms | The deployed workflow is the **staged** path: `scripts/devnet/keeper_live.ts` → Pyth push + `stage_quote` + `commit_quote` (`vault/program/src/lib.rs`). The Rust `live` `update_quote` path is legacy and no longer fits the packet limit once attribution is added. |
| §9 `swap` accounts: `…trader_quote, token_program` | Now also `keeper_reward` (init-if-needed) + `system_program` (S2-19/S2-22). |
| §9 `claim_withdraw`/`deposit` account lists | Unchanged, but the doc omits the S2-7 ATA-creation pre-instructions. |
| §2/§5 no mention of `KeeperReward`, `QuoteState.keeper`, `migrate_quote_state`, `UnattributedQuote` | All exist now (S2-19/S2-21A). |
| §2 RPC hardcoded `https://api.devnet.solana.com` | Frontend/keeper now read `VITE_SOLANA_RPC_URL` / `ARBSWAP_RPC_URL` (+ fallbacks) with a cluster guard (`app/src/chain/rpcConfig.ts`, `scripts/devnet/rpc.ts`). |
| §7.2 lists the Rust `live` positional args | The operator command is now `scripts/devnet/keeper_loop.sh` / `keeper_live.ts` with `DRY_RUN`, RPC pool, and result classification. |

**Action:** rewrite `docs/INTEGRATION.md` §7–§9 to the staged-quote ABI and the new
accounts, or add a prominent "superseded by S2-20/S2-21A" banner pointing at
`docs/S2_20_IMPLEMENTATION.md`, `docs/S2_21A_MIGRATION.md`, and the regenerated
`app/src/idl/arbswap.json`. Until then it is misleading.

## 2. What is genuinely wired (verified)

- On-chain reads via the committed Anchor IDL (`app/src/idl/arbswap.json`),
  program `2mwpYHpZ…`, canonical vault/config/quote PDAs asserted at startup
  (`app/src/chain/program.ts`).
- Write builders: `deposit`, `swap` (integer atoms, current quote version,
  `keeper_reward`), `request_withdraw`, `claim_withdraw`, `crank_epoch`,
  `trip_breaker`/`reset_breaker` (`app/src/chain/program.ts`).
- Quote state incl. status/expiry and **author** (`QuoteState.quoteKeeper`,
  rendered in `SwapPage.tsx`; never the configured operator).
- Wallet balances from the connected wallet's ATAs (`app/src/chain/solana.ts`).
- Static analytics bundle present: `app/public/artifacts/*` (10 files) consumed by
  `app/src/data/backend.ts` → `AnalyticsPage.tsx`.
- Env-driven, cluster-guarded RPC for the app and keeper tooling.

## 3. What is still missing / unwired

### 3.1 Live on-chain analytics export is not wired (concrete bug)
`simulation/analytics/export.py` says it writes `app/public/analytics/onchain.json`
and that the SPA fetches `/analytics/onchain.json` — but **`app/public/analytics/`
does not exist and no app code fetches it** (`grep onchain.json app/src` → none).
So the indexer's live on-chain bundle is dead. Decide: wire it (add a fetch in
`app/src/data/backend.ts` + an `onchain` view) or remove the misleading docstring.
`simulation/analytics/export.py:3-4,134-138`.

### 3.2 Keeper telemetry has no source
`RiskPage.tsx` must not show volatility / inventory skew / jump flag / priority
fees as live — none are stored on-chain. `docs/INTEGRATION.md` §10.6 already says
render `unavailable`; verify it actually does (and that no mock remains). A real
telemetry feed would require the keeper to publish (no hosted backend by design).

### 3.3 No frontend `claim_keeper_reward` surface
The frontend has no builder for `claim_keeper_reward` (per-keeper `KeeperReward`
PDA). Keeper reward claiming is currently operator/CLI-only. If the product wants
a keeper dashboard, add a builder + a page; otherwise document it as tooling-only.

### 3.4 `migrate_quote_state` is operator-only (intentional)
No UI surface (correct). It is exercised by `scripts/devnet/release_preflight.ts`
and documented in `docs/S2_21A_MIGRATION.md`.

### 3.5 Build-time RPC env is undocumented for deploys
`app/src/chain/rpcConfig.ts` reads `VITE_ARBSWAP_CLUSTER`, `VITE_SOLANA_RPC_URL`,
`VITE_SOLANA_RPC_FALLBACKS`. There is no committed `.env.example` and the Vite
build/deploy step does not set them, so production falls back to the public
endpoint. Add an `app/.env.example` and document the build env.

### 3.6 Historical data requires the local indexer
`simulation/analytics` writes a local SQLite DB (`simulation/analytics/out/`,
gitignored) and static dashboards; there is **no served API**. Users must rebuild
history from public on-chain data with the CLI. This is intentional
(no hosted ArbSwap service) but should be stated in the app's "how it works".

### 3.7 Two frontends in the tree
`app/` is the active client; `frontend/` is the older scaffold. Ensure deploys
build `app/` only; consider archiving `frontend/`.

### 3.8 INTEGRATION.md's smoke checklist (§14) is unmet for the new ABI
The write-path checkboxes predate staged quotes/attribution and the migration.

## 4. Prioritized remaining tasks

1. **Refresh `docs/INTEGRATION.md`** §7–§9 to the staged-quote ABI + `keeper_reward`/
   `system_program` swap accounts + the new accounts (docs only).
2. **Resolve 3.1**: wire `onchain.json` into the app or delete the export path.
3. **Add `app/.env.example`** and document the RPC build env (3.5).
4. **Verify 3.2**: RiskPage renders `unavailable` for non-on-chain telemetry.
5. **Decide 3.3**: keeper-claim UI or document tooling-only.
6. **Archive/ignore `frontend/`** (3.7).
7. Update the §14 smoke checklist for the current ABI.

## 5. Non-goals (intentional)

- No hosted ArbSwap backend/API. On-chain state is the source of truth; analytics
  and indexing stay optional/local. Frontend availability relies on Solana RPC
  (now multi-endpoint-capable) and Pyth, not on an ArbSwap-operated service.
