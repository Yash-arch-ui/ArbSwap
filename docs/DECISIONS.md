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
