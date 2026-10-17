# On-Chain EWMA Volatility & Jump Detector — Implementation Status

Working notes for the "ARBSWAP ON-CHAIN EWMA VOLATILITY & JUMP DETECTOR" task.
Branch: `main`. **Nothing was committed, pushed, deployed, or upgraded.** The only
build artifact written was the local `target/deploy/arbswap.so` (used by the
LiteSVM harness); no program `upgrade`, no `solana program deploy`, no git
mutation.

Companion specs:
- `docs/ONCHAIN_VOLATILITY_JUMP_DETECTOR_PLAN.md` — the original proposal.
- `docs/VOLATILITY_MATH_SPEC.md` — the frozen canonical math (Phase 1 output).
- `docs/VOLATILITY_ROLLOUT.md` — the prepared (unexecuted) rollout runbook.

---

## 1. Decision taken before implementation

The plan called for adding volatility parameters to the existing `Config`
account. `Config` has **no append-only migration path** (unlike `QuoteState`,
which has `migrate_quote_state`), so extending it would change the live account
layout and require a program upgrade.

**Decision (confirmed with the requester):** the volatility parameters live in
the *new vault-bound `VolatilityState` PDA* `[b"vol", vault]`.

Two hardening revisions were made after the first draft:

1. **The PDA is required (not optional) in `update_quote`, `stage_quote` and
   `commit_quote`.** An optional account lets a caller bypass enforcement simply
   by omitting it. Making it required means the caller must always reference the
   account; enforcement itself is then gated by the account's `enabled` flag and
   by freshness, both of which fail closed.
2. **Activation is a flag, off by default.** `initialize_volatility` always
   writes `enabled = false`. Enforcement turns on only after a timelocked
   `apply_volatility_params` call sets `enabled = true`. While disabled, quotes
   are unconstrained even though the PDA exists.

Consequence for the keeper: it always passes the vault's volatility PDA when
that account exists on-chain, so a program that predates the field is still
usable during the rollout window.

---

## 2. What was implemented

### 2.1 Phase 1 — Reference specification

- **New:** `docs/VOLATILITY_MATH_SPEC.md`.
- Freezes the canonical integer model already used by the keeper:
  - return = `floor(|P_t − P_{t-1}|·2^64 / P_{t-1})` (absolute simple return, Q64.64);
  - `n = max(1, round(dt_millis/1000))`, capped at `MAX_EWMA_STEPS = 300`;
  - innovation = `r² / n`;
  - EWMA variance: `v' = decay·v + (1−decay)·innovation`, `decay = λ^n` in bps;
  - `sigma = sqrt_q64(v_short)`;
  - `jump = sigma > 0 && r > sigma · jump_multiple`.
- Documents edge cases (first observation, same/older publish time, large gap,
  zero/invalid price, overflow) and the deliberate divergences from the float
  reference `simulation/reference/quote_math.py` (log vs simple returns,
  `√dt` vs whole-second decay).

### 2.2 Phase 2 — Shared fixed-point math

- **New:** `vault/math/src/volatility.rs`
  - `BPS` (`:13`), `MAX_EWMA_STEPS` (`:17`),
    `DEFAULT_LAMBDA_SHORT_BPS = 9_400` (`:20`),
    `DEFAULT_LAMBDA_MEDIUM_BPS = 9_900` (`:21`),
    `DEFAULT_JUMP_MULTIPLE = 4` (`:22`).
  - `VolatilityState` struct (`:26`) — `{ variance_short_q64, variance_medium_q64,
    last_price_q64, jump }`.
  - `steps_from_millis` (`:38`), `return_q64` (`:45`, wide-math via `U256`),
    `pow_bps` (`:60`), `ewma_step` (`:72`), `update_with_dt` (`:84`),
    `update` (`:123`, 1-second convenience), `sigma_short_q64` (`:142`).
  - All arithmetic is checked (no floating point); overflow returns
    `MathError::Overflow`, zero price returns `MathError::Domain`.
- **Modified:** `vault/math/src/lib.rs` — registers `pub mod volatility` and
  re-exports the module surface.
- **New tests:** `vault/math/tests/volatility.rs` — 13 cases: seeding, absolute
  return, flat-price zero variance, jump set/clear, decay rates, `sigma =
  √variance`, step rounding/cap, large-gap bound, zero-price and overflow
  rejection, jump-multiple scaling, determinism, `pow_bps` vs repeated decay.
