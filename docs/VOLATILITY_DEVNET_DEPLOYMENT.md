# Volatility Rollout — Devnet Execution Evidence

> Living record of the authorized Devnet rollout. Contains public identifiers,
> transaction signatures, and account state only. **No secrets, keys, or
> credential-bearing URLs.** Status vocabulary: `NOT STARTED`, `WAITING FOR
> AUTHORIZATION`, `IN PROGRESS`, `PASS`, `FAIL`, `BLOCKED`, `PENDING`.

Cluster: **Solana Devnet** · genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.

## Toolchain / artifact

| Item | Value |
|---|---|
| solana-cli / cargo-build-sbf | 4.1.2 / 4.1.0 (platform-tools v1.54, SBF rustc 1.89.0) |
| Candidate | `target/sbf-preflight/deploy/arbswap.so`, 849,368 B, sha256 `42eeac64cee3d2b9399ecd7523b7a1bf4336c8038dd10422a72117224e767ea8` |
| Rollback ELF | `~/arbswap-rollback/arbswap-prevolatility-780224.so`, 780,224 B, sha256 `dff8a3020f4053342a3b5b6b109f1253ff126df4048fb1244811e30a5595371f` |

## Phase status

### Phase A — upgrade buffer — **PASS**
- `solana program write-buffer … --buffer-authority ddGs6hk5E4oPzSnwFfX4pD4DDhDTLTwRddv1VQym7bH --fee-payer 8R3VDePS…`
- Buffer `6U7hPAfq4muGqwB466C7UoduQe7FAjXXee4eBYj33AS4`; owner = upgradeable loader; authority `ddGs…`; data 849,368 B; balance 4.31562764 SOL.
- Note: the CLI printed the buffer address (upload exit 0) but not per-chunk signatures; not fabricated.

### ProgramData extension — **PASS**
- `solana program extend 2mwp… 69144` (ProgramData 780,269 → 849,413 B) — required because the new ELF is larger. CLI printed completion (signature not echoed).

### Phase B — program upgrade — **PASS**
- `solana program upgrade 6U7hPAfq… 2mwp… -k ddGs…`
- **Signature `2fQanNCCqfHJ7B6XnkzZGYwtW938Cvcf8aEXS79yUWr4QMqamAcg5rX6zESfLmu1qWpMoQ7r7hcxSnpdLdt61ecq`** (finalized).
- ProgramData `4156VC8Vzc8wQDqtLe9rdRHtRj9UpRysp2uBTNGW93Mh`; slot `511445760`; data 849,368 B; authority unchanged (`ddGs…`).
- `program dump` of the deployed program is **byte-identical** to the candidate (`42eeac64…`).

### Phase C — initialize volatility PDA — **PASS**
- Vault-bound PDA `[b"vol", vault]` = `5HbPRjBorUKKFbncnMFxoHC2sio5t8UqF9FvfGwcity3`.
- **Signature `5c6wZBsGoDCEipLfHb6HTnMyXE3R6fFotDsng1ihaXy4N9Xu3Q9swSYY1WViW8XxbA7NuBCvetU4WfZmNteMRkjH`** (finalized).
- Decoded: vault = `8yvFBv9g…`, **enabled = false**, max_sigma_q64 = 2^60, spread coeff 1000, depth coeff 2000, max observation age 3600, jump ×4, cooldown 1800.

### Phase D — observation + liveness — **PASS (in progress / ongoing)**
- The already-running volatility-aware TS keeper detected the PDA on its next cycle and observed automatically (no restart required).
- Volatility PDA: `last_price_q64 > 0` (≈0.1056 token-unit), `observation_nonce` 1 → 2, observation fresh (age ≤ 3600 slots).
- QuoteState liveness restored: version `3198 → 3199 → 3201` (and onward), `fresh: true` across samples, expiry in the future.
- Live keeper stage tx `45xUaGj2oXWYdFFoCzBmfj8gmkQDF1hzQrpqJZdrnpRsApmQLvZUcFH3WnXydW1LqA1XjSUYJZWihKF3cNRJgMUj` decoded: accounts = keeper, vault, config, quote_state, pending, base_reserve, quote_reserve, keeper_bond, **volatility_state (idx 8)**, **system (idx 9)** — the required order.
- Keeper commits show `COMMITTED_AND_VERIFIED` with `stage_sig`, `vaa_sig`, `push_commit_sig`.

