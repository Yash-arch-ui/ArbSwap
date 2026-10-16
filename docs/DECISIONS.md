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
- **Decision:** Add a committed `app/.env.production` pinning
  `VITE_SOLANA_RPC_URL=https://api.devnet.solana.com` (+ fallback), so the
  production bundle contains no provider key; the local, git-ignored
  `app/.env.local` (keyed Helius URL) is left untouched for local dev.
- **Reason:** The built bundle embedded a live Helius `api-key=` (from
  `app/.env.local`, inlined by Vite because it is a `VITE_*` var). The task
  forbids any `api-key=` string in the public bundle. Vite loads
  `.env.[mode]` at higher precedence than `.env.local`, so a committed
  `.env.production` overrides the keyed local value for `vite build`.
- **Rejected:** Editing the operator's `app/.env.local` (local only, doesn't fix
  production); relying on Vercel env (unverified, could re-leak). Production
  deploy must also avoid setting a keyed `VITE_*` var (documented, Task 9.2).