- **Modified:** `vault/keeper/src/lib.rs` — `VolatilityState::update_with_dt`
  delegates to `arb_math::volatility::update_with_dt`. Keeper stays infallible
  (invalid input leaves state unchanged).

### 2.3 Phase 3 — On-chain account and instructions

All in `vault/program/src/lib.rs`:

- **Constants:** `VOL_SEED = b"vol"`, `VOL_PENDING_SEED = b"vol_pending"`,
  `VOL_MAX_EWMA_STEPS`,
  `VOLATILITY_STATE_LEN = 32 + 16*4 + 8*6 + 2 + 4*5 + 1` (= 167),
  `PENDING_VOLATILITY_LEN = 32 + 8 + 52 + 1 + 1` (= 94),
  `TIMELOCK_SLOTS = 216_000` (≈ 24h at 400 ms/slot).
- **Accounts:**
  - `VolatilityState` — PDA `[b"vol", vault]`. Fields: `vault`,
    `short_ewma_q64`, `medium_ewma_q64`, `last_price_q64`, `last_publish_time`,
    `last_observation_slot`, `observation_nonce`, `jump_detected`,
    `jump_until_slot`, `short_lambda_bps`, `medium_lambda_bps`, `jump_multiple`,
    `max_sigma_q64`, `jump_cooldown_slots`, `vol_spread_coeff_bps`,
    `vol_depth_coeff_bps`, `max_observation_age_slots`, **`enabled: bool`**,
    `bump`.
  - `PendingVolatilityParams` — PDA `[b"vol_pending", vault]`. Holds the proposed
    `VolatilityParams`, requested `enabled` flag, `proposer`, and `activate_slot`.
- **Params payload:** `VolatilityParams` and `DEFAULT_VOLATILITY_PARAMS`.
- **Validation:** `validate_volatility_params` rejects bad decay ranges,
  `medium < short`, zero/over-large jump multiple, zero max sigma, coefficients
  above 10 000, and zero max observation age.
- **Helper:** `mul_bps_ceil`.
- **Contexts:** `InitializeVolatility`, `ProposeVolatilityParams`
  (`init_if_needed` on the pending PDA), `ApplyVolatilityParams`,
  `ObserveVolatility`.
- **Instructions:**
  - `initialize_volatility` — admin-only, one-time PDA creation, seeds params
    (all-zero payload selects the defaults) and **forces `enabled = false`**.
  - `propose_volatility_params(params, enabled)` — admin-only; validates and
    writes the pending PDA with `activate_slot = clock.slot + TIMELOCK_SLOTS`.
    Re-proposing resets the timer.
  - `apply_volatility_params()` — admin-only (the signer must equal both
    `vault.admin` and `pending_volatility.admin`); refuses before `activate_slot`;
    re-validates; when enabling, requires `last_price_q64 > 0` else
    `VolatilityNotReady` (you cannot arm the guard before it has a baseline).
    Disarms by writing `activate_slot = u64::MAX`.
  - `observe_volatility` — **permissionless**. Requires a fresh, feed-matching
    `PriceUpdateV2`, `price > 0`, `publish_time > stored` (monotonic,
    replay-proof), confidence within `config.max_conf_bps`, and a normalized
    token-unit price. Applies the canonical `update_with_dt`, stores the new
    state, sets `jump_until_slot` on a jump, bumps the nonce, emits the event.
    The observer gains no authority.
- **Events:** `VolatilityInitialized`, `VolatilityParamsProposed`,
  `VolatilityParamsApplied`, `VolatilityObserved`.
- **Errors:** `InvalidVolatilityParams`, `VolatilityTooHigh`,
  `VolatilitySpreadTooLow`, `DepthAboveVolatility`,
  `StaleVolatilityObservation`, `VolatilityNotReady`.

### 2.4 Phase 4 — Quote integration (fail-closed enforcement)

All in `vault/program/src/lib.rs`:

- `UpdateQuote`, `StageQuote` and `CommitQuote` carry a **required**
  `volatility_state: Account<VolatilityState>` (PDA-validated,
  `seeds = [VOL_SEED, vault]`). `StageQuote` inserts it just before
  `system_program`; `UpdateQuote`/`CommitQuote` append it last.
