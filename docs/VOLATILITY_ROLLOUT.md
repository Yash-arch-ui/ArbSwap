# Volatility Guard — Devnet Rollout Runbook (prepared, not executed)

This runbook stages the rollout of the on-chain EWMA volatility & jump detector.

> **None of the state-changing steps below has been run.** No program upgrade,
> deploy, init, proposal, apply, or swap was performed while preparing this
> document. Every step in §3–§9 requires **explicit, per-phase authorization**.
> Placeholders such as `<TX_SIG>` are **not** real signatures and must be filled
> only with hashes observed after an authorized run.

## Evidence levels (keep these distinct)

| Level | What it means | Status |
|---|---|---|
| Local host tests | `cargo test`, unit tests | Green (see status doc) |
| LiteSVM integration | Program executed in a local SBF VM | Green (142 tests incl. 14 volatility-lifecycle) |
| Frontend | TypeScript, Oxlint, Vitest, keyless bundle scan | Green (138 tests) |
| **Devnet** | Real cluster state, real signatures | **Not executed** |

Nothing in this document is evidence of a Devnet deployment.

Companion docs:
- `docs/VOLATILITY_MATH_SPEC.md` — the frozen math.
- `docs/VOLATILITY_IMPLEMENTATION_STATUS.md` — what is implemented and verified.
- `docs/ONCHAIN_VOLATILITY_JUMP_DETECTOR_PLAN.md` — the original proposal.

---

## 0. Preconditions

- Program source on `main` builds: `cargo build --workspace`; the SBF artifact
  builds with **Solana CLI 4.1.2 `cargo build-sbf`** (the CI path).
- The full LiteSVM suite passes against that artifact (see status doc). Do **not**
  use `anchor build` with the local Anchor CLI 1.1.2 for the deployable artifact:
  it produces an artifact that faults at the program entry under `litesvm 0.16.0`.
- This is a **one-way ABI change**: `update_quote`, `stage_quote`, and
  `commit_quote` each take an additional **required** account, the vault-bound
  volatility PDA `[b"vol", vault]`.
- Devnet-only. Mainnet is out of scope.

> ### ✅ Keeper blocker resolved (Phase 3B, uncommitted candidate)
> The **live Devnet keeper is TypeScript** (`scripts/devnet/keeper_live.ts`, run
> by `keeper_supervisor.sh`), not the Rust keeper. It previously built the
> `stage_quote`/`commit_quote` account lists without the volatility PDA. It is now
> volatility-aware (see §3b): it derives `[b"vol", vault]`, passes it on
> stage/commit, stops cleanly when the PDA is absent
> (`VolatilityStateNotInitialized`), submits permissionless `observe_volatility`
> observations when a baseline is missing or stale, and clamps its candidate
> quote to the on-chain volatility floor/depth cap. Verified locally only — no
> Devnet transaction has been sent.

## 1. Program, PDA, and timelock constants

| Item | Value |
|---|---|
| Devnet program id | `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` |
| Devnet genesis | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| ProgramData account | `4156VC8Vzc8wQDqtLe9rdRHtRj9UpRysp2uBTNGW93Mh` |
| Upgrade authority | `ddGs6hk5E4oPzSnwFfX4pD4DDhDTLTwRddv1VQym7bH` (keypair `~/.config/solana/arbswap-devnet.json`) |
| Active vault (WSOL/USDC) | `8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt` |
| Config | `ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT` |
| QuoteState | `5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG` |
| Base/quote mints | WSOL `So11111111111111111111111111111111111111112` / USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Volatility PDA (this vault) | `5HbPRjBorUKKFbncnMFxoHC2sio5t8UqF9FvfGwcity3` (currently **absent**) |
| Pending-volatility PDA | `z9zyVXVoCNPXL8EHj6QKZwTxa1V8oHHrPcUrGLYukRF` |
| Volatility PDA seed | `[b"vol", vault]` |
| Pending-volatility seed | `[b"vol_pending", vault]` |
| Timelock | `TIMELOCK_SLOTS = 216_000` (≈ 24 h at 400 ms/slot) |
| Enforcement switch | `VolatilityState.enabled` (starts `false`) |
| Deployed program (pre-upgrade) | 780224 bytes, sha256 `dff8a3020f4053342a3b5b6b109f1253ff126df4048fb1244811e30a5595371f` (via `solana program dump`) |
| New artifact | 849368 bytes, sha256 `42eeac64cee3d2b9399ecd7523b7a1bf4336c8038dd10422a72117224e767ea8` |

