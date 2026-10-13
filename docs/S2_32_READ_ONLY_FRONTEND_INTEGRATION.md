# S2-32 — Read-Only Frontend ↔ Backend Integration

Status: **complete for the read-only gate**. No blockchain transactions were sent.
The active frontend (`app/`) is connected to the real data sources that exist in
this repository. Missing sources fail honestly (an explicit `Unavailable` / `Not
indexed` / `n/a` state); no fabricated zero or placeholder is shown in a
production data path.

## 1. The real data sources (verified)

| Source | What it is | Browser-reachable? | Used by |
|---|---|---|---|
| Solana Devnet RPC | `Vault`, `Config`, `QuoteState`, reserves, share mint, token accounts, deposit/withdraw tickets, per-keeper `KeeperReward` | yes (wallet adapter `Connection` + `APP_RPC_FAILOVER`) | every live page |
| `app/public/artifacts/*.json` | published model/calibration bundle (`headline`, `held_out`, `routed_world`, `thesis`, `cu`, `mutation`, `test_counts`, `envelope`, `e8_proxy`, `manifest`) | yes (Vite static root → `/artifacts/*.json`) | Analytics, Overview |
| `app/public/analytics/onchain.json` | optional historical on-chain export (`simulation/analytics/export.py`) | **file does not exist in this tree** | Analytics → honest `missing` |
| SQLite indexer (`simulation/analytics/{db,store}.py`) | local, server-side event store | **no** (browser cannot reach it; no HTTP API exists) | — |
| HTTP analytics API | **does not exist** (documented decision, `docs/DATA_SCHEMA.md` B9c) | **no** | — |

No new endpoint, service, address or credential was invented.

## 2. Centralized read-only data layer

- `app/src/chain/config.ts` — canonical program id / cluster / mints / vault /
  config / quote addresses / Pyth feed; `READ_ONLY_MODE` (default on);
  `EXPECTED_GENESIS_HASH`.
- `app/src/chain/program.ts` — IDL-based decoding (**no hardcoded byte
  offsets**), PDA derivation, and **`verifyCluster`** (genesis hash) +
  **`verifyProgram`** (executable account owned by the upgradeable BPF loader).
- `app/src/chain/live.ts` — typed mappers from chain accounts to UI shapes;
  real on-chain `epochSlotsRemaining`; explicit `Unavailable` vs `Expired`
  quote states; keeper attribution only when genuinely on-chain.
- `app/src/context/ProtocolContext.tsx` — the single fetch/refresh layer:
  bounded 4 s polling, RPC failover, `liveError`, `lastUpdatedAt`, block time,
  `genesisVerified`, `programVerified`, `protocolParams`, wallet atom balances,
  and a **monotonic request-sequence guard** so a slow stale refresh can never
  overwrite newer wallet/account state.
- `app/src/data/backend.ts` — artifact reader + `deriveModelMetrics` (real
  per-window markout means, CU medians, CU ratio, no-propAMM share, thesis
  decision); `null` when absent.
- `app/src/data/onchainAnalytics.ts` — optional export reader; distinguishes
  `loading / available(+stale) / missing / malformed / error`.

## 3. Page-by-page integration matrix