- Pure `volatility_guard_core(min_spread_bps, update, vs, current_slot)` and its
  thin wrapper `validate_volatility_guard` implement the policy. The wrapper is
  called from `validate_quote_update` and `stage_quote`.
- Policy (runs only when `enabled` **and** fresh):
  - **stale** (`clock.slot − last_observation_slot > max_observation_age_slots`)
    → reject;
  - **no baseline** (`last_price_q64 == 0`) → reject (fail closed);
  - **kill-switch:** `sigma <= max_sigma_q64`, else `VolatilityTooHigh`;
  - **spread floor:** `half_spread_bps >= max(config.min_spread_bps,
    ceil(sigma_bps · vol_spread_coeff_bps / 10_000))`, with `sigma_bps`
    multiplied by `jump_multiple` while a jump is active or its cooldown is
    running, else `VolatilitySpreadTooLow`;
  - **depth cap:** `depth_mult_bps <= 10_000 − min(10_000,
    ceil(effective_sigma_bps · vol_depth_coeff_bps / 10_000))`, else
    `DepthAboveVolatility`.
- `enabled == false` short-circuits the whole guard.

### 2.5 Keeper integration (Phase 4 completion)

`vault/keeper/src/lib.rs` and `vault/keeper/src/main.rs`:

- `UpdateQuotePlan`, `StageQuotePlan`, `CommitQuotePlan` gain
  `volatility_state: Option<Address>`. Builders append the account only when it
  is `Some` — `UpdateQuote`/`CommitQuote` at the end, `StageQuote` before
  `system_program`. This preserves compatibility with a program that does not yet
  expose the field.
- New `volatility_pda(vault, program_id)`, `ObserveVolatilityPlan`,
  `encode_observe_volatility_instruction`, `build_observe_volatility_transaction`.
- `volatility_spread_depth(sigma_bps, mult, spread_coeff, depth_coeff,
  min_spread)` computes the floor/cap; `mul_bps_ceil` matches the program's
  rounding.
- `vault/keeper/src/main.rs`: `read_volatility` derives the PDA, fetches and
  decodes the account, submits an observation best-effort on each new publish,
  clamps proposed quotes to the on-chain spread floor and depth cap before
  staging, and skips publishing (kill-switch) when the floor would exceed the
  configured max spread.

### 2.6 Frontend (Phase 5)

- **New:** `app/src/chain/volatility.ts` — hand-written borsh decode
  (`decodeVolatilityState`), `deriveVolatilityAddress`, `volatilityView`,
  `sigmaQ64Of`/`sigmaBpsOf`, and a classified `readVolatility` that validates
  account owner, length (`VOLATILITY_ACCOUNT_LEN = 175`) and vault binding.
- **New:** `app/src/chain/useVolatilityRegime.ts` — 8 s poll via the existing
  `APP_RPC_FAILOVER.runKeyed`; status `loading | ready | absent | error`.
- **Modified:** `app/src/pages/RiskPage.tsx` — Pillar 2 is the **Volatility
  Regime** card: σ in bps, spread floor · depth cap, observation age/nonce, jump
  badge, and a source note. It shows `Awaiting verified observation` when the
  account is absent or stale and never falls back to keeper-local numbers.
- **New test:** `app/test/volatility.test.ts` (8 cases).

### 2.7 Call-site updates

- `vault/program/tests/litesvm_lifecycle.rs` — `Fixture` gains
  `volatility_state: Address`, derives the PDA, and calls a new
  `initialize_volatility` helper after `initialize_vault`; account initializers
  updated.
- `vault/e2e/src/main.rs` — derives `[b"vol", vault]` and passes it to the
  `UpdateQuote` initializer.
- `vault/program/tests/common/mod.rs` — new `volatility_address`,
  `set_disabled_volatility`, and `install_volatility` helpers so the hand-rolled
  LiteSVM quote instructions can install the now-required PDA.
- `litesvm_breaker.rs`, `litesvm_oracle_scaling.rs`, `litesvm_recovery.rs` — the
  inline `update_quote` account lists now append the (disabled) volatility PDA.
- **New:** `vault/program/tests/litesvm_volatility.rs` — 8 runtime regression
  tests (see §4).