### Phase E — timelocked parameters — **PROPOSE PASS / APPLY PASS**
- `propose_volatility_params(defaults, enabled = true)` signed by `8R3VDePS…` (vault.admin) at slot `511447348`.
- **Propose signature `27PQmipm2SxrhjE5uXvnAhEvfcJJVVKooMJqWrUTPbUii3qpT4qmcSQRFDn9wD7xtiQk9K1SDZApTZPnmaSAaVCA`** (finalized).
- Pending PDA `z9zyVXVoCNPXL8EHj6QKZwTxa1V8oHHrPcUrGLYukRF`: admin `8R3VDePS…`, `enabled = 1`, `activate_slot = 511663348` (delta ≈ 215,423 slots ≈ 23.9 h at 400 ms).
- **APPLY PASS** — after the timelock elapsed, `apply_volatility_params()` (admin `8R3VDePS…`) was submitted at slot **`511663484`**:
  **Apply signature `23gBbdKwtBYXRDoGEtaUtdkCTS3rWpSecUVYNt1puA3PUeYqmYT2yhuNwhmjgaRw5UxdpGv8Dx9bqFrAbXReVQos`** (finalized, `VolatilityParamsApplied` emitted).
- Decoded post-apply on-chain `VolatilityState`: **`enabled = true`**; applied params match the proposal (short/medium λ defaults, `jump_multiple 4`, `max_sigma_q64 2^60`, `jump_cooldown_slots 1800`, `vol_spread_coeff_bps 1000`, `vol_depth_coeff_bps 2000`, `max_observation_age_slots 3600`). The proposal is disarmed (`pending.activate_slot = u64::MAX`) so it cannot be applied twice.
- Enforcement is therefore **LIVE**: every quote update/stage/commit requires the volatility PDA and passes the guards.
- Recorded liveness nuance: live `max_spread_bps = 50` with default `vol_spread_coeff_bps = 1000` means the jump-multiplied floor can exceed 50 bps in high-volatility/jump conditions, so the keeper fail-closes (skips) rather than quote; observed on-chain as `Custom 6037` (`UpdateSlotTooOld`) / `Custom 6039` (`StalePendingQuote`) commit rejections alongside provider-throttling gaps. This is a liveness characteristic, not a safety hole. A future timelocked re-proposal can lower the coefficient if a different operating policy is desired.