| Page | Field group | Source | Status |
|---|---|---|---|
| **Overview** | Slot, quote version, vault TVL/reserves | live RPC | **connected + verified** |
| | 2s markout, passive markout, CU/update, CU ratio | artifact (`held_out`, `headline`) labelled **model** | **connected + verified** |
| | Quote-vs-fill gap | no live fills | **unavailable (honest)** |
| | LVR-reduction %, "cheaper ×", 16,938 CU, +0.38/-0.23 bps | removed (were hardcoded) | **fixed** |
| **Swap** (read-only) | Depth ladder, Pyth mid, half-spread, reservation price, version/author/expiry/freshness | live `QuoteState` | **connected + verified** |
| | Indicative output + `min_out` | integer `walk_ladder` mirror of `arb_math` | **connected + verified** |
| | Wallet balances | live token accounts | **connected (+"connect wallet")** |
| | Submit | disabled (`Read-only mode`) | **read-only** |
| | Fee bps, expiry slots | live `Config` | **connected** |
| **Vault** (read-only) | TVL, reserves, epoch, inventory skew, insurance/keeper buckets, share balance, tickets, redemption PDA | live RPC | **connected + verified** |
| | Deposit / withdraw / claim | disabled (`Read-only mode`) | **read-only** |
| | Hedged alpha, 7-day LVR avoided | no indexer | **unavailable (honest)** |
| **Risk / Keeper** | Vault status, quote staleness, confidence vs limit, breaker state, keeper eligibility, reward PDA | live RPC | **connected + verified** |
| | Bounds (anchor step, spread clamp, inventory cap, expiry, warm-up) | live `Config` | **connected** |
| | EWMA vol, jump flag, keeper uptime, mean CU/fees | keeper-local / not indexed | **unavailable (honest)** |
| | Breaker actions / params / reward claim | disabled (admin-only + read-only) | **read-only** |
| **Analytics** | 2s markout cards + per-window bar chart, routed volume share, CU matrix row | artifact (`held_out`, `routed_world`, `headline.e1_e4`) labelled **model** | **connected + verified** |
| | On-chain historical export | `/analytics/onchain.json` absent | **unavailable (honest)** |
| | Quote-vs-fill, quiet-flow half-spread, LVR series | no indexed trades | **unavailable (honest)** |

## 4. Mocks / placeholders removed from production paths

- `OverviewPage`: removed hardcoded `+0.38 bps`, `-0.23 bps`, `0.00 bps`,
  `~620 CU`, `16,938 CU`, `27.3×`, `±48 bps`, `s_max = 100`, `s_min = 2`,
  `86% LVR reduction`; now driven by `useModelMetrics()` (labelled **model,
  W2–W6**) or shown `Unavailable`. `150-slot` warm-up now reads `Config`.
- `AnalyticsPage`: the fake markout curve/legend (`+0.38`/`-0.23`) is replaced by
  a **data-driven per-window bar chart** from `headline.e1_e4`; CU matrix row now
  reads the real `cu_update_quote` median.
- `RiskPage`: hardcoded `0.10% bound`, `Limit: 50 bps`, `Min 0.5/Max 50`,
  `OK (1.8 bps)`, `OK (|q|=0.012)`, `Grace 2/Expiry 10`, `Jump Flag 0`, and the
  `Online`/`Calm Regime` badges are replaced by live `Config` values / honest
  `Not indexed (keeper-local)` states.
- `VaultPage`: fabricated `+0% (Hedged Alpha)` and `+$0 (LVR Avoided)` replaced
  with `Unavailable` + reason; epoch countdown is real.
- `Navbar`: cluster label from `CLUSTER`; adds a `verified`/`unverified`
  genesis+program indicator.
- Zero-filled chain fields that are **not** on-chain (`feeApy`,
  `netHedgedApy`, `lvrAvoided7d`, EWMA vol, jump flag) are never rendered as a
  genuine zero — the pages show `Unavailable`.

## 5. Read-only enforcement

`READ_ONLY_MODE = true` (default; `VITE_ARBSWAP_READ_ONLY=0` only for a future
approved build). Every action surface is disabled and labelled:

- Swap CTA → `Read-only mode`, disabled; `handleSwap` early-returns.
- Vault deposit / withdraw / claim → `Read-only mode`, disabled; handlers
  early-return.
- `KeeperRewards` claim → `Read-only mode`, disabled.
- A `ReadOnlyBanner` (`data-testid="read-only-banner"`) is rendered on Swap,
  Vault, Risk and Analytics with a plain-English explanation.

No page or component calls `sendTransaction`, `sendRawTransaction`, or `.rpc()`.
All transaction builders live in `chain/program.ts` and are unreachable in this
build.