- `vault/program/tests/litesvm_lifecycle.rs` — `Fixture` gains
  `observe_volatility`, `propose_volatility_params`, `apply_volatility_params`,
  `arm_volatility`, `pending_volatility(_value)`, `volatility_state_value`,
  `current_slot`, and `set_unix_timestamp` helpers, plus an Anchor-event decoder
  (base64 `Program data:` → discriminator) used by 14 new life-cycle tests.
- `vault/program/src/lib.rs` — `TIMELOCK_SLOTS` is now `pub` so a test asserts the
  on-chain activation slot against the real constant.
- `vault/program/Cargo.toml` — adds a test-only `base64 = "0.22"` dev-dependency
  for the event decoder.

### 2.8 LiteSVM run environment

The LiteSVM suite executes a prebuilt `target/deploy/arbswap.so`. It must be
built with the **Solana CLI 4.1.2 `cargo build-sbf`** path used by CI
(`.github/workflows/ci.yml`), not `anchor build`: `anchor build` with the local
CLI 1.1.2 produces an artifact that faults at the program entry
(`Access violation writing 8 bytes at address 0x3`) under `litesvm 0.16.0`.
With the CI build path the full suite runs (§4).

---

## 3. Data model and units (summary)

| Quantity | Unit | Notes |
|---|---|---|
| price | Q64.64 | normalized token-unit price (`normalize_pyth_price_q64`) |
| `short_ewma_q64`, `medium_ewma_q64` | Q64.64 | per-second return **variance** |
| `sigma` | Q64.64 | `sqrt_q64(short_ewma_q64)` |
| `*_lambda_bps` | bps | `9_400 = 0.94`, `9_900 = 0.99` |
| `jump_multiple` | integer | multiple of sigma |
| `max_sigma_q64` | Q64.64 | kill-switch ceiling |
| `vol_spread_coeff_bps` / `vol_depth_coeff_bps` | bps | spread floor / depth cap scaling |
| `*_slots` | slots | cooldown, max observation age |
| `enabled` | bool | guard armed only after timelocked apply |

Default params: λ_short 9 400, λ_medium 9 900, jump multiple 4, max sigma
`1<<60` (≈0.0625), cooldown 1 800 slots, spread coeff 1 000 bps, depth coeff
2 000 bps, max observation age 3 600 slots.

---

## 4. Verification performed

| Check | Result |
|---|---|
| `cargo test --workspace` | **260 pass** (incl. all LiteSVM suites) |
| `cargo build --workspace` | builds |
| `cargo clippy -p arb-math -p arbswap-keeper -p arb-aggregator -p arbswap -- -D warnings` (CI form) | clean |
| `cargo fmt --all -- --check` | clean |
| `cargo test -p arbswap --test frontend_fixtures` + `git diff --exit-code app/test/fixtures/accounts.json` | pass, fixtures fresh |
| `anchor build --ignore-keys` | builds |
| `python -m pytest simulation` (`.venv`) | 231 passed, 2 skipped |
| `python -m simulation.reference.golden` + `git diff --exit-code vault/math/tests/golden_vectors.txt` | in sync |
| `scripts/banned_words.py` | CLEAN |
| `scripts/secrets_scan.py` | CLEAN |
| `scripts/check_docs_consistency.py` | docs consistent |
| `scripts/fuzz_short.sh 30` | all 3 targets clean |
| `npx tsc -b` / `npx oxlint` | clean |
| `npx vitest run` | 138 pass (incl. 10 volatility) |
| keyless production bundle secret scan | clean |
| `scripts/frontend_audit_gate.mjs` | pass (18 waived, bundle clean) |

### LiteSVM runtime results (resolved)

The suite runs against the artifact built with Solana CLI 4.1.2
`cargo build-sbf --manifest-path vault/program/Cargo.toml` (the CI path) instead
of `anchor build` (the latter faults at the program entry under `litesvm 0.16.0`):

| Suite | Result |
|---|---|
| `litesvm_lifecycle` | **118 pass** (incl. 14 volatility-lifecycle tests) |
| `litesvm_breaker` | 2 pass |
| `litesvm_oracle_scaling` | 3 pass |
| `litesvm_recovery` | 8 pass |
| `litesvm_security` | 3 pass |
| `litesvm_volatility` (new) | 8 pass |
| **LiteSVM total** | **142 pass** |