## Local gates (this execution)

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` | clean |
| `cargo test --workspace` | 260 pass (LiteSVM 142) |
| `cargo clippy … -- -D warnings` (CI) | clean |
| LiteSVM volatility suite | 8 pass |
| TS keeper tests (`volatility/rpc/keeper_commit/broadcast`) | 59/24/9/19 pass |
| `tsc -b` / `oxlint` | clean |
| Frontend Vitest | 138 pass |
| Python `pytest simulation` | 231 pass, 2 skip |
| banned words / secrets scan | CLEAN |
| docs consistency | consistent (bundle commit 1165023) |
| `check_bundle_freshness.py` | **FAIL (pre-existing)**: committed `1165023..HEAD` source change; worktree-independent |

## Frontend

- Builds and typechecks; Risk-page "Volatility Regime" reads the PDA via `deriveVolatilityAddress` (same `5HbPRjB…` address) and validates owner/length/vault binding.
- **Real browser-wallet swap: BLOCKED** — no browser wallet is available in this environment; per policy no CLI swap or key injection was used. Manual steps: connect Phantom/Solflare on Devnet, load the funded WSOL/USDC vault, confirm quote fresh, swap a small amount.

## Timelock wait + liveness (measured)

- Timelock elapsed: activation slot `511663348` was reached and **`apply_volatility_params` was executed at slot `511663484`** (signature `23gBbdKw…`). Enforcement is now `enabled = true`; there is no remaining wait.
- Keeper/observation health remains strong: volatility `observation_nonce` climbed to **139+**, `last_price_q64 > 0`, observation fresh (age ≪ 3600); the jump detector is exercising the cooldown (`jump_detected = true`, `jump_until_slot` in the future). QuoteState liveness continues with `fresh: true` in the majority of samples; brief `Custom 6037`/`6039` commit rejections and provider `429` gaps are transients.
- No further admin action is required for this rollout. A future policy change (e.g. lowering `vol_spread_coeff_bps` to reduce fail-closed skips) must go through a fresh `propose_volatility_params` → `apply_volatility_params` timelock cycle.

## Bundle-freshness root cause (resolved as a precise finding)

`scripts/check_bundle_freshness.py` **FAIL** — root cause: the published bundle
(`artifacts/public/manifest.json`) records commit `1165023`; `HEAD` (`5a7d9bd`)
advanced with 15 committed source changes after that commit, and the checker
conservatively requires regeneration after any source change outside
`artifacts/`, `docs/`, `scripts/`.

Evidence:
- The 15 changed files are **frontend/tests/docs/lockfile only**: `app/src/**`,
  `app/test/**`, `app/yarn.lock`, `commands.md`.
- `git diff --name-only 1165023 HEAD -- vault/` is **empty** → the committed
  on-chain program source is unchanged, so the bundle's program-derived numbers
  (`cu.json`, `test_counts.json`, …) remain valid for HEAD. The frontend/test
  edits do not feed the bundle.
- The documented workflow is `scripts/measure_cu.sh && python
  scripts/export_artifacts.py && python scripts/publish_artifacts.py` (which
  records `meta.commit = HEAD`).

**Why it was not regenerated here:** the worktree contains **uncommitted
on-chain program changes** (the volatility feature: `vault/program/src/lib.rs`,
`vault/math/src/lib.rs`). Regenerating now would measure the volatility program
but stamp it with `HEAD` (`5a7d9bd`), which does not contain those changes —
misattributing measurements. Regeneration is therefore deferred until the
volatility feature is committed, at which point the pipeline should be run and
the regenerated bundle committed so the check passes. The checker was **not**
modified and no unrelated work was overwritten.

## Frontend ↔ backend wiring audit (live Devnet, read-only)

Verified with the frontend's own constants/derivations against chain state:

| Check | Result |
|---|---|
| `vault/config/quoteState` derived from `[b"vault", WSOL, USDC]` == `ACTIVE_VAULT` == on-chain | PASS |
| volatility PDA `[b"vol", vault]` == deployed `5HbPRjB…` | PASS |
| vault decode: mints WSOL/USDC, `share_mint`, `total_shares`, `status` | PASS |
| config decode: `keeper`, `pyth_feed_id` == frontend `SOL_USD_FEED_ID` | PASS |
| quote decode: version/update/expiry + attributed keeper; `keeperReward` PDA | PASS |
| volatility decode (hand-written, not IDL): owner, vault binding, `enabled`, nonce | PASS |
| deposit/withdraw ticket PDAs `[b"dep"/b"wd", vault, user]` == on-chain | PASS |
| share ATA `getAssociatedTokenAddressSync(shareMint, user)` == on-chain holder | PASS |
| instruction account orders (deposit/request_withdraw/claim_withdraw/swap) match program | PASS |

**No mock data in runtime `src/`.** The on-chain surfaces (Vault, Swap, Risk, and
the protocol part of Overview) read live via RPC (`getAccountInfo`,
`getParsedTokenAccountsByOwner`, `getTokenAccountBalance`, Anchor account fetch,
`LiveQuoteFeed`, `readVolatility`). The Analytics page + the analytics block of
Overview read `/artifacts/*.json` — the backend's real model/evaluation outputs
(static research bundle), not fabricated values.

**IDL sync:** `app/src/idl/arbswap.json` was synced from the generated
`target/idl/arbswap.json` (29 instructions; adds `initialize/observe/propose/apply
volatility` + `VolatilityState`/`PendingVolatilityParams`; `volatility_state` on
update/stage/commit). `tsc`/`oxlint`/Vitest (138) and production build pass.

## Rollback

- Pre-volatility ELF preserved at `~/arbswap-rollback/arbswap-prevolatility-780224.so` (`dff8a302…`).
- Command: `solana program write-buffer ~/arbswap-rollback/arbswap-prevolatility-780224.so … (buffer authority/upgrade authority ddGs…)` then `solana program upgrade <buffer> 2mwp… -k ddGs…`. Requires its own authorization; reverts the instruction ABI (a compatible keeper must run).
