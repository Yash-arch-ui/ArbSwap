# S2-35 — End-to-End Swap Completion: Live Quote Freshness + Real Wallet + Devnet Swaps

Status: **code complete and locally validated; keeper liveness and frontend
fresh-quote observation demonstrated; the browser-wallet live swap is BLOCKED**
(no browser wallet extension in this headless environment). No program, IDL,
authority, config or oracle rule was changed. Nothing was pushed.

The whole effort was done on the paused working tree (a second agent had left
uncommitted S2-36 work; that work was preserved and integrated). Only the
frontend execution-mode/gating, the keeper tooling, the preflight tooling and
the docs were changed.

## Strict milestones (reported separately)

| # | Milestone | Result | Evidence |
|---|---|---|---|
| 1 | Keeper liveness (new quote under unchanged on-chain guards) | **ACHIEVED** | QuoteState advanced **v28 → v73** across bounded runs; `COMMITTED_AND_VERIFIED` commits e.g. `5HLsz3DW…` (v37), `3RdDLi5s…` (v47), `yTk9ZWPc…` (v73). Author always `8R3V…`. |
| 2 | Fresh quote observed by the frontend | **ACHIEVED** | Live browser probe: **11 / 120 samples** showed the Fresh book (`lastVersion 73`) while the keeper ran. |
| 3 | Wallet transaction path (build → sign → send → confirm) | **PARTIAL** | Frontend builder + gating implemented and unit/E2E verified; **the browser-wallet signature was not exercised** (no wallet extension; injecting a signing key into the page is prohibited). |
| 4 | Live swap verified (browser-initiated confirmed `SwapEvent`) | **NOT DEMONSTRATED** | Blocker: no browser wallet; plus the deployed 10-slot quote expiry vs free-RPC latency (below). |
| 5 | Local validation | **PASS** | §8. |

The overall task is **not** complete: milestone 4 is not verified. Every
safeguard is intact; the exact operator action is in §9.

## Phase 1 — removed the blanket read-only blockage

`app/src/chain/config.ts` now resolves an **explicit** mode:

- `APP_MODE = 'trade' | 'read-only'` from `VITE_ARBSWAP_MODE`
  (`VITE_ARBSWAP_READ_ONLY=1` is accepted as an alias). Default: **trade**.
- `TRANSACTIONS_ENABLED = !READ_ONLY_MODE && CLUSTER === 'devnet'`.
- `TRANSACTION_DISABLED_REASON` gives the concrete reason (read-only mode or a
  non-Devnet cluster). Mainnet/testnet/localnet stay transaction-disabled.

The blanket `READ_ONLY_MODE` guards were replaced by the protocol's real checks:

- `app/src/chain/gating.ts` — `swapUnavailableReason` (mode + genesis-verified +
  vault + breaker + fresh quote) and the state-aware `liveSwapGateReason`
  (transport 429/timeout ≠ absent vault; invalid account; stale; expired/aging
  quote; unverified cluster).
- `SwapPage`, `VaultPage`, `KeeperRewards` are gated by `TRANSACTIONS_ENABLED`
  and surface a specific reason; the obsolete read-only banners render only in
  the deliberate `read-only` mode. A `ModeBadge` in the navbar shows
  `trading`/`read-only`.
- A false-success defect was fixed: VaultPage previously rendered `✓` for every
  notice (including failures); notices now carry a severity and only show `✓`
  after an awaited confirmed submit. The same applies to `KeeperRewards`.
- Genesis verification is required before submission, so a custom RPC pointed at
  the wrong cluster cannot enable trading silently.

Tests: `app/test/integration.test.ts` (state-aware gate: wrong cluster, expired
quote, invalid state, RPC failure, paused) and
`app/test/s2-32-integration.test.ts` (trade-mode default, no blanket blocker on
any surface, success only after the awaited submit).

## Phase 2 — deployed protocol / canonical accounts (read-only, 2026-10-13)

`scripts/devnet/preflight.ts` (new, read-only) output:

- Cluster genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` (Devnet).
- Program `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm`, owner
  `BPFLoaderUpgradeab1e…`, upgradeable; local `target/deploy/arbswap.so`
  `769984 B` sha256 `b4df2b0f…` → **MATCH** (`scripts/devnet_program_hash.py`).
- Vault `8yvFBv9…` 306 B, `status 0 (Active)`, `total_shares 108,980,882`.
- Config `ErVDFA…` 321 B: `fee_bps 1`, `expiry_slots 10`,
  `max_staleness_seconds 2`, `max_conf_bps 10`, `min_bond 0`, keeper `8R3V…`,
  feed `ef0d8b6f…b56d`.
- QuoteState `5MsGbd…` 897 B, version advanced 28→73, author `8R3V…`.
- Reserves `313,621,726` WSOL atoms (0.313621726) / `37,750,000` USDC atoms.
- Mints: WSOL `So111…` 9 dp classic SPL; USDC `4zMM…` 6 dp classic SPL.

No mismatch: the deployed program equals the HEAD build; no key sync, no deploy.

## Phase 3 — keeper reliability (optimised, supervised)

`scripts/devnet/keeper_live.ts` was optimised **without weakening any guard**:

- Fetch the Hermes update, `getSlot` and `getLatestBlockhash` **concurrently**
  (one blockhash for the whole pipeline instead of a second fetch before the
  push) — removes RPC round trips from inside the 2 s window.
- The same signed bytes are **broadcast to every configured endpoint**
  (`scripts/devnet/broadcast.ts`, the paused agent's module, extended): proceed
  on the **first accepted send** instead of the slowest, and only trust
  confirmation from an endpoint that accepted the send. All 17 broadcast tests
  pass.
- Staging legs wait for `processed`; the push+commit leg is re-verified at
  `confirmed` via `getTransaction` before any success is reported.
- Bounded, short failure backoff (`KEEPER_BACKOFF_BASE_MS`/`_CAP_MS`, defaults
  200/1500 ms) and a shorter `getTransaction` retry, so a timing failure is
  retried inside the usable window rather than after a long delay.

`scripts/devnet/keeper_loop.sh` fix: it previously took an `rpc` argument but
**never exported it** (the driver silently used the default provider). It now
exports `ARBSWAP_RPC_URL`, `ARBSWAP_RPC_FALLBACKS` and `MAX_FETCH_AGE_MS`, and
keeps the single-instance `flock`, bounded restarts and non-zero exit after
`MAX_CONSECUTIVE_FAILURES`.

Success is never inferred from a process return: `keeper_commit.ts` requires a
confirmed, error-free transaction whose reread `QuoteState.version` strictly
advanced and whose `keeper` matches the expected signer.

## Phase 4 — liveness analysis (no protocol weakening, no redeploy)

The three-transaction staged path (stage → Wormhole VAA → push+commit) is the
deployed design. Measured with Helius + public fallback: `stage`/`vaa` confirm
~0.5–0.7 s each, `push+commit` ~0.5–0.6 s, Hermes publish-age 0.4–1.3 s. The
chain clock lags wall time by ~1 s, so the effective budget is ≈3 s wall from
publish to commit. Attempts that land inside it commit (`age_at_commit_ms` at
the 2000 ms clock boundary); attempts that start from a >1 s-old update fail
`InvalidOracle` (6015), with `StalePendingQuote` (6039) / `UpdateSlotTooOld`
(6037) when the VAA leg is slow.

Result: commits happen but **not continuously** — observed ~3–8 commits per
90 s (≈1 per 11–30 s) while the 10-slot expiry keeps a quote fresh for only
~2.4 s. A free RPC plus the 2 s oracle rule and the 3-tx pipeline cannot sustain
an always-fresh quote. The **smallest correct** fix would be a program change to
collapse push+commit into one packet (or otherwise cut a leg); that requires a
redeploy and is **out of scope** for this task (no redeploy performed, no rule
weakened). The keeper was **not** made permissive: no change to feed identity,
2 s freshness, 10 bps confidence, stage age, anchor/ladder/inventory/flow/edge
bounds, expiry or attribution.

## Phase 5 — connected-wallet transaction flow

- Signer: the connected wallet adapter is the signer; no admin/CLI/server key is
  substituted in the browser (`getProgram(connection, wallet)`; the read-only
  program uses `PublicKey.default` and never signs).
- Amounts: integer-only via `amounts.ts` + `swapMath.ts` (exact mirror of
  `arb_math::walk_ladder`); fee, expected output and `min_out` are integers.
- Gating: fresh quote, live vault, un-paused, verified cluster, balances,
  ladder capacity; missing base/quote ATAs are created idempotently as
  pre-instructions.
- Submit: `.rpc()` waits for confirmation; only then is success reported, then
  balances/quote/reserves refresh.
- `fetchFreshQuote` (new) reads the live `QuoteState` at submission time so the
  swap uses the current quote version.

## Phase 6 — real browser E2E

`app/e2e/browser-smoke.mjs` (headless Chromium over CDP, no npm browser stack):
**exit 0**, `exceptions: []`, `consoleErrors: []`, `modeBadge: true`,
`readOnlyBanner: false`, `swapHonestState: true`, `expiredQuoteLabelled: true`,
`analyticsHistory: true`. With the keeper running, a focused probe observed
`fresh: 11 / 120` samples (`lastVersion 73`).

## Phase 7 — bounded live Devnet swap

**Not submitted.** The task requires the swap to be signed by the *connected
browser wallet*. This headless environment has **no browser wallet extension**;
producing the signature would require exposing a signing key to the page, which
this task prohibits, and sending through a CLI/operator keypair would not be the
acceptance test. Per the task's rule, the run stopped before submission.

Additional (non-decisive) constraint: the deployed quote is fresh for only
~2.4 s and the keeper cannot keep it continuously fresh on the available free
RPC (§4), so a browser swap would frequently hit `QuoteExpired` even with a
wallet. No protocol check was weakened to force success. No deposit, withdrawal,
claim, transfer, mint or config change was made.

## Phase 8 — validation (actual commands, 2026-10-13)

| Check | Command | Result |
|---|---|---|
| Rust fmt | `cargo fmt --all -- --check` | clean |
| Rust clippy (CI scope) | `cargo clippy -p arb-math -p arbswap-keeper -p arb-aggregator -p arbswap -- -D warnings` | clean |
| Rust tests | `cargo test --workspace` | green (program lifecycle 100, recovery 8, oracle 3, security 3, breaker 2, fixtures 1; keeper 45; math suites) |
| Python | `.venv/bin/pytest simulation -q` | 228 passed, 2 skipped |
| Keeper TS | `tsx broadcast.test.ts` / `keeper_commit.test.ts` / `rpc.test.ts` | 17 / 9 / 24 passed |
| Frontend lint | `yarn lint` | clean |
| Frontend types | `npx tsc -b` | clean |
| Frontend tests | `yarn test` | 88 passed (9 files) |
| Frontend build | `yarn build` (public RPC, no secrets) | clean; no `api-key`/`PYTH_API_KEY`/private key in `dist/assets` |
| Browser E2E | `node app/e2e/browser-smoke.mjs` | exit 0 (see §6) |
| Secrets | `.venv/bin/python scripts/secrets_scan.py` | CLEAN |
| Docs consistency | `.venv/bin/python scripts/check_docs_consistency.py` | pass |

## Phase 9 — remaining operator action (to verify milestone 4)

1. Open `app/` in a browser with a wallet extension (Phantom/Solflare) holding
   the operator devnet key `8R3V…` (which holds ≈2.25 USDC and devnet SOL).
2. Load `.env` into the environment and run the keeper continuously:
   `set -a; . ./.env; set +a; export ARBSWAP_RPC_FALLBACKS=https://api.devnet.solana.com; scripts/devnet/keeper_loop.sh "$ARBSWAP_RPC_URL" 600`.