## 6. Test & verification results (actual)

- `yarn test` — **73 passed / 0 failed** (8 files), including:
  - `test/swapMathLadder.test.ts` — browser `walk_ladder` matches
    `arb_math::walk_ladder` on pinned Rust vectors (ladders 1 & 3, ask+bid).
  - `test/s2-32-integration.test.ts` — model-metric derivation from real
    artifacts (and `null` when absent), honest export interpretation, real
    epoch countdown + live risk-limit mapping, read-only invariants (no
    submit APIs in pages, every surface gated by `READ_ONLY_MODE`), no secrets
    in `dist/assets`, and cluster/program verification fail-safe behaviour.
  - `test/instruction-interface.test.ts`, `test/integration.test.ts`,
    `test/stub-safety.test.ts` — IDL account lists, canonical PDA derivation,
    fixture decoding.
- `yarn lint` (oxlint) — clean. `yarn build` (tsc + vite) — clean.
- Browser E2E (`app/e2e/browser-smoke.mjs`, real headless Chromium over CDP):
  **exit 0**, `exceptions: []`, `consoleErrors: []` (328 public-RPC 429 retry
  notices classified as transport noise), `readOnlyBanner: true`,
  `swapReadOnly: true`, `modelLabelled: true`, `noFabricatedMarkout: true`.
  Rendered live values (desktop + 390×844): Slot `510727809`, quote `v28`,
  `verified` badge; real ladder asks/bids (~$107.43–$107.58), Pyth mid $107.50,
  half-spread 5.00 bps, author `8R3V…CQSH`; Vault TVL `$71.465` = `0.314 SOL +
  $37.75 USDC`, epoch 0; Risk staleness `14453s` (v28 expired), conf `3 / 10`
  bps; Analytics model markout `5.42 bps` vs passive `0.19 bps`, routed `0.03%`.
- Backend (unchanged by this task): `cargo fmt --all -- --check` clean;
  `scripts/secrets_scan.py` → `CLEAN`.

The public Devnet RPC rate-limits an automated browser session heavily (429);
when exhausted the app renders honest `Unavailable` / `Vault not initialized`
states rather than fabricating data. The values above were captured on a fresh,
un-rate-limited page load.

## 7. Missing backend data sources (reported, not invented)

1. **No browser-reachable analytics HTTP API / no served SQLite.** The indexer
   (`simulation/analytics`) is local-only. The smallest read-only contract that
   would connect historical fills/metrics to the browser is a static export at
   `/analytics/onchain.json` (already produced by
   `python -m simulation.analytics export --out app/public/analytics/onchain.json`)
   — it is simply not generated/served in this deployment, so the panel shows
   `missing`. A hosted JSON API is a documented non-goal.
2. **No on-chain-indexed volatility / jump flag / keeper-uptime / fill
   metrics.** These are keeper-local or require an indexer; shown
   `Not indexed` / `Unavailable`.

## 8. No transactions were sent

This task performed **no** blockchain writes: no swap, deposit, withdrawal,
claim, crank, keeper quote, Pyth update, mint, transfer, program upgrade,
authority or configuration change. All wallet actions are disabled and
early-return under `READ_ONLY_MODE`. Private keys, RPC credentials and
`PYTH_API_KEY` are server-side only and absent from the browser bundle (verified
by test and `scripts/secrets_scan.py`).

## 9. Remaining work for transaction-enabled integration

- Set `VITE_ARBSWAP_READ_ONLY=0` behind an explicit approval, flip the disabled
  flags, and re-enable handlers (already implemented and manually verified).
- Generate and serve `/analytics/onchain.json` (or deploy the read-only API) to
  light up the historical/indexed Analytics panels.
- Populate the optional indexed metrics (quote-vs-fill, quiet-flow half-spread,
  LVR series, keeper uptime) from the indexer once a serving path exists.
- Provide a lower-latency RPC for live quote freshness (separate S2-31 finding;
  not a frontend issue).