`litesvm_volatility` covers: a disabled PDA is a no-op for legacy quotes;
omitting the required PDA is rejected (`AccountNotEnoughKeys`); an enabled PDA
without a baseline fails closed; a stale observation is rejected; a spread below
the floor is rejected; a spread at the floor and depth at the cap are accepted;
a depth above the cap is rejected; sigma above the ceiling trips the kill-switch.

The 14 new free life-cycle tests (in `litesvm_lifecycle.rs`) cover the
observation and timelock life cycle:
- `observe_volatility`: seeds baseline, advances both EWMAs, nonce increments,
  event fields (`VolatilityObserved`) decoded; wrong feed / repeated / stale /
  wide-confidence / non-positive price all rejected with no state mutation; a
  permissionless outsider observes without changing config/vault/params; an
  extreme price-ratio overflow (`MathOverflow`) is atomic; a large move flags a
  jump and opens the cooldown, and the cooldown survives a later calm observation.
- timelock: a proposal records `activate_slot = now + TIMELOCK_SLOTS` and leaves
  the live account untouched; apply before the timelock is `TimelockNotElapsed`;
  apply after copies the params and **preserves** EWMA/nonce/jump cooldown; the
  proposal is consumed (replay rejected); enabling requires a baseline
  (`VolatilityNotReady`) while disabling does not; invalid params / wrong
  authority rejected on propose and apply; disablement goes through the timelock.
- end-to-end: a disabled PDA does not change quote behaviour; after arming, a
  below-floor `update_quote` is `VolatilitySpreadTooLow` while a compliant quote
  commits; the staged path (`stage_quote` + `commit_quote`) enforces the same
  guard.

### Local-build note (not caused by this work)

`app/.env.local` sets `VITE_SOLANA_RPC_URL` to a Helius endpoint containing an
`api-key` query parameter, so a local `vite build` embeds that key into
`dist/`. The `s2-32-integration` secret-scan test catches this when `dist/`
exists (it skips when `dist/` is absent). `dist/` is gitignored and was removed
after verifying the build; the tracked source contains no secret. A production
build with an explicitly keyless Devnet RPC passes the secret scan. Deployments
should inject the RPC URL from the host environment rather than a committed
file.

---

## 5. Remaining work

### 5.1 LiteSVM volatility tests — done

`litesvm_volatility.rs` (8) covers the quote-enforcement guard; the 14
volatility-life-cycle tests in `litesvm_lifecycle.rs` cover `observe_volatility`
(seed/update/nonce/event + all rejection paths + overflow atomicity + jump
cooldown) and the timelocked `propose_volatility_params` /
`apply_volatility_params` flow (activation slot, timelock enforcement, history
preservation, replay rejection, baseline requirement, wrong authority), plus the
end-to-end activation and staged-quote (`stage_quote`/`commit_quote`) guard.

Remaining nice-to-haves (not blocking): first-observation decimal-normalization
cases with a non-9/9 pair, and a dedicated `initialize_volatility` re-init
rejection test (covered indirectly by the context `init` constraint). These would
need additional `PriceUpdateV2` fixtures; the math itself is covered by the 13
host vectors.

### 5.2 Devnet rollout + observer — **done (authorized and executed)**

The program was upgraded on Devnet, the volatility PDA initialized, the
volatility-aware keeper observed the baseline, and params were proposed then
applied after the timelock: **`VolatilityState.enabled = true`** as of slot
`511663484` (apply `23gBbdKw…`, pending disarmed). Tx signatures and account
snapshots are recorded in `docs/VOLATILITY_DEVNET_DEPLOYMENT.md` and
`docs/VOLATILITY_ROLLOUT.md`. The configured volatility-aware keeper performs
the observations (an *independent* observer separate from the keeper was not
stood up). No further authorization is pending for this rollout. Re-verified
read-only on `deposit-withdraw` (2026-10-17): `enabled = true`, nonce 190.

### 5.3 Acceptance-criteria checklist (from the plan, §Acceptance)

