# DECISIONS.md — conservative decision log

Each entry: **Decision**, **Reason**, **Rejected alternative**. Kept append-only.

## Run: FINAL EXECUTION (single-sided deposit/withdraw)

### D-000 — Branch
- **Decision:** Do all work on branch `deposit-withdraw` (a copy of `volatility`).
- **Reason:** Explicit operator instruction ("WORK EXPLICITLY ON THE deposit-withdraw branch").
- **Rejected:** The prompt's "main only" rule — overridden by the operator; `main` also
  lacks the volatility/frontend work present on `deposit-withdraw`.

### D-001 — Stray untracked `json` file at repo root
- **Decision:** Leave it untouched; never use blanket `git add`; stage explicit paths only.
- **Reason:** It is unreferenced by the build and not mine to delete.
- **Rejected:** Deleting it (risk of removing operator data); adding it to `.gitignore`
  (would mask a stray artifact rather than report it).

### D-002 — Keypair paths when env vars are unset
- **Decision:** Use the documented default paths
  `~/.config/solana/id.json` (pubkey `8R3VDePS…`, admin + fee payer) and
  `~/.config/solana/arbswap-devnet.json` (pubkey `ddGs6hk5…`, upgrade authority),
  matching the public keys named in the task.
- **Reason:** `ARBSWAP_DEVNET_KEYPAIR` / `ARBSWAP_UPGRADE_KEYPAIR` / `ARBSWAP_RPC_URL`
  are UNSET, but both keyfiles exist at the documented locations with the exact expected
  public keys, so this is not a "missing key" stop condition.
- **Rejected:** Stopping as a missing-key condition (keys are present).

### D-003 — Deployed-program hash record (Task 0.2)
- **Decision:** Record the currently deployed ELF as **849,368 B, sha256 `42eeac64…`**
  (the volatility build, ProgramData slot 511445760) and note that `docs/DEVNET.md`
  still carries the older pre-volatility record (688,616 B, `9a0505…`).
- **Reason:** `docs/VOLATILITY_DEVNET_DEPLOYMENT.md` is the current deployment record and
  matches the chain; the older `DEVNET.md` line is historical and is not rewritten here.
- **Rejected:** Rewriting `DEVNET.md`'s historical STEP-1 record (history record).

### D-004 — `expiry_slots` proposal (Task 0.3)
- **Decision:** No action. On-chain `Config.expiry_slots` is **already 120**
  (proposal already applied); read-only preflight confirms `expirySlots: "120"`.
- **Reason:** Task 0.3 action applies only if the value is still 10.
- **Rejected:** Re-proposing/re-applying (forbidden parameter change; already applied).

### D-005 — Volatility pending params (`z9zy…`, `enabled=true`)
- **Decision:** Do **not** apply. Leave the pending volatility activation untouched.
- **Reason:** Applying it is a parameter change, which the task forbids; it is out of
  scope for the single-sided work.
- **Rejected:** Applying the pending volatility activation.

### D-006 — Rollback artifact (Task 0.4)
- **Decision:** Save the build whose hash equals the currently deployed program to
  `~/arbswap-rollback/arbswap_pre_single_sided.so`
  (849,368 B, sha256 `42eeac64cee3d2b9399ecd7523b7a1bf4336c8038dd10422a72117224e767ea8`).
- **Reason:** Provides the exact pre-single-sided binary for rollback if a future upgrade
  fails.
- **Rejected:** Rebuilding from an older commit (no need — the artifact in-tree is
  byte-identical to what is deployed, verified by hash).

### D-008 — Bundle-freshness gate is RED (pre-existing)
- **Decision:** Treat `scripts/check_bundle_freshness.py` (RED at Task 0) as a
  pre-existing, documented condition; defer regeneration to Task 3.6 / Task 10.1.