3. In the app (mode badge shows `trading`), BuyBase 0.5 USDC (≤0.5 % slippage).
   The quote is fresh only for ~2.4 s; submit when the Swap page shows the
   Fresh/ACTIVE book. The app re-reads the live quote at submit time.
4. Independently verify the confirmed `SwapEvent`, the token deltas and the
   vault reserves.

Do not weaken the deployed 2 s freshness or 10-slot expiry to make this easier.

## 10. Completion pass — verification, submit-time freshness, honest results

This section records a second session that re-verified the S2-35 work on the
(uncommitted) working tree, closed one code-versus-claim gap, and committed it.

### 10.1 Gap closed: submission-time fresh quote

`fetchFreshQuote` was defined but **not called** by `SwapPage`; the swap used the
*polled* `quoteState.version` and the polled `min_out`. This is now wired:

- `app/src/chain/program.ts` — `fetchFreshQuote` returns the live `version`,
  `expirySlot`, `currentSlot`, `fresh`, `keeper` **and the raw ask/bid ladders**.
- `app/src/chain/gating.ts` — new pure `submitFreshnessReason` mirrors the
  deployed `swap` preconditions (`version > 0` attributed; `current_slot <
  expiry_slot`).
- `app/src/pages/SwapPage.tsx` — `handleSwap` re-reads the live quote first,
  rebuilds the integer ladder plan from the *current* committed levels, derives
  `min_out` from it, submits against the live `version`, and refuses on
  expiry/capacity without submitting.
