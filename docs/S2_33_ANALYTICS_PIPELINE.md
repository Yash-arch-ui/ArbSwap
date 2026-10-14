# S2-33 — Read-Only Analytics Backend, Historical On-Chain Data, and Data Integrity

Status: **complete for the read-only pipeline**. No blockchain transaction, signing,
program change, keeper quote, or configuration change was made.

## 1. Existing infrastructure discovered (not reinvented)

The repository already contained a complete, canonical analytics/indexer stack under
`simulation/analytics/`. No second database was created.

- `chain.py` — dependency-free read-only Solana JSON-RPC client (retries/backoff,
  **no signing path**).
- `events.py` — dependency-free Anchor `Program data:` decoder for the real
  program events (`SwapEvent`, `DepositEvent`, `WithdrawClaimed`, `QuoteStaged`,
  `QuoteCommitted`, `QuoteUpdated`, `RewardClaimed`, …). Field order mirrors
  `vault/program/src/lib.rs`.
- `onchain.py` — `getTransaction` → typed `TxRecord` (decodes emitted events only;
  never infers a swap from balance deltas).
- `db.py` — versioned SQLite schema (`SCHEMA_VERSION = 1`): `transactions`,
  `tx_events` (PK `(signature,event_index)`), `indexer_cursor`, `ingest_errors`,
  `reconciliations`; atomic batch ingestion + idempotent `INSERT OR IGNORE`.
- `indexer.py` — `ChainIndexer.backfill` bounded/resumable backfill.
- `export.py` — `build_bundle` / `write_bundle` → `app/public/analytics/onchain.json`.
- `onchain_accounts.py` — read-only decoding of `Vault` / `QuoteState` / `Config`
  (checksum-verified against the deployed layouts).
- `onchain_metrics.py` — metrics with explicit `source`/`status`
  (`live` / `historical` / `pending` / `unavailable`); unavailable values are
  `None`, never a placeholder.

**Why a new one was not necessary:** this is the canonical store; the S2-32 gap was
that the export file was never generated and the frontend only rendered its header.

## 2. What S2-33 changed in the pipeline

- **Cursor/resume bug fixed.** `backfill` previously called
  `iter_signatures(before=last_sig)`, which pages *older* than the cursor and would
  re-walk history and move the cursor backwards. It now pages newest-first from the
  top and stops at the persisted cursor, collecting only genuinely-new signatures.
  `db.ingest_records` now advances the cursor **monotonically** (never back).
- **Coverage + freshness.** New `db.coverage()` (first/last slot, block times,
  tx/event counts, first/last indexed-at) and `db.quote_commits()`. `build_bundle`
  gains `index_status.coverage`, `index_status.last_indexed_at`, a `freshness`
  block (`current_slot`, `quote_version`, `quote_expiry_slot`, `quote_expired`
  computed **server-side** against the export slot), and a `history` block
  (`swaps`, `deposits`, `withdrawals`, `quote_commits` + truncation, and an
  attribution note).
- **CLI.** `index`/`export`/`reconcile` now default `--rpc` to the configured
  `ARBSWAP_RPC_URL` (never printed, never a browser credential). New
  `sync` command runs a bounded `index` + `export` in one read-only pass.
  `Database` now creates its parent directory.
- **Reference run produced a real export** (`app/public/analytics/onchain.json`):
  **339 confirmed transactions → 231 events**, coverage slots **509565633–510709748**,
  1 swap, 2 deposits, 0 withdrawals, 100 quote commits (+125 truncated),
  125 failed transactions, reconciliation **MATCHED**, live snapshot v28
  (`expiry_slot 510667289`, `quote_expired: true` at slot 510734221).

## 3. Schema & synchronization design

- `transactions(signature PK, slot, block_time, err, program_id, event_count,
  success, indexed_at)`; `tx_events(signature,event_index PK, slot, block_time,
  program_id, event_type, side, quote_version, amount_in, amount_out, fee, payload,
  indexed_at)`; `indexer_cursor(program_id PK, last_signature, last_slot,
  updated_at)`; `ingest_errors`; `reconciliations`.