---

## 2. Build the deployable artifact

```bash
# from the repo root (the path CI uses)
rm -rf target/deploy target/sbf-fresh
CARGO_TARGET_DIR="$PWD/target/sbf-fresh" \
  cargo build-sbf --manifest-path vault/program/Cargo.toml
mkdir -p target/deploy
cp target/sbf-fresh/deploy/arbswap.so target/deploy/arbswap.so

# Record the artifact hash for the release notes.
sha256sum target/deploy/arbswap.so
```

Local reference build (for comparison only — **verify your own**):
`sha256 42eeac64cee3d2b9399ecd7523b7a1bf4336c8038dd10422a72117224e767ea8`,
size 849368 bytes.

Do **not** run `anchor keys sync` against the live vault keypair: the local
`Anchor.toml` keypair id differs from the devnet program id. Verify the deploy
target instead:

```bash
solana program show 2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm --url devnet
```

After building, re-run the local suite against the fresh artifact:

```bash
cargo test --workspace
```

---

## 3. Upgrade the program — **requires authorization**

```bash
# 1) write a buffer, 2) upgrade, 3) verify
solana program write-buffer target/deploy/arbswap.so --url devnet \
  --keypair ~/.config/solana/id.json
solana program upgrade <BUFFER> 2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm \
  --url devnet --keypair ~/.config/solana/id.json
solana program show 2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm --url devnet
```

Post-upgrade checks:
- The deployed `.so` hash matches the artifact (where the tooling exposes it).
- Decode one keeper `update_quote` and confirm the account count increased by one
  (the required volatility PDA).

### 3a. Upgrade liveness window (read before upgrading)

- **Affected instructions:** `update_quote`, `stage_quote`, `commit_quote` now
  require `[b"vol", vault]`; `observe_volatility` also requires it (to advance
  state). Until the PDA exists, these fail:
  - omitted account → `AccountNotEnoughKeys`;
  - included but missing → account-not-found / not-initialized.
- **Swaps are not affected.** `swap` does not take the volatility PDA, so an
  **already-committed, unexpired** quote can still be filled after the upgrade.
  Traders are not blocked; only quote maintenance is.
- **Keeper operations that need the PDA:** `update_quote`, `stage_quote`,
  `commit_quote`, `observe_volatility`. The volatility-aware TS keeper (§3b)
  passes the PDA on stage/commit and observes automatically, so it recovers as
  soon as §4 creates the PDA.
- **No partial state.** `initialize_volatility` is a single atomic transaction:
  it either creates the PDA with `enabled = false` and defaults, or reverts with
  nothing written. There is no half-initialized account to clean up.
- **Recovery if initialization fails:** simply retry `initialize_volatility`
  (the account does not exist, so `init` succeeds again). If the first
  *observation* fails, the PDA exists with `last_price_q64 == 0`; keep retrying
  `observe_volatility` until it lands. An enabling `apply_volatility_params`
  will refuse with `VolatilityNotReady` until a baseline exists, so ordering is
  self-correcting.
- **Multi-vault:** every vault that must quote needs its own PDA. Initialize each
  promptly after the upgrade; an uninitialized vault cannot maintain quotes.

### 3b. The live volatility-aware TypeScript keeper (implemented)

The live keeper is `scripts/devnet/keeper_live.ts` (TypeScript, run by
`keeper_supervisor.sh`). It computes the quote payload with the Rust engine
(`arbswap-keeper quote-json`) but builds the on-chain transactions in TS. It was
made volatility-aware via a new pure helper module
`scripts/devnet/volatility.ts`:

- **PDA:** `volatilityPda(vault, programId)` derives `[b"vol", vault]`
  (`5HbPRjBorUKKFbncnMFxoHC2sio5t8UqF9FvfGwcity3` for this vault); it is derived,
  never hardcoded.
- **`stage_quote` keys (`buildStageKeys`):** the volatility PDA is inserted
  immediately before `system_program`
  (`keeper, vault, config, quote_state, pending, base_reserve, quote_reserve,
  keeper_bond, volatility_state, system`).
- **`commit_quote` keys (`buildCommitKeys`):** the volatility PDA is the last of
  the 12 program accounts (`…, WSOL, USDC, volatility_state`); the Pyth push's
  Wormhole account is kept as an extra trailing account Anchor ignores.