- Tests: `app/test/integration.test.ts` (+4) cover the freshness gate.

### 10.2 Live Devnet evidence (this session)

- **Deployment unchanged / matches.** `scripts/devnet_program_hash.py`: on-chain
  ELF `769984 bytes sha256=b4df2b0f…` == `target/deploy/arbswap.so` → **MATCH**;
  no redeploy, no `anchor keys sync`.
- **Keeper liveness.** Bounded `keeper_live.ts` runs (Helius primary + public
  fallback) advanced `QuoteState` **v77 → v93** with `COMMITTED_AND_VERIFIED`
  commits — e.g. v78 `3bWpwRgW…`, v83 `4WRFsycc…`, v87 `t7zFNogq…`, v92
  `4NcFkqY8…` — author `8R3V…`. Latency failures were `6015` InvalidOracle (×3)
  and `6037` UpdateSlotTooOld (×1). No guard was weakened.
- **Fresh-quote observation (honest).** With the keeper running, a focused
  browser probe this run observed **0 / 85** fresh samples. Inspection of the
  keeper log shows why: several commits were already past `expiry_slot` at
  confirmation (`confirmed … but the quote is already expired`). The 3-tx
  stage→VAA→push+commit pipeline cannot reliably beat the deployed 2 s oracle
  rule on the available infrastructure. The app rendered the expired book
  honestly; it did not offer a stale fill.

### 10.3 Milestone status (this session)

| # | Milestone | Result |
|---|---|---|
| 1 | Keeper liveness (new quote under unchanged guards) | **ACHIEVED** (v77→93) |
| 2 | Fresh quote observed by frontend | **NOT robustly achieved** (0/85 this run; window too tight) |
| 3 | Wallet transaction path | PARTIAL (builders + submit-time gate verified; browser signature not exercised) |
| 4 | Live swap verified | **NOT DEMONSTRATED** (no browser wallet; near-certain `QuoteExpired` even with one) |
| 5 | Local validation | **PASS** (§10.4) |

### 10.4 Validation (actual commands, this session)

| Check | Result |
|---|---|
| `cargo fmt --all -- --check` | clean |
| `cargo clippy -p arb-math -p arbswap-keeper -p arb-aggregator -p arbswap -- -D warnings` | clean |
| `cargo test --workspace` | green (lifecycle 100, recovery 8, oracle 3, security 3, breaker 2, fixtures 1, keeper 45, math/aggregator) |
| `.venv/bin/pytest simulation -q` | 228 passed, 2 skipped |
| keeper TS (`broadcast`/`keeper_commit`/`rpc`) | 17 / 9 / 24 passed |
| app `yarn lint` / `npx tsc -b` | clean |
| app `yarn test` | 92 passed (9 files) |
| app `yarn build` (public RPC) | clean; no `helius`/`api-key` string in `dist` |
| browser E2E `node app/e2e/browser-smoke.mjs` | exit 0 |
| `scripts/secrets_scan.py` | CLEAN |
| `scripts/check_docs_consistency.py` | pass |

### 10.5 Remaining operator action

Unchanged from §9 for milestone 4; additionally, sustaining a continuously-fresh
quote on Devnet would require the smallest correct architecture change called out
in §4 (collapse push+commit into one packet) and a redeploy — **not performed**.

## Boundary

No program deploy/upgrade, no `anchor keys sync`, no authority/config/oracle
change, no mint/deposit/withdraw/claim/transfer, no swap, no push. Secrets never
printed; the Helius endpoint is redacted in every log and absent from the
browser bundle when built without the operator's local `.env.local`.