- **Idempotent upserts** keyed by signature and `(signature, event_index)`.
- **Atomic batches**: a coherent set of transactions + events + the cursor commit
  in one SQLite transaction; a crash mid-batch leaves the previous cursor.
- **Bounded retries + 429 handling** in `chain.SolanaRpc` (retryable 408/429/5xx
  with exponential backoff; non-retryable request errors raise immediately).
- **Recovery**: on a mid-range RPC failure the indexer records an `ingest_error`,
  stops **without** advancing the cursor, and a later run resumes exactly there.
- **Export** is written idempotently by `write_bundle` (pretty JSON, sorted keys)
  with `generated_at`, `coverage`, and `last_indexed_at`.

## 4. Coverage and gaps (honest)

- The configured RPC returned **339 signatures total** for the program, spanning
  slots 509565633–510709748. This window **includes** the historic vault init,
  first/second deposits (510320063 / 510405556 region) and the S2-15 swap
  (510407827).
- Anything earlier than slot 509565633 was **not supplied by the provider** and is
  reported as a coverage gap (`index_status.coverage.first_slot`), never as zero
  activity. The bundle carries a `limitations` list stating this explicitly.
- Public `api.devnet.solana.com` rate-limits a browser session heavily (429); the
  frontend fails honestly (`Vault not initialized` / `Quote unavailable`) rather
  than fabricating values, and the export is generated with the configured
  server-side RPC.

## 5. Every new metric: source & calculation

| Metric | Source | Calculation |
|---|---|---|
| Indexed coverage range | `transactions` table | `MIN/MAX(slot)`, `MIN/MAX(block_time)` |
| Last successful indexing | `tx_events.indexed_at` | `MAX(indexed_at)` |
| Swaps (direction/amounts/fee) | indexed `SwapEvent` | event payload, deduped by `(signature,event_index)` |
| Deposits / withdrawals | indexed `DepositEvent` / `WithdrawClaimed` | event payload |
| Quote commits | indexed `QuoteStaged`/`QuoteCommitted`/`QuoteUpdated` | version + nonce + slot (newest first, capped 100) |
| Quote freshness | live `QuoteState` + live slot | `expired = version == 0 or current_slot >= expiry_slot` |
| Failed transactions | `transactions.success = 0` | count |
| Live reserves | live RPC token accounts | `amount` u64 |
| Vault/composition | live `Vault`/`QuoteState` | decoded fields |
| Markouts / quote-age | **not indexed** | `status: pending`, `observations: []` |

Provenance labels used in the UI: **LIVE SNAPSHOT** (account reads at export time),
**INDEXED HISTORY** (confirmed chain events in the coverage window), **RESEARCH
artifacts** (offline model charts on the same page), and explicit **unavailable**.
The three are never mixed, and missing history is a labelled gap.

## 6. Expired-quote display audit and fixes

- Freshness is decided by `slot < expiry_slot` (and `version > 0`) in both
  `ProtocolContext` (`quoteAvailable`) and `chain/live.ts` (`status`), matching the
  program's `clock.slot < expiry_slot` requirement. `Unavailable` (no account /
  version 0) is distinct from `Expired`.
- **Fixes (S2-33):** the Swap page now titles the book
  **“6-LEVEL LAST-KNOWN BOOK (EXPIRED)”**, labels the mid **“Quoted mid
  (last-known)”**, the half-spread **“(last-known)”**, and the details oracle
  reference **“(last-known, expired)”**; the working-state banner already states
  the quote is expired and swaps stay disabled. The Overview hero and TVL ribbon
  now say the quote is **last-known, not executable** and the TVL is **valued at
  last-known quote (expired)**. The export itself records
  `freshness.quote_expired` server-side so the Analytics panel shows the true
  state even when the browser cannot reach RPC.
- **Confirmed:** the Swap submit stays disabled for missing/expired/stale/invalid
  quotes (read-only mode and `swapUnavailableReason`); polling cannot make an
  expired quote fresh (status is recomputed each 4 s tick against the live slot).