- **Observation (`observeVolatility`):** when the PDA exists and its baseline is
  missing or its observation is older than half the configured age
  (`volatilityAction`), the keeper submits `observe_volatility` in its **own**
  transaction with its own Pyth push — so a later quote rejection can never roll
  back a valid observation. It re-reads the account and treats it as
  authoritative only when `last_price_q64 > 0` and the publish time reached the
  expected value.
- **Absent PDA:** logs `VolatilityStateNotInitialized` and stops quote
  maintenance cleanly (never falls back to a legacy layout, never treats
  volatility as zero).
- **Limits (`volatilityLimits` / `clampQuoteBody`):** while `enabled`, the keeper
  computes the same floor/depth-cap/kill-switch the program enforces and clamps
  its candidate quote (`half_spread` up to the floor at body offset 52, `depth`
  down to the cap at offset 64); if `sigma > max_sigma` or the floor exceeds the
  configured max spread it skips (risk-blocked) rather than loosening the guard.
- **Never** initializes the PDA, proposes/applies parameters, or enables
  enforcement.

Rust-engine impact: none — `quote-json` only computes the payload.

Verified locally by `scripts/devnet/volatility.test.ts` (PDA, decode, fixed-point
math, limits, clamp, and the exact account order/flags for stage/commit/observe)
plus the Rust LiteSVM suites; no Devnet transaction has been sent.

---

## 4. Initialize the volatility PDA — **requires authorization**

Admin-only, one-time. The all-zero params payload selects
`DEFAULT_VOLATILITY_PARAMS`. This writes `enabled = false`, so quotes are
unaffected.

```bash
# initialize_volatility(params = all zeros)
# accounts: admin (signer), vault, volatility_state ([b"vol", vault]), system_program
```

Verify the account:

```bash
solana account <VOLATILITY_PDA> --url devnet
# decode: enabled == false, last_price_q64 == 0, observation_nonce == 0
solana confirm <TX_SIG> --url devnet
```

---

## 5. First observation — **requires authorization (a state change)**

`observe_volatility` is **permissionless**. It requires a fresh, feed-matching,
confidence-bounded `PriceUpdateV2` with a strictly newer `publish_time` than the
stored one. The keeper submits it best-effort on each publish; any signer may
also submit it and gains no authority.

```bash
# observe_volatility()
# accounts: observer (signer), vault, config, volatility_state, price_update,
#           base_mint, quote_mint   (mints must equal the vault's)
```

Verify the persisted state (all fields come from the account, not the event):

```bash
solana account <VOLATILITY_PDA> --url devnet
# expect: last_price_q64 > 0, observation_nonce == 1,
#         last_publish_time == the Pyth publish_time just posted,
#         last_observation_slot == the slot of this transaction, enabled == false
solana confirm <TX_SIG> --url devnet
```

Optional: decode the `VolatilityObserved` event and confirm its `nonce`,
`publish_time`, and EWMA fields match the account.

Do **not** propose/apply until a baseline exists.

---

## 6. Propose params (starts the timelock) — **requires authorization**

Admin-only, validated. Without a baseline, an enabling apply is rejected with
`VolatilityNotReady`, so finish §5 first.

```bash
# propose_volatility_params(params, enabled = true)
# accounts: admin (signer), vault, pending_volatility ([b"vol_pending", vault]),
#           system_program
```

Effects:
- Writes `[b"vol_pending", vault]` with `activate_slot = clock.slot + TIMELOCK_SLOTS`.
- Emits `VolatilityParamsProposed`.
- **Leaves the live `VolatilityState` untouched.** Re-proposing resets the timer.

Verify:

```bash
solana account <VOL_PENDING_PDA> --url devnet
# expect: admin == vault.admin, enabled == true,
#         params == the proposed values, activate_slot == propose_slot + 216000
solana confirm <TX_SIG> --url devnet
```

---

## 7. Apply params (arms the guard) — **requires authorization**

After `clock.slot >= activate_slot`, `apply_volatility_params` is **admin-only**
(the signer must equal both `vault.admin` and `pending_volatility.admin`). It
re-validates and copies the pending payload onto the live account.

```bash
# wait until clock.slot >= activate_slot
# apply_volatility_params()
# accounts: admin (signer), vault, volatility_state, pending_volatility
```

Verify:

```bash
solana account <VOLATILITY_PDA> --url devnet
# expect: enabled == true, params == the proposed values,
#         EWMA/nonce/last_price/jump_until_slot PRESERVED (apply does not clear history)
solana account <VOL_PENDING_PDA> --url devnet
# expect: activate_slot == u64::MAX (the proposal is consumed; replay is rejected)
solana confirm <TX_SIG> --url devnet
```

After this, the guard runs on every `update_quote` / `stage_quote` /
`commit_quote`: stale observation, missing baseline, sigma above `max_sigma_q64`,
spread below the floor, or depth above the cap all fail closed.

---

## 8. Negative and smoke tests — **require authorization (state changes)**

Run against the vault's own accounts, with the guard armed:

1. **Low spread rejected.** Submit `update_quote` with `half_spread_bps` below
   the derived floor → expect `VolatilitySpreadTooLow`; confirm the committed
   quote version did not advance.
2. **Depth above cap rejected.** `depth_mult_bps` above the cap → expect
   `DepthAboveVolatility`.
3. **Stale state rejected.** Let the observation age past
   `max_observation_age_slots`, then submit a valid quote → expect
   `StaleVolatilityObservation` (fail closed).
4. **Bypass impossible.** Build the same `update_quote` without the volatility
   account → expect `AccountNotEnoughKeys`. (The account is required.)
5. **Jump restriction.** After a large move, `jump_detected` is set and
   `jump_until_slot = slot + jump_cooldown_slots`; a spread that clears the calm
   floor but not the jump-multiplied floor is rejected; the flag clears on the
   next calm observation but `jump_until_slot` persists.
6. **Compliant quote commits.** A spread at/above the floor with depth at/below
   the cap advances the quote version.
7. **Existing quote/swap smoke test.** Fill an **already-committed, unexpired**
   quote via `swap` and confirm it still settles (swaps are unaffected by the
   volatility guard).
8. **Frontend provenance.** The Risk page "Volatility Regime" card shows the same
   sigma, floor, and cap the program reports, and shows `ON-CHAIN VERIFIED` only
   when the account is enabled and its observation is fresh.

---

## 9. Rollback / disablement — **requires authorization**

The guard is armed only by `enabled`; disablement uses the same timelocked path
(it is **not** instant):

```bash
# 1) propose_volatility_params(existing_params, enabled = false)
# 2) wait at least TIMELOCK_SLOTS
# 3) apply_volatility_params()      # admin-only
```

While disabled, quotes are unconstrained again, but the required account stays in
the instruction signature, so clients must keep passing the PDA. Rollback
limitations:
- **Not instant:** disablement waits the full timelock.
- **ABI is permanent:** after the upgrade, the required account cannot be
  removed without another upgrade.
- **A vault that never initializes** cannot maintain quotes; there is no
  "old program" fallback once upgraded.

### 9a. Program rollback (overwrite the upgraded program)

Program rollback is technically possible because the upgrade authority is held
by `ddGs6hk5E4oPzSnwFfX4pD4DDhDTLTwRddv1VQym7bH` and the loader supports
re-upgrade. **A byte-exact copy of the currently deployed program was captured
read-only during preflight:**

```bash
solana program dump -u https://api.devnet.solana.com \
  2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm arbswap-deployed-<slot>.so
# sha256 dff8a3020f4053342a3b5b6b109f1253ff126df4048fb1244811e30a5595371f (780224 bytes)
```

To roll back after an upgrade: `solana program write-buffer` the captured ELF and
`solana program upgrade` it back. Limitations:
- No prior release artifact is stored in the repo; the captured dump is the
  authoritative rollback image and must be preserved outside `/tmp`.
- Rollback also reverts the ABI, so a volatility-aware keeper (or the original
  keeper) must match whichever program is deployed.
- A rollback does **not** delete the volatility PDA; it simply becomes unused by
  the old program.

---

## 10. Authorization gates (checklist)

Each of these is a separate approval, not covered by any blanket go-ahead:

- [x] Build artifact + hash recorded + local suite green.
- [x] Volatility-aware TypeScript keeper implemented and locally verified (§3b).
- [x] Restart the supervisor with the volatility-aware keeper (`keeper_live.ts`).
- [x] Upgrade the program on devnet.
- [x] `initialize_volatility` for each vault.
- [x] First `observe_volatility` (baseline).
- [x] `propose_volatility_params` (enable).
- [x] `apply_volatility_params` after the timelock.
- [x] Negative/smoke tests (§8).
- [x] Any rollback/disablement proposal and apply.

