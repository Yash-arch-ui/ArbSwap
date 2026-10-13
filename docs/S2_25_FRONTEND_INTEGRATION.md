# S2-25 — Frontend + backend integration, QA, and demo readiness

Status: **local implementation + read-only Devnet checks. No transactions sent.**
Canonical app: **`app/`** (`frontend/` is an empty scaffold; do not extend it).

## 1. Canonical frontend and routes

`app/` (Vite + React + wallet-adapter). Routes/components: `SwapPage`,
`OverviewPage`, `VaultPage` (deposit/withdraw/claim), `RiskPage` (+ keeper rewards),
`AnalyticsPage` (+ on-chain historical panel). Chain layer in `app/src/chain/`
(IDL client, config, live decode, RPC failover), state in
`app/src/context/ProtocolContext.tsx`.

## 2. Deployed interface consistency (verified)

- Program `2mwpYHpZ…`, cluster Devnet. IDL regenerated and committed
  (`app/src/idl/arbswap.json`) — includes `QuoteState.keeper`, `KeeperReward`,
  `claim_keeper_reward`, `migrate_quote_state`, and the `swap` `keeper_reward` +
  `system_program` accounts.
- `app/test/stub-safety.test.ts` decodes **Rust-produced fixture bytes** with the
  committed IDL (`BorshCoder`) and via `fetchProtocolState`; S2-25 added an
  assertion that the appended `keeper` field decodes (897-byte layout).
- Read-only Devnet: QuoteState is on the 897-byte current layout (verified in
  S2-24; latest observed v28, author `8R3V…`).

## 3. Wallet + RPC

- **Single app-wide failover** `APP_RPC_FAILOVER`
  (`app/src/chain/rpcFailover.ts`): cluster-guarded endpoint list from
  `resolveFrontendRpc`; transport failures (`rate_limited`/`timeout`/`http`/
  `network`) retry with bounded backoff and fail over; `unknown` (program) errors
  are rethrown, never masked; `activeEndpoint` is redacted.
- **Reads AND transaction construction** now use `APP_RPC_FAILOVER.connection`
  (`ProtocolContext`, `SwapPage`, `VaultPage`, `KeeperRewards`), so blockhash
  retrieval, send, and confirmation track the active same-cluster endpoint.
  Signing is done by the wallet adapter (no connection needed).
- **Limitation (documented):** the wallet adapter's `ConnectionProvider` still
  points at the primary endpoint (`SOLANA_DEVNET_RPC`). The app's own reads/builds
  fail over; the adapter's internal calls use the primary. This does not mix
  clusters (the config layer rejects cross-cluster URLs).
- **Env:** `app/.env.example` (`VITE_ARBSWAP_CLUSTER`, `VITE_SOLANA_RPC_URL`,
  `VITE_SOLANA_RPC_FALLBACKS`) — placeholders only, no secrets (browser env is
  public).

## 4. Workflows and required accounts

| Workflow | Builder | Key accounts |
|---|---|---|
| Swap | `swap()` | trader, vault, config, quote_state, reserves, trader ATAs, `keeper_reward`, `system_program`, token_program; requires a fresh quote |
| Deposit | `deposit()` | user, vault, config, reserves, share_mint, share_lock, user ATAs, user_shares, deposit_ticket, token+system |
| Request withdraw | `requestWithdraw()` | user, vault, share_lock, deposit_ticket, user_shares, withdraw_ticket, token+system |
| Claim withdraw | `claimWithdraw()` | user, vault, reserves, share_mint, share_lock, withdraw_ticket, user ATAs, token_program |
| Crank epoch | `crankEpoch()` | vault, config |
| Keeper claim (new) | `claimKeeperReward()` | keeper, vault, `keeper_reward` (signer's own), reserves, keeper ATAs, token_program |

Swap is disabled unless the quote is fresh (`slot < expiry`), the vault is Active,
and a fresh attributed quote exists. USDC = 6 decimals, WSOL = 9.

## 5. Keeper rewards (S2-24, verified locally)

`keeperRewardPda(vault, keeper) = PDA([b"reward", vault, keeper])`;
`fetchKeeperReward` reads only the connected wallet's PDA; `claimKeeperReward`
builds the exact `claim_keeper_reward` accounts. `KeeperRewards` (on RiskPage)
shows the connected wallet's claimable base/quote, handles disconnected / no
account / zero / RPC-error / rejected-signature / pending states, and never uses
aggregate fee buckets or another keeper's entitlement. **No claim executed.**

## 6. Analytics export (S2-25)

`app/src/data/onchainAnalytics.ts` + `OnchainAnalyticsPanel` (AnalyticsPage)
optionally load `/analytics/onchain.json` (written by
`simulation/analytics/export.py`). States: loading / available (with snapshot
time, network, indexed slot) / **stale** (> 1 h) / missing / malformed / error.
Live balances, quotes, and reserves are **never** sourced from the export —
they always come from RPC. In the current deployment the file is absent, so the
panel honestly shows "unavailable (optional, historical only)".

## 7. Transaction feedback

State is derived from `ProtocolContext` + on-chain rereads; the UI distinguishes
disconnected, wrong cluster, unavailable/expired/unattributed quote, RPC failure,
and (for writes) constructed → signature requested → submitted → confirmed →
failed. Quote author is shown only when genuinely attributed (`quoteKeeper`), never
the configured operator for an unattributed legacy quote.

## 8. Commands

```bash
cd app && yarn test && yarn lint && yarn build && npx tsc -b
cd app && yarn dev            # dev server (verified: HTTP 200, app shell)
cargo test --workspace
.venv/bin/python -m pytest simulation/analytics/tests -q
```

## 9. Completed / limited

- Completed: live protocol reads; env-configured cluster-guarded RPC failover for
  app reads + tx construction; swap/deposit/withdraw/claim/crank builders; keeper
  reward read+claim UI; optional historical analytics with freshness; docs
  reconciliation; 46 frontend tests.
- Limited/blocked: no funded non-privileged independent keeper (live two-keeper
  proof pending — see `docs/S2_24_RELIABILITY_SPRINT.md`); wallet-adapter
  connection still primary-only; no hosted backend (by design).
- **Not rendered-verified in a browser:** the dev server starts and serves the
  app shell (HTTP 200) and the production build succeeds, but no headless browser
  DOM inspection was performed. This is stated honestly rather than claimed.

## 10. Local vs deployed

Local-only: RPC failover plumbing, keeper-reward UI, analytics panel, docs, tests.
Deployed (read-only observed): 897-byte QuoteState, `keeper` attribution,
permissionless `min_bond=0`. No transaction, swap, claim, migration, or deployment
was performed in this task.

---

## S2-26 follow-up

Browser render remains blocked by missing Chromium system libraries (documented in
`docs/S2_26_DEMO_READINESS.md`). Added `app/test/instruction-interface.test.ts`
(IDL account-list + reward-PDA pinning). Frontend suite now **52 tests**. Current
live quote is **expired** (v28); the app correctly shows `Expired` and disables
swaps.