- **Reason:** The red is caused by frontend/volatility sources changed after the recorded
  bundle commit `1165023` (it predates this run and is not caused by Task 0's docs).
  Regenerating the bundle now, before the single-sided IDL/program work lands, would
  immediately be invalidated again and risks misattributing an uncommitted program tree
  (the exact hazard the repo's own notes warn about). The correctness gates that guard
  source behaviour (fmt/clippy/tests, docs-consistency, banned, secrets) are green.
- **Rejected:** Regenerating the artifact bundle at Task 0 (premature; will be red again
  after Task 3; the task's Task 10.1 already owns bundle regeneration).

### D-007 — Pre-existing rollback ELF naming
- **Decision:** Keep `~/arbswap-rollback/arbswap-prevolatility-780224.so` (pre-volatility,
  sha256 `dff8a302…`) in place as an additional fallback; do not overwrite it.
- **Reason:** Distinct rollback targets for two different baselines.
- **Rejected:** Replacing it (would lose the older fallback).

### D-009 — Bundle-freshness fix (supersedes D-008; done now on operator instruction)
- **Decision:** Regenerate the published bundle via the repo workflow
  (`export_artifacts.py` + `publish_artifacts.py` + `render_docs.py`) with the
  **committed** `simulation/data/results/cu.json` restored (CU **not** re-measured),
  and update the test-count references in `README.md` and `docs/CLAIMS.md` from
  211 to **260 Rust** (`docs/RESULTS.md` is rendered).
- **Reason:** The red was purely frontend sources changed after the recorded
  bundle commit; no program source changed, so re-measuring CU only injects
  host-variable medians (observed 47,836 → 50,161) and churns every doc. Keeping
  the committed CU as the source of truth keeps `check_docs_consistency` green.
  The test count legitimately rose to 260 with the volatility test suites.
- **Rejected:** Re-measuring CU (`measure_cu.sh`) — same hash but nondeterministic
  medians that break docs-consistency doc numbers; and leaving the green reversed.

### D-010 — Browser RPC must be a public endpoint (secret-leak fix)
- **Decision:** The git-ignored `app/.env.local` now pins
  `VITE_SOLANA_RPC_URL=https://api.devnet.solana.com` (+ fallback), and **no
  `.env*` file is committed**. The earlier committed `app/.env.production` was
  removed (see D-012).
- **Reason:** The built bundle embedded a live Helius `api-key=` (from
  `app/.env.local`, inlined by Vite because it is a `VITE_*` var). The task
  forbids any `api-key=` string in the public bundle. Removing the key from the
  build input is deterministic and needs no tool change.
- **Rejected:** Reliance on Vercel env alone (unverified, could re-leak).
  Production deploy must also avoid setting a keyed `VITE_*` var (Task 9.2).

### D-012 — A committed `.env.production` is rejected by the secrets gate
- **Decision:** Do not commit any `.env*` file (the secrets gate rejects all real
  `.env*` filenames, and does not content-scan them for `api-key=`). Fix the
  leak by cleaning the build input (`.env.local`) instead.
- **Reason:** `scripts/secrets_scan.py` flags any tracked `.env*` (only
  `.env.example`/`.env.sample` are allowed) and only content-scans for PEM/keypair
  arrays — so a committed public env file is both rejected by name and not
  `api-key=`-scanned. The build input fix is simpler and doesn't weaken the gate.
- **Rejected:** Allow-listing `.env.production` in the secrets gate (weakens a
  security tool); keeping the committed file (red gate).

### D-013 — CSP keeps `script-src 'unsafe-inline'` (Task 9.1 deviation)
- **Decision:** Keep `script-src 'self' 'unsafe-inline'` and
  `style-src 'self' 'unsafe-inline'`; **no `unsafe-eval`** anywhere.
- **Reason:** Browser wallet extensions (Phantom/Solflare) inject an inline
  provider script for detection; a bare `script-src 'self'` blocks that on a
  deployed origin (`app/test/vercel-headers.test.ts` pins this deliberately).
  `style-src 'unsafe-inline'` covers React inline styles. The task's "no
  unsafe-inline" therefore cannot be met without breaking wallet connect.
- **Rejected:** Removing `unsafe-inline` (breaks wallet detection); adding a
  nonce/hash pipeline (needs a custom server; Vercel static hosting can't set a
  per-request nonce).

### D-014 — Task 10.1 stale-item list does not match this repo (no churn)
- **Decision:** Do not remove `inverse-sqrt` / `InvalidInverseSqrt` /
  `verify-instead-of-compute` (they are **current** features here: the
  inverse-sqrt capacity redesign, C3/B2), and do not rewrite the historical
  `9a0505…`/`688,616`/tSOL/tUSDC records (they are dated STEP-1/earlier-vault
  history, not forward references). The current canonical numbers are consistent:
  CU `update_quote` 47,836 and `swap` 63,579. The deployed ELF is `42eeac64…`
  (849368 bytes); the current vault uses WSOL/USDC.
- **Reason:** The task's list was written for a different repo state. Removing a
  live feature or rewriting dated history would break code or falsify records, and
  risks docs-consistency.
- **Rejected:** Deleting the inverse-sqrt code/docs (breaks the program); editing
  historical deployment records (falsifies evidence).

### D-011 — Single-sided program work: NO-GO for the 2026-10-16 window
- **Decision:** Complete the design (`docs/SINGLE_SIDED_DESIGN.md`) but do **not**
  implement or deploy `deposit_single`/`claim_withdraw_single` on-chain in this
  window. Tasks 2-6 NOT DONE; design kept as the roadmap.
- **Reason:** Shipping two new on-chain instructions to the required proof
  standard (Python reference + ≥500 vectors + 100k differential + fuzz; helper
  extraction with `swap` provably byte-identical; full LiteSVM/mutation/CU/IDL
  matrix; redeploy + rollback) is not achievable within the remaining
  session/timebox, and a partially verified on-chain change is unacceptable near
  a submission deadline.
- **Rejected:** A rushed on-chain deploy (fund-safety risk); a frontend-only
  `swap`+`deposit` composition marketed as the program instruction (different
  trust surface — documented as the recommended browser-only fallback instead).

### D-015 — Operator override: implement Task 3 (single-sided program) in this window
- **Decision:** Override D-011 and implement the single-sided program
  (`deposit_single` / `claim_withdraw_single`) fully in the 2026-10-16 window:
  shared-helper extraction with `swap` unchanged, the full LiteSVM suite, CU
  measurement, IDL/fixture regeneration, docs. **No redeploy** — the program
  upgrade stays the separately gated Task 6 action.
- **Reason:** The operator instructed "DOTASK 3 FULLY" after reading the D-011
  NO-GO. The design was already complete and the work is bounded and testable
  off-chain; shipping the code and proofs without a redeploy carries no
  fund-safety risk to the live vault.
- **Rejected:** Staying NO-GO against an explicit operator directive; bundling a
  redeploy into this step (kept gated and rolled back separately).

### D-016 — Single-sided implementation deviations from the design text
- **Decision:** (1) `deposit_single` transfers the **full** `amount_in` in one
  transfer (not "only `dB`"); (2) `deposit_single` requires an existing funded
  pool (`total_shares > 0`); (3) events are named `DepositSingleEvent` /
  `WithdrawSingleEvent`; (4) no `min_version` argument (signatures kept exactly
  as the design specified).
- **Reason:** (1) The §1.1 "only `dB` is pulled" wording is a leftover error:
  pulling only `dB` would leave the fee tokens uncollected and break conservation
  of the input fee; the full transfer places `amount_in` in the reserve and the
  fee is credited to the buckets. (2) The internal conversion trades the
  committed ladder, which needs a live ladder and non-zero net reserves; there is
  no ladder on an empty pool. (3) `DepositSingle` collides (E0428) with the new
  accounts struct. (4) The operator asked to keep the design signatures.
- **Rejected:** (1) Pulling only `dB` (breaks conservation); (2) a first-deposit
  `min_liquidity` path (would need a bootstrap ladder with no committed quote);
  (3) reusing the `DepositSingle`/`WithdrawSingle` names (compile collision);
  (4) adding `min_version` (would change the designed ABI).

### D-017 — Task 4 frontend: mirror the program's integer math, gated and preview-first
- **Decision:** Wire single-sided deposit/withdraw into the app as a **pure
  integer mirror** of the deployed program (`app/src/chain/singleSided.ts`,
  golden vectors generated by the program's own unit tests), behind a
  **fail-closed** build flag `VITE_ENABLE_SINGLE_SIDED` (default off, ANDed with
  transaction availability), with a **build → simulate → preview → confirm**
  flow that re-reads the on-chain quote at submission time. The frontend never
  computes a partial fill: an infeasible single-sided plan is shown as disabled
  with the exact reason (including "Max swap depth now").
- **Reason:** The program is the only authority for the amounts; the UI must not
  predict a fill it cannot guarantee. Golden vectors taken from the program's
  `single_eval`/`solve_deposit_single` and `claim_withdraw_single` amount plan
  keep the mirror honest when either side changes. Default-off keeps the
  un-smoked path out of the demo build until Task 6.5's on-chain smoke succeeds.
- **Rejected:** Reusing the two-sided `expectedDepositShares` for a single-sided
  estimate (wrong math, would over-promise shares); enabling the flag by default
  (exposes an unverified path); a floating-point estimate (breaks integer
  parity); submitting a prepared transaction without a fresh-quote re-read
  (stale-price risk the program would reject).

### D-018 — Task 2: Python owns the cross-language golden file; Rust owns the brute-force differential
- **Decision:** The independent Python reference
  (`simulation/reference/single_sided.py`) generates a 600-case golden file
  (`vault/program/tests/single_sided_vectors.txt`; 400 deposit + 200 withdraw,
  valid integer ladders of 1–3 levels), which the on-chain crate parses
  (`include_str!`) in `single_sided_python_differential`. Separately, the Rust
  crate owns a 100,000-case brute-force differential
  (`single_sided_solver_matches_brute_force_100k`: exhaustive scan over every
  candidate `s` on a small domain) plus a 20,000-case fuzz-invariant test; the
  Python side repeats a 3,000-case brute-force differential and wide-range
  invariants. The reference mirrors the program bit-for-bit, including that an
  infeasible candidate returns `None` (Rust) / `None` (Python) so the bisection
  shrinks, and that an unfillable conversion raises `CapacityExceeded`.
- **Reason:** A single generator avoids drift between two hand-written vector
  sets, and the cross-language file is the strongest check that the two
  independent implementations agree. Brute force in the same language as the
  solver is immune to a shared reference bug and inexpensive in both builds at
  this domain. The scope note: `apply_flow_cap` and `apply_edge` are not part of
  the amount plan and remain covered by the existing swap suites.
- **Rejected:** Two separately authored vector sets (drift risk); 100k brute
  force in Python only (slower and does not exercise the Rust solver directly);
  generating vectors from the Rust solver (not independent); folding flow-cap and
  edge checks into these tests (they are instruction-level, already covered).

### D-019 — Task 6: deploy the single-sided build and scope Task 6.5 to the two-sided path
- **Decision:** The single-sided program (Task 3) is deployed to devnet: clean
  `cargo build-sbf` = 933,240 B, sha256 `c8725a23…`, upgrade signature
  `21VdJsBe…` (slot 511682809, 2026-10-16T10:36:22Z), on-chain hash MATCH, no
  rollback (previous ELF `42eeac64…`, 849,368 B, retained). Then Task 6.5's live
  smoke runs **only** the two-sided lifecycle (`deposit` → `request_withdraw` →
  `crank_epoch` → `claim_withdraw`) plus the expired-quote claim check (d);
  single-token steps (a)/(e) are marked **NOT RUN** because no single-sided CLI
  exists yet, so `VITE_ENABLE_SINGLE_SIDED` is **not** set in any build.
- **Reason:** The operator selected "Two-sided only (b,c,d)" for 6.5 to prove the
  upgrade did not regress the existing money path without taking on the cost/risk
  of a new single-token CLI in the frozen window. The upgrade is additive (no
  `Config`/`Vault`/`QuoteState` layout change, no existing instruction touched),
  so the two-sided path is the correct regression surface.
- **Rejected:** Building a single-token CLI and running (a)/(e) live in the
  freeze window (scope/time risk); leaving Task 6.5 unrun (the gate requires a
  live check); setting the single-sided flag without a passing (a) (would expose
  an unproven-on-devnet path).

### D-020 — 2026-10-17 defect-closure session: live single-sided devnet smoke passed, flag stays OFF
- **Decision:** Built `scripts/devnet/single_sided_smoke.ts` (manual Borsh, no
  IDL coder) and executed the full single-sided money path live on devnet with
  the authorized operator wallet, for **both directions**: `deposit_single`
  (base in) → warm-up → `request_withdraw` → `crank_epoch` →
  `claim_withdraw_single` (base out); and `deposit_single` (quote/USDC in) →
  ... → `claim_withdraw_single` (quote/USDC out). Every accounting check passed
  (input-only token movement, whole input to reserve, minted shares == ticket,
  `total_shares` delta == ticket shares, payout > 0, other ATA untouched, ticket
  zeroed). Signatures in `docs/DEVNET.md` STEP 4. **`VITE_ENABLE_SINGLE_SIDED`
  remains off by default.**
- **Reason:** The live CLI-signed smoke proves the deployed program's single-sided
  path, but the browser **wallet-signed** path (the actual demo path) has not been
  exercised, and the deployed frontend is a keyless build that does not set the
  flag. The release policy is fail-closed: do not expose an unverified wallet path
  for demo completeness. This matches D-017's default-off stance and the
  `docs/DEMO_RUNBOOK.md` gate.
- **Rejected:** Flipping the flag on because the CLI smoke passed (masks the
  unverified browser path); re-deploying/upgrading to "force" the feature (the
  upgrade cutoff has passed); reporting the smoke as a browser result.

### D-021 — Issue A: the two-sided claim is intentionally quote-free and pro-rata; no program change
- **Decision:** Investigated the recorded "expired quote window" (`QuoteState.
  expiry_slot 511,690,087`; observed slot 511,690,109). Determination: the
  two-sided `claim_withdraw` **deliberately** takes no `quote_state` account and
  settles `shares * (reserve - fee buckets) / total_shares` from the **live**
  reserves; `WithdrawTicket` stores only `{owner, shares, epoch}` — no fixed price
  or amount. Expiry is enforced only where a committed quote is consumed:
  `swap`, `deposit_single`, `claim_withdraw_single` (`slot < expiry_slot`). The
  observed lapse affected only quote-consuming paths (which fail closed) and is a
  **liveness** characteristic, not an exploitable stale-price claim. No source
  change (which would require a program upgrade, prohibited post-cutoff).
- **Reason:** Adding a quote/freshness check to the two-sided claim would change
  its semantics (sandwich-resistant live pro-rata settlement) without evidence of
  a defect. The correct action is regression coverage of the boundary.
- **Evidence/tests:** `deposit_single_expiry_boundary_is_exclusive`,
  `claim_withdraw_single_expiry_boundary_is_exclusive`,
  `withdraw_ticket_fixes_shares_only_and_settles_pro_rata`,
  `two_sided_claim_withdraw_still_works_with_an_expired_quote` (LiteSVM).
- **Residual risk (documented, not fixed):** the program does not re-check oracle
  age at swap, so a quote can be unexpired while its embedded Pyth price is older
  than `max_staleness_seconds`; bounded by `max_anchor_dev_bps`, the flow cap and
  the edge breaker (`docs/QA.md` Q4).

### D-022 — Issue C: ported the Vault pending-status UI fix; reconciled applied-volatility docs
- **Decision:** Ported the `volatility`/`main` fix `1e17dcd` (explicit
  `NoticeStatus = pending|success|cancelled|error`) onto this branch's superset
  `VaultPage` — converting the single-sided notice sites too, and keeping the
  "success only after the awaited submit" invariant. Reconciled the stale
  "APPLY PENDING" claims in `docs/VOLATILITY_DEVNET_DEPLOYMENT.md`,
  `docs/VOLATILITY_IMPLEMENTATION_STATUS.md`, `docs/VOLATILITY_ROLLOUT.md` to the
  applied state, after **re-verifying on-chain read-only** (2026-10-17:
  `VolatilityState.enabled = true`, nonce 190, jump active).
- **Reason:** The pending-status bug rendered a red "Request Failed" card for a
  transaction that was merely awaiting a wallet signature; the doc mismatch was a
  verified stale claim. No live config was mutated to make docs match.
- **Rejected:** Cherry-picking `1e17dcd` blindly (it targets a `VaultPage` with no
  single-sided UI); merging `main`; editing deployment docs without an on-chain
  check.

### D-023 — Issue D: freshness metric clarified (sample vs time-weighted; oracle age surfaced)
- **Decision:** Kept the historical **sample fraction** (the 87% figure) as the
  primary reported metric for backward compatibility, and added a **wall-clock
  time-weighted** fraction, the **effective sampling period**, and the **maximum
  oracle age** on fresh samples (`scripts/devnet/fresh_monitor_core.ts`, 15 unit
  checks). The monitor can fail non-zero via `MIN_FRESH`. No keeper cadence,
  economics, or on-chain parameter was changed.
- **Reason:** The 87% is arithmetically correct (2340/2689 = 0.870, 30-min window,
  `expiry_slots=120`), but it is a **sample** fraction whose sampling period
  (~669 ms, not 400 ms) is inflated by RPC latency; and "fresh" means *unexpired*,
  not *fresh oracle*. Surfacing both prevents over-claiming liveness.
- **Rejected:** Changing the decision basis to silently rewrite the historical 87%
  claim; changing keeper cadence or expiry to improve the number (market-risk).

### D-024 — Bundle regenerated at the post-fix HEAD
- **Decision:** After all source changes, regenerate the published artifact bundle
  (`scripts/measure_cu.sh` → `export_artifacts.py` → `publish_artifacts.py`) so
  `check_bundle_freshness.py` passes with the recorded commit as HEAD.
- **Reason:** The freshness gate requires no source change after the bundle's
  recorded commit. Regenerating (rather than weakening the gate) keeps the
  published numbers consistent with the committed tree.
- **Rejected:** Weakening/disabling the freshness check; leaving the bundle stale.

### D-025 — Frontend transaction reliability hardening (Vault path)
- **Decision:** Three source-only hardening changes to `VaultPage`:
  1. **Runtime Devnet genesis gate.** `blocked()` (and the single-sided preview)
     now requires `genesisVerified` from `ProtocolContext`, mirroring the swap
     gate. A custom RPC pointed at another cluster can no longer move assets
     through the vault path.
  2. **Re-simulate before signing.** `runDepositConfirm` / `handleClaimConfirm`
     refresh the blockhash and then re-run `simulateTransaction`; a prepared
     transaction that no longer simulates (state/quote moved) is discarded rather
     than submitted.
  3. **Stale-preview invalidation.** A monotonic `requestSeq` ref invalidates any
     in-flight preview build when the user changes an input or mode/side, so a
     slow async response can never overwrite newer UI state or present a preview
     for old inputs.
- **Reason:** These close the residual "correct network selection", "re-simulate
  if state changed", and "stale completions overwrite newer state" gaps listed in
  the reliability review. All are behavior-preserving on the happy path.
- **Tests:** `app/test/vault-pending-status.test.ts` (+3 source-level checks).
- **Rejected:** Blocking on the wallet adapter's network instead of the runtime
  genesis check (the adapter can be on a different endpoint); re-simulating
  without refreshing the blockhash (would simulate against a stale hash).

### D-026 — Browser wallet single-sided smoke is the sole remaining feature gate
- **Decision:** Added `docs/BROWSER_WALLET_SMOKE.md` (prerequisites, exact
  navigation, expected wallet prompts, expected on-chain effects, failure
  behavior, stop/rollback, evidence to record). `VITE_ENABLE_SINGLE_SIDED` stays
  **OFF** in the committed default until the user completes this wallet-signed
  test and the signatures are independently verified against devnet.
- **Reason:** CLI-signed devnet smoke (D-020) does not prove browser-wallet
  integration; the flag policy is fail-closed.
- **Rejected:** Enabling the flag for demo completeness; automating a wallet
  signature.

### D-027 — Corrected a stale "Devnet is not deployed" claim in HEADLINE.md
- **Decision:** `docs/HEADLINE.md` said "Devnet is not deployed; the live keeper
  transport is NOT DONE", which contradicts the verified deployment. Corrected to
  the verified state (program `2mwpYHpZ…`, ELF `c8725a23…`, live keeper via
  `keeper_live.ts`, browser wallet-signed swap operator-only).
- **Reason:** Submission claims must be accurate; the on-chain deployment and
  reproducible hash were independently re-verified this session.
- **Rejected:** Leaving the understated claim (it is still an inaccuracy).

### D-028 — Public LVR transparency shipped modeled-first, off-chain
- **Decision:** Implement the LVR transparency feature (branch `LVR`) as a
  **frontend + Python analytics + published JSON** change: a generator
  (`simulation/analytics/lvr.py`) emits `lvr_history.json` from the existing
  weekly replay, wired into the export/publish pipeline; a strict frontend parser
  (`app/src/data/lvrHistory.ts`), an Analytics panel
  (`app/src/components/LvrHistoryPanel.tsx`), and a Vault summary card
  (`app/src/components/LvrSummaryCard.tsx`) consume it. No program upgrade, no
  on-chain config, no timelock.
- **Metric honesty:** `passive_lvr_usd` and `fees_usd` are **modeled**;
  `arbswap_markout_2s_bps` is a **proxy**; `arbswap_lvr_usd` and
  `net_lp_impact_usd` are **unavailable** (`null`, never a substituted zero). A
  markout is not renamed to LVR. Missing data renders `Unavailable`.
- **Reason:** The repository has no measured ArbSwap LVR and no per-day series;
  the only defensible inputs are the modeled weekly `theory_lvr_quote` and
  turnover. Publishing fabricated daily rows or labeling markout as LVR would
  violate the honesty rules. The plan explicitly permits a modeled first release
  with explicit unavailability.
- **Rejected:** Fabricating a daily series from the headline aggregate; labeling
  markout as LVR; storing LVR on-chain (would need an upgrade + timelock);
  retaining the misleading `+$0` Vault card.
- **Deploy impact:** none on-chain; a normal Vercel rebuild plus the usual
  bundle-regen gate is all that is required.