> **Evidence (all phases PASS — see `docs/VOLATILITY_DEVNET_DEPLOYMENT.md`):** upgrade `2fQanNCC…`
> (slot 511445760); `initialize_volatility` `5c6wZBsG…` (enabled=false); first observation by
> the already-running volatility-aware keeper (Phase D); `propose_volatility_params(enabled=true)`
> `27PQmipm…` (activate_slot 511663348); **`apply_volatility_params` `23gBbdKw…` at slot 511663484**
> → on-chain `VolatilityState.enabled = true`, pending disarmed (`activate_slot = u64::MAX`); no
> rollback/disablement was needed. Negative/smoke coverage: LiteSVM volatility + breaker suites and
> the Phase D liveness smoke. Re-verified read-only on `deposit-withdraw` (2026-10-17): `enabled = true`.

## 10a. Operational sequence (authorization-gated)

1. Upgrade the program (§3) — separate authorization.
2. `initialize_volatility` for the vault (§4).
3. Restart the supervisor with the volatility-aware keeper (§3b) — only now is the
   PDA + required accounts ready.
4. The keeper establishes the first valid Pyth observation (`observe_volatility`)
   automatically, or an operator submits it (§5).
5. Verify the stored baseline (`last_price_q64 > 0`) and freshness.
6. Quote maintenance resumes, passing the volatility PDA (§5–§7).
7. Propose the timelocked volatility parameters (§6).
8. Wait the full `TIMELOCK_SLOTS` (§7).
9. Refresh the observation if required (the keeper does this automatically).
10. Apply parameters through the authorized path (§7).
11. Verify normal quotes, risk rejections, jump cooldown, and the swap path (§8).

**Liveness gap:** between step 1 and step 3/4, `stage_quote`/`commit_quote`
require the PDA and fail; an already-committed, unexpired quote can still be
**swapped** (swap has no PDA), but **quote maintenance cannot continue** until
the PDA is initialized and a volatility-aware keeper is running.

## 11. Local-only verification status (no devnet claims)

- `cargo test --workspace`: 260 tests. LiteSVM 142 (lifecycle 118 incl. 14
  volatility-lifecycle; volatility guard 8; breaker 2; oracle 3; recovery 8;
  security 3).
- Devnet TypeScript: `volatility.test.ts` (59 checks — PDA, decode, fixed-point
  math, guard limits, body clamp, and the exact stage/commit/observe account
  order/flags); `rpc.test.ts` 24, `keeper_commit.test.ts` 9,
  `broadcast.test.ts` 19. `esbuild` bundle of `keeper_live.ts` clean.
- `python -m pytest simulation`: 231 passed, 2 skipped.
- Frontend: `tsc`/oxlint clean, 138 Vitest tests, keyless bundle secret scan clean.
- Fuzz (`scripts/fuzz_short.sh 30`): all three targets clean.
- `scripts/banned_words.py`, `scripts/secrets_scan.py`,
  `scripts/check_docs_consistency.py`: clean.
- `scripts/check_bundle_freshness.py`: **fails on committed history**, see the
  status doc — it compares the published bundle's commit against HEAD and ignores
  the working tree; unrelated to this feature.

Reference API surface for auth scripts:
`initialize_volatility(params)`, `observe_volatility()`,
`propose_volatility_params(params, enabled)`, `apply_volatility_params()`
(`scripts/devnet/volatility_admin.ts` wraps the last three for the admin).

## 12. Live Devnet execution status

See `docs/VOLATILITY_DEVNET_DEPLOYMENT.md` for signatures and account state.
Current state (this execution):

| Phase | Status |
|---|---|
| A buffer | **PASS** (`6U7hPAfq…`) |
| ProgramData extend (+69144) | **PASS** |
| B upgrade | **PASS** (`2fQanNCC…`, slot 511445760) |
| C initialize PDA (disabled) | **PASS** (`5c6wZBsG…`) |
| D observation + quote liveness | **PASS / ongoing** (keeper auto-observed; quotes advancing) |
| E propose (enabled) | **PASS** (`27PQmipm…`) |
| E apply | **PASS** (`23gBbdKw…`, slot 511663484); enforcement `enabled = true`, pending disarmed |

Liveness: quote maintenance is running under the volatility-aware TS keeper with
the required PDA; brief expiry gaps persist due to provider `429` throttling.
Applicable liveness measurement should be included in the final report.