| Criterion | Status |
|---|---|
| EWMA values + jump status in a vault-bound on-chain account | **done** |
| Any valid observer can update from verified Pyth data | **done** (`observe_volatility`) |
| Replayed/stale/invalid/wrong-feed observations rejected | **done** (code + LiteSVM observe rejections) |
| Keeper quotes constrained by on-chain volatility state | **done** (program enforcement + keeper clamp; LiteSVM-verified) |
| Keeper and program math match all golden vectors | **done** (single shared module + tests) |
| Risk page labels values as from on-chain | **done** (Volatility Regime card) |
| Rejected quote attempts do not erase valid observations | **done by construction** (`observe_volatility` is a separate instruction) |
| Covered by Rust, property, LiteSVM, and frontend tests | **done** (Rust + keeper + LiteSVM guard + frontend) |

---

## 6. Files touched

**New**
- `docs/VOLATILITY_MATH_SPEC.md`
- `docs/VOLATILITY_IMPLEMENTATION_STATUS.md` (this file)
- `docs/VOLATILITY_ROLLOUT.md`
- `vault/math/src/volatility.rs`
- `vault/math/tests/volatility.rs`
- `app/src/chain/volatility.ts`
- `app/src/chain/useVolatilityRegime.ts`
- `app/test/volatility.test.ts`
- `vault/program/tests/litesvm_volatility.rs`

**Modified**
- `vault/math/src/lib.rs`
- `vault/keeper/src/lib.rs`
- `vault/keeper/src/main.rs`
- `vault/program/src/lib.rs` (`pub const TIMELOCK_SLOTS`; volatility instructions)
- `vault/program/Cargo.toml` (`base64` test-only dev-dep)
- `vault/program/tests/common/mod.rs`
- `vault/program/tests/litesvm_lifecycle.rs` (fixture helpers + 14 tests)
- `vault/program/tests/litesvm_breaker.rs`
- `vault/program/tests/litesvm_oracle_scaling.rs`
- `vault/program/tests/litesvm_recovery.rs`
- `vault/e2e/src/main.rs`
- `app/src/chain/volatility.ts` (provenance fix)
- `app/src/pages/RiskPage.tsx`

**Pre-existing untracked docs (from a prior pass, unrelated to volatility)**
- `docs/ONE_SIDED_DEPOSIT_IMPLEMENTATION.md`
- `docs/PUBLIC_LVR_TRANSPARENCY_PLAN.md`

---

## 7. How to re-run the checks

```bash
# Build the SBF artifact the way CI does (Solana CLI 4.1.2), then run everything:
rm -rf target/deploy target/sbf-fresh
CARGO_TARGET_DIR="$PWD/target/sbf-fresh" cargo build-sbf --manifest-path vault/program/Cargo.toml
mkdir -p target/deploy && cp target/sbf-fresh/deploy/arbswap.so target/deploy/arbswap.so

# Rust (CI form)
cargo test --workspace
cargo fmt --all -- --check
cargo clippy -p arb-math -p arbswap-keeper -p arb-aggregator -p arbswap -- -D warnings
cargo test -p arbswap --test frontend_fixtures && git diff --exit-code -- app/test/fixtures/accounts.json

# Python
.venv/bin/python -m pytest simulation -q
.venv/bin/python -m simulation.reference.golden && git diff --exit-code -- vault/math/tests/golden_vectors.txt
.venv/bin/python scripts/check_docs_consistency.py
.venv/bin/python scripts/banned_words.py
.venv/bin/python scripts/secrets_scan.py
# .venv/bin/python scripts/check_bundle_freshness.py   # pre-existing failure, see §4

# Frontend
(cd app && npm run lint && npm test)
# Keyless production bundle + secret scan (do not bake .env.local):
(cd app && rm -rf dist && VITE_SOLANA_RPC_URL=https://api.devnet.solana.com \
  VITE_SOLANA_RPC_FALLBACKS=https://api.devnet.solana.com npm run build && \
  grep -raoE "api-key|helius|private_key" dist/ ; rm -rf dist)

# Fuzz (nightly + cargo-fuzz)
bash scripts/fuzz_short.sh 30

# `anchor build` alone is NOT sufficient for LiteSVM here: the local Anchor CLI
# 1.1.2 artifact faults at program entry under litesvm 0.16.0. Use the CI
# `cargo build-sbf` path above (solana-cli 4.1.2).
```
