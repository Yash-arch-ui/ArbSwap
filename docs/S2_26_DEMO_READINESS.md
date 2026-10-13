# S2-26 — Demo readiness (final integration + QA)

Status: **local implementation + read-only Devnet verification. No transaction sent.**

## 1. Canonical frontend, routes, commands

- **Canonical app:** `app/` (Vite + React + wallet-adapter). `frontend/` is an
  empty scaffold (no `src/`) — ignore it.
- **Tabs (client-side state, no URL router):** Overview, Swap, Vault
  (deposit / request-withdraw / claim), Risk (+ keeper rewards), Analytics
  (+ optional on-chain historical panel). `app/src/App.tsx`.
- **Commands:**
  ```bash
  cd app && yarn install && yarn dev     # dev server (http://localhost:5173)
  cd app && yarn test && yarn lint && yarn build
  cargo test --workspace
  .venv/bin/python -m pytest simulation/analytics/tests -q
  ```

## 2. Current confirmed Devnet state (read-only, this session)

| Item | Value |
|---|---|
| Program | `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` |
| Deployed ELF vs local artifact | **MATCH** — sha256 `b4df2b0f93735c7532871769ec713e92179f6375252a5bad7d8fea9c989f7096`, 769984 B |
| Upgrade authority | `ddGs6hk5E4oPzSnwFfX4pD4DDhDTLTwRddv1VQym7bH` |
| Vault | `8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt`, status **Active** |
| Config | `ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT`, `min_bond = 0` (permissionless) |
| QuoteState | `5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG`, **897 B current layout** |
| Latest quote | **v28**, author `8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH`, expiry 510667289, `unattributed: false` |
| Fresh? | **Expired** at read slot ~510674151 (no keeper running). The app shows `Expired`; swaps disabled. |

> The frontend does **not** have a fresh live quote right now. A fresh quote
> requires an authorized keeper run (not part of this task).

## 3. Chronology (historical evidence preserved elsewhere)

1. Early demo used a custom **tSOL/tUSDC** vault; the public app now reads the
   canonical **WSOL/USDC** vault.
2. **Pyth entitlement blocker** (403) → later unblocked with the current key.
3. **Packet-size blocker** on direct `update_quote` → **staged quotes**
   (`stage_quote` + Pyth push + `commit_quote`).
4. Keeper **allowlist** (`min_bond=0` → `config.keeper`) → **permissionless**
   (any signer / any bonded keeper); eligibility made immutable.
5. `QuoteState` gained `keeper` attribution; migrated **865 → 897** on Devnet.
6. Program upgraded to the current artifact (hash MATCH) and a fresh quote (v19)
   was committed; subsequent maintenance reached v28.

Do not treat any single historical state as current. Full history:
`docs/PROGRESS.md`, `docs/DEVNET.md`, `docs/DECENTRALIZATION_AUDIT.md`.

## 4. Browser / rendered verification — **blocked (documented honestly)**

The task asks for real rendered-DOM inspection. In this environment:
- No `playwright`/`puppeteer` package is installed and `npx playwright` could not
  fetch (network hang).
- The cached Chromium under `~/.cache/ms-playwright/*` **fails to launch**:
  `error while loading shared libraries: libnspr4.so` (system NSS/NSPR libs
  absent; installing them needs root/apt).
- Therefore **no screenshot and no headless DOM inspection** were performed.

What *was* verified: `yarn dev` serves **HTTP 200** with the app shell
(`<title>ArbSwap | Active Liquidity AMM + propAMM Hybrid on Solana</title>`,
`id="root"`), and the production build succeeds. Per the task, this is **not**
claimed as visual/interaction verification.

**Exact blocker / remediation:** install the Chromium system dependencies
(`libnspr4`, `libnss3`, …) or `npm i -D playwright` with browsers, then run a
Playwright script that clicks each nav tab and screenshots it.

## 5. Completed workflows + builder verification

On-chain reads: vault status/reserves/shares, quote version/author/expiry/price,
connected-wallet WSOL/USDC balances, share balance, deposit/withdraw tickets,
keeper reward.

Transaction builders (verified against the committed IDL by
`app/test/instruction-interface.test.ts` + `integration.test.ts`):

| Instruction | Accounts verified |
|---|---|
| `swap` | trader, vault, config, quote_state, base/quote reserve, trader ATAs, **keeper_reward**, **system_program**, token |
| `deposit` | user, vault, config, reserves, mints, user ATAs, user_shares, deposit_ticket, token, system |
| `request_withdraw` | user, vault, share_lock, deposit_ticket, user_shares, withdraw_ticket, token, system |
| `claim_withdraw` | user, vault, reserves, mints, share_lock, withdraw_ticket, user ATAs, token |
| `crank_epoch` | vault, config |
| `claim_keeper_reward` | keeper, vault, **keeper_reward (own PDA)**, reserves, keeper ATAs, token |
| `migrate_quote_state` | present for operators only (not user-facing) |

`keeperRewardPda = PDA([b"reward", vault, keeper])` is asserted. No builder calls
`sendTransaction`/broadcast in tests.

## 6. Analytics / provenance

- `app/public/artifacts/*` (10 static files) → `app/src/data/backend.ts` →
  `AnalyticsPage` (labeled model/replay, not live).
- Optional `/analytics/onchain.json` → `app/src/data/onchainAnalytics.ts` +
  `OnchainAnalyticsPanel`: **available / stale (>1 h) / missing / malformed /
  error**, with snapshot time + indexed slot. Currently **missing** in this
  deployment → the panel shows "unavailable (optional, historical only)".
- Live balances/quotes/reserves are **never** sourced from analytics.
- No fabricated keeper uptime, volatility, inventory, PnL, or markouts.

## 7. Test / lint / type-check / build results (this session)

- `cargo fmt --all --check`: clean. `cargo test --workspace`: green.
- `yarn test`: **52 passed** (6 files). `yarn lint`: clean. `yarn build`
  (tsc + vite): clean.
- Keeper TS: `rpc.test` OK, `keeper_commit.test` OK, `tsc --noEmit` clean.
- Analytics `pytest`: **34 passed**.
- Docs-consistency: pass. Secrets scan: **CLEAN**.
- IDL/layout: `stub-safety.test.ts` decodes Rust-produced fixture bytes (incl. the
  appended `keeper`) with the committed IDL.

## 8. Remaining limitations

- **No browser render** in this environment (system libs / tooling).
- No funded non-privileged independent keeper wallet (live two-keeper proof).
- Wallet-adapter `ConnectionProvider` remains primary-endpoint bound; app reads
  and tx construction use the failover pool.
- Public Devnet RPC latency vs the 2 s freshness window.
- Current quote expired; a fresh quote needs an authorized keeper run.
- Single-key upgrade authority and discretionary slashing remain centralized.

## 9. Reproduction steps for another developer

1. `cd app && yarn install && yarn dev`; open `http://localhost:5173`.
2. Read the live account with `cd scripts/devnet && npx tsx keeper_inspect.ts`
   (read-only) to confirm quote version/expiry/author and vault status.
3. `yarn test`, `yarn lint`, `yarn build`; `cargo test --workspace`.
4. To see a fresh quote: run the authorized keeper (`keeper_live.ts`, bounded);
   never submit swaps in a read-only session.
5. Set `VITE_SOLANA_RPC_URL`/`VITE_SOLANA_RPC_FALLBACKS` (see `app/.env.example`)
   for provider redundancy.

No deployment, migration, swap, deposit, withdrawal, claim, transfer, keeper
transaction, or GitHub push was performed in this task.