## 7. Frontend changes

- `app/src/data/onchainAnalytics.ts` — typed `HistorySection`, `IndexCoverage`,
  `IndexedEvent`, `freshness`, `trading`.
- `app/src/components/OnchainAnalyticsPanel.tsx` — renders provenance chips,
  coverage, last-indexed time, live quote freshness, indexed counts, a **historical
  swaps table** (time/slot/side/in/out/fee/quote version/signature link), deposits
  and withdrawals, the attribution note, and an explicit boundary statement that
  the model charts are RESEARCH, not chain history.
- `SwapPage.tsx` / `OverviewPage.tsx` — expired/last-known labelling (above).

## 8. Tests and verification (actual)

- Analytics/backend (`pytest simulation`): **227 passed, 2 skipped**; the on-chain
  suite is **16 passed**, including new S2-33 tests: cursor-resume only collects
  newer signatures, cursor never moves backwards, coverage range, quote-commits
  view, `build_bundle` history + expired/fresh/zero-version semantics, and a
  package-wide scan proving the analytics service has **no signing/send path**.
- Frontend `yarn test`: **80 passed** (9 files) incl. `s2-33-analytics.test.ts`
  (export presence + shape, provenance separation, indexed swap fields, honest
  missing-export interpretation, expired-never-fresh). `yarn lint` clean;
  `yarn build` (tsc + vite) clean.
- Browser E2E (`app/e2e/browser-smoke.mjs`, real headless Chromium over CDP):
  **exit 0**, `exceptions: []`, `consoleErrors: []`, and new checks
  `analyticsHistory: true`, `expiredQuoteLabelled: true`, plus the S2-32 read-only
  checks. The Analytics page rendered the indexed history: coverage slots
  `509565633–510709748 (339 txs, 231 events)`, 1 swap (Buy WSOL,
  `1.750000 → 0.016290`, fee `0.000175`, v18, sig `51TkKq…`), 2 deposits, 100 quote
  commits, 125 failed txs, and `QUOTE STATUS (LIVE): EXPIRED`.
- `cargo fmt --all -- --check` clean; `scripts/check_docs_consistency.py` pass;
  `scripts/secrets_scan.py` **CLEAN**.

## 9. Files changed

- `simulation/analytics/indexer.py` (cursor-resume fix)
- `simulation/analytics/db.py` (coverage, quote_commits, monotonic cursor, mkdir)
- `simulation/analytics/export.py` (coverage/freshness/history, expired compute)
- `simulation/analytics/__main__.py` (env RPC default, `sync`, `_export`)
- `simulation/analytics/tests/test_onchain.py` (7 new tests)
- `app/public/analytics/onchain.json` (generated real export)
- `app/src/data/onchainAnalytics.ts`, `app/src/components/OnchainAnalyticsPanel.tsx`
- `app/src/pages/SwapPage.tsx`, `app/src/pages/OverviewPage.tsx`
- `app/e2e/browser-smoke.mjs`, `app/test/s2-33-analytics.test.ts`
- `docs/S2_33_ANALYTICS_PIPELINE.md`, `docs/PROGRESS.md`

## 10. No transactions / no protocol changes

The analytics service is read-only: `chain.py` has no signing path (enforced by a
test that scans the package for `sendTransaction`/`signTransaction`/`Keypair`).
This task submitted **no** transaction of any kind (no swap, deposit, withdrawal,
claim, crank, keeper quote, Pyth update, mint, transfer, upgrade, or authority/
config change). No API key, private key, or credential-bearing RPC URL is exposed
to the browser (verified by test + `secrets_scan.py`).

## Remaining / future

- Serving `onchain.json` or a read-only JSON API requires an operator host; not
  claimed here. Regenerate with
  `set -a; . ./.env; set +a; python -m simulation.analytics sync`.
- Markouts/quote-age remain `pending`: no historical Pyth observations are
  indexed. Do not present model charts as realized performance.
