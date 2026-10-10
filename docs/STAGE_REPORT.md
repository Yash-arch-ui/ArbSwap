<!-- cu-scan: historical-snapshot -->
# STAGE_REPORT.md — ArbSwap principal-engineer run (S0–S5)

Consolidated report of the Stage 0–S5 run. Working branch **`main`** (per
instruction: no new branch, nothing pushed to main). Baseline tag
`p2-claim-align-v1` at `cc41f53`. Devnet and the frontend were **out of scope**
for this run.

**Gate status (final):** `cargo fmt --check` clean · `cargo clippy -D warnings`
(incl. program) clean · **132 Rust tests** · **172 Python tests** ·
`anchor build` OK · secrets scan clean.

---

## 1. Stage table

| Stage | Status | Commit | Summary |
|---|---|---|---|
| **S0** baseline & hygiene | **DONE** | `a1a1dd6` | tag; `docs/ANALYTICS.md` (last dangling link); `docs/PROGRESS.md`; simulator sanity guards + tests |
| **S1** math correctness | **DONE — no bug found** | `2cd69e1` | differential harness; suspected `div_rem` bug **not reproduced**; reachability statement |
| **S2** update_quote CU | **PARTIAL** | `43002b3` | single-division `base_capacity`: `update_quote` 68k→**48,296**, `swap` →**61,482**; 40k target unmet |
| **S3** breaker + keeper gaps | **DONE** | `b7e464e` | simulator edge tracker; 0 honest trips; defaults chosen; anchor-dev tightened |
| **S4** guard coverage | **DONE** | `6f2c50b` | 31-guard mutation table (all caught); full-action state machine |
| **S5** Phase-1 proof | **PARTIAL** | `61b3648` | pre-reg amendment 2; routed table; `HEADLINE.md` = Option 2; E8 not done |

---

## 2. S0 — baseline & hygiene

- Tag `p2-claim-align-v1` created at `cc41f53`.
- Versions: rustc/cargo 1.98.0, anchor-cli 1.1.2, solana-cli 4.1.2, python 3.12.3,
  node v24.10.0, anchor-lang/anchor-spl 1.2.1, pyth-solana-receiver-sdk 2.0.0,
  litesvm 0.16.0.
- `.gitignore` tracks all markdown; `docs/P1_PREREGISTRATION.md` and
  `docs/P1_RESULTS.md` present; last dangling link (`docs/ANALYTICS.md`) fixed.
- Secrets scan clean (`.ENV` untracked, no key files).
- **Simulator sanity guards** (`simulation/sim/guards.py`, wired in
  `engine.py`): initial price == oracle; runtime quoted-price band (tight for the
  vault, loose for a picked-off passive pool); non-negative/finite reserves;
  conservation reconstructed from the trade log + debited gas. Tests:
  `simulation/sim/test_sanity_guards.py`.

---

## 3. S1 — math correctness

- **Suspected `U256::div_rem` bug for >2-limb divisors: NOT REPRODUCED.**
- Harness: `vault/math/examples/wide_probe` (Rust) driven by
  `simulation/reference/test_wide_diff.py` (Python big integers), covering
  `mul_u128`, `div_rem`, `shl`, `shr`, `isqrt`, `mul_q64`, `div_q64`,
  `recip_q64`, `sqrt_q64`, `price_from_sqrt`.
- **Full run: 1,000,000 cases per operation + targeted edges** (3/4-limb
  divisors, top limb set, `a<b`, powers of two, `2^k−1`, exact multiples) →
  **zero mismatches**. CI runs 2,000/op.
- Direct probe of the exact deep-ladder values that were suspected (quotient
  `44,999,999`; `anchor_ladder` level `199,999,999`) is correct.
- **Reachability:** no wrong result found ⇒ no reachable bad case; no
  funds-moving impact. The earlier H2 note was a build/staleness artifact and is
  corrected in `docs/SECURITY_CHECKLIST.md` and `docs/SECURITY.md`.

---

## 4. S2 — update_quote compute reduction (PARTIAL)

### CU table (before → after)

| Instruction | before | after |
|---|---|---|
| `update_quote` | ≈68k (63–73k) | **48,296** |
| `swap` | ≈75k | **61,482** |
| `trip_breaker` | 12,377 | 12,377 |
| `deposit` / `request_withdraw` / `claim_withdraw` | 46–49k / ~20k / ~24k | unchanged |
| `bond_keeper` / `slash_keeper` / `claim_keeper_reward` | 25–26k / ~16k / ~14k | unchanged |
| `unbond_keeper` (queue/release) | 16,242 / 18,379 | unchanged |

### Profile by ablation

| Section | CU |
|---|---|
| account validation + Pyth verification + store + misc | ≈30k |
| ask `base_capacity` (6 U256 divisions) | ≈12k (after single-division) |
| bid `quote_capacity` (6 mul+shift) | ≈8k |
| level binding (24 `price_from_sqrt`) | ≈0 |
| keeper-bond PDA | ≈2k |

**Change landed:** `Level::base_capacity` uses one U256 division instead of two
(`floor(floor(x/lo)/hi) == floor(x/(lo·hi))`, verified by the S1 harness).

**Target ≤40k NOT met** (48,296). Dominant remaining cost is the ask
`base_capacity` U256 division plus the fixed account/Pyth validation. The
**reciprocal-verify redesign** (keeper supplies per-level reciprocal square
roots; program verifies with one multiplication and computes ask capacity by
multiply+shift like the bid side) is **deferred**: it changes the on-chain
`QuoteUpdate` payload, rounding semantics, keeper serialization, analytics and
account space. Documented in `docs/SECURITY_CHECKLIST.md` §3.

### Sample spread decomposition

`single 150·2⁶⁴ 1e9 1e9` → spread **7 bps** = floor **2** + vol **0** (σ=0) +
inventory **4** (`|q|≈9867`, coeff 5) + confidence **1** (1 bp) + age 0 + jump 0.

---

## 5. S3 — breaker evidence & keeper offline gaps

### Realized-edge breaker

- On-chain tracker: `QuoteState.oracle_price`, `realized_edge`,
  `edge_window_start_slot`; each `swap` accumulates the signed edge vs the
  stored verified oracle over a clock-rolled window and auto-pauses when
  `realized_edge < −max_edge_loss_bps · available_value`.
- **Bound restated:** realized loss at a trip ≤ **threshold + largest single-swap
  adverse edge** (the crossing swap is counted in full). The H3 test's
  `−168,531` vs threshold `150,000` is exactly this.

### Honest-replay trip rate (`python -m simulation.sim.edge_breaker`)

| Window | Regime | Latency (s) | Injected jump | Trips | Trades |
|---|---|---|---|---|---|
| W2 | mid-vol up | 1.0 | 0 | **0** | 588 |
| W3 | crash | 1.0 | 0 | **0** | 604 |
| W4 | trend | 1.0 | 0 | **0** | 596 |
| W5 | high-vol up | 1.0 | 0 | **0** | 602 |
| W6 | calm | 1.0 | 0 | **0** | 585 |
| W4 | trend | 1.0 | 50/100/300 bps | **0** | ~598 |
| W4 | trend | 0.2 / 4.0 | 0 | **0** | ~590 |

**Cause of every honest trip: none.** The tracker measures edge against the
**stored** oracle, and the honest keeper quotes around that same oracle, so
every fill earns the half-spread (edge ≥ 0). It therefore detects **keeper
mis-anchoring / a ladder stale relative to the stored oracle**, **not** oracle-lag
LVR (handled by spread/throttle/expiry). Consequence: **zero false positives**
on the real windows; the outage risk of a false trip is nil for an honest keeper.

### Chosen defaults

- `max_edge_loss_bps = 50` (0.5%): honest trips = 0; a keeper at
  `max_anchor_dev_bps = 100` trips within a few swaps.
- `max_anchor_dev_bps = 25` (tightened): the honest replay passes at **10/25/50**
  (`honest_keeper_passes_at_tight_anchor_dev`, because the honest keeper sets
  `anchor == oracle`, deviation 0); 25 bps bounds the worst-case per-update loss
  to `u·d·V = 0.5 × 0.0025 × V = 0.125% of V`.

### Keeper offline gaps

- `VolatilityState::update_with_dt`: time-normalised EWMA for non-1 s ticks
  (decay `λⁿ`, innovation `r²/n`). Test: `ewma_is_time_normalised`.
- `should_update` re-quotes on a volatility-regime (spread) or jump/throttle
  (depth) change. Test: `regime_change_triggers_an_update`.
- Replay and live share one `KeeperCore::step` path. Test:
  `keeper_core_is_deterministic`. Live RPC transport remains **NOT DONE**.

---

## 6. S4 — guard coverage

### Mutation table (31 guards, all caught)

Each guard relaxed, rebuilt, mapped test run, source restored (tree clean; no
mutated code committed). Two weak tests were strengthened with new tests
(`per_swap_size_cap_is_enforced`, `effective_bond_below_min_is_rejected`).

| Guard | Mutation | Test | Result |
|---|---|---|---|
| Pyth freshness | `max_staleness` → `u64::MAX` | `pyth_verification_rejects_untrusted_or_stale_updates` | caught |
| Pyth price==oracle | equality → `true` | `pyth_verification_rejects_untrusted_or_stale_updates` | caught |
| Pyth confidence | conf require → `true` | `rejected_wide_confidence_leaves_the_old_quote_to_expire` | caught |
| Ask capacity | drop require | `a_ladder_deeper_than_the_reserves_is_rejected` | caught |
| Bid capacity | drop require | `a_ladder_deeper_than_the_reserves_is_rejected` | caught |
| Bucket exclusion | gross `available_quote` | `buckets_are_excluded_from_available_reserves` | caught |
| Level↔anchor binding | drop require | `level_far_from_the_anchor_is_rejected` | caught |
| Reservation band | drop require | `reservation_outside_the_inventory_band_is_rejected` | caught |
| Anchor↔oracle | drop require | `anchor_far_from_the_oracle_is_rejected` | caught |
| Min spread | drop `>= min` | `a_zero_spread_quote_is_rejected` | caught |
| Expiry | `slot < expiry` → `true` | `expired_quote_always_rejects_swap` | caught |
| Slippage | drop `out >= min_out` | `swap_enforces_slippage_version_and_size` | caught |
| Per-swap size cap | drop `<= max_quote_size` | `per_swap_size_cap_is_enforced` | caught |
| Flow cap | drop require | `window_flow_cap_stops_one_sided_flow` | caught |
| Edge breaker | `realized_edge < -bound` → `false` | `malicious_keeper_edge_loss_trips_within_the_window` | caught |
| Withdraw-ticket seeds | drop seeds | `claim_withdraw_rejects_a_ticket_from_another_vault` | caught |
| Deposit-ticket seeds | drop seeds | `request_withdraw_rejects_a_deposit_ticket_from_another_vault` | caught |
| Reserve address | drop `address=` | `swap_rejects_a_reserve_from_another_vault` | caught |
| Share-mint binding | drop `address=` | `claim_withdraw_rejects_a_foreign_share_mint` | caught |
| Share-lock binding | drop `address=` | `claim_withdraw_rejects_a_foreign_share_lock` | caught |
| Config seeds | drop seeds | `swap_rejects_a_config_from_another_vault` | caught |
| Keeper-bond binding | drop seeds | `slash_keeper_rejects_a_bond_from_another_vault` | caught |
| Bond-vault binding | drop seeds | `slash_keeper_rejects_a_bond_vault_from_another_vault` | caught |
| Treasury binding | both owner constraints → `true` | `execute_fee_claim_rejects_a_non_treasury_destination` | caught |
| MIN_LIQUIDITY burn | burn amount → 0 | `first_depositor_inflation_loses_at_most_rounding` | caught |
| Unbond cooldown | drop timelock | `unbond_keeper_cooldown_and_release` | caught |
| Keeper allowlist | drop `keeper == config.keeper` | `keeper_can_be_rotated_via_the_timelock` | caught |
| min_bond gate | drop effective-bond require | `effective_bond_below_min_is_rejected` | caught |
| Admin-only | drop `admin == vault.admin` | `admin_only_controls_reject_non_admins` | caught |
| Timelock delay | drop `slot >= activate_slot` | `params_change_is_timelocked` | caught |
| Account space | halve `quote_state` space | `account_spaces_match_serialized_sizes` | caught |

**Not mutated (type-system, not a runtime guard):** Token-2022 rejection
(`Program<Token>`, `token_2022_accounts_are_rejected`); the inverse-sqrt
verification was not implemented.

### Fuzz / state machine

- `vault/math/tests/proptest.rs` (property tests) and the S1 differential harness.
- `state_machine_full_action_set_preserves_invariants`: random sequences of
  deposit, update_quote, buy/sell swap, trip, reset, unbond, asserting
  `reserves ≥ tracked liabilities` and share consistency after every action.

### Cross-vault account review

Full table in `docs/SECURITY_CHECKLIST.md` §1 (every account of every
instruction, with its negative substitution test).

---

## 7. S5 — Phase-1 proof (PARTIAL)

Pre-registration **Amendment 2 (2026-10-09)** fixes the Stage-5 protocol
(targets, windows, routed world, honesty cost, stress, E8, acceptance).

### Routed world (fresh, `python -m simulation.sim.router`, W1–W6 one-hour slices)

| Venue | Volume share | Fill share | 2s markout (bps) | Quiet half-spread (bps) |
|---|---|---|---|---|
| ArbSwap | **0.0%** | ~1–2% | +0.6 … +2.5 | ~2.0 |
| B1 passive | 0.3–0.4% | 16–18% | −0.3 … −18.6 | 3.7–13.3 |
| PropAMM-like | **99.6%** | ~81% | −0.6 … −2.3 | 0.4–0.9 |

- **ArbSwap loses the routed volume share** to a tight propAMM because its
  effective spread (~2 bps) is wider than the competitor's (~0.5–0.9 bps).
- ArbSwap's model markout is **positive** and better than B1's, but it is a
  **model output** on synthetic flow (F-08 calibration gap) and comes with ~0
  routed flow.
- The competitor's **negative** model markout contradicts the paper's profitable
  propAMM — the calibration gap, not a claim about real propAMMs.

### Decision rule

| Option | Status |
|---|---|
| Option 1 — "beats passive pools" | **NOT shown** (model outputs + calibration gap; ~0 routed share; no CIs excluding zero on real flow) |
| **Option 2 — open / transparent / honest / bounded active liquidity** | **CHOSEN (default headline)** |
| Option 3 — "beats propAMMs" | **NEVER claimed** |

`docs/HEADLINE.md` records the single headline claim, its evidence and its
limits. `docs/METHODOLOGY.md` records limits, losing/zero-share regimes, sources,
calibration, and reproduction commands.

### Not done in S5

- **E8** (real Solana pool quote/fill data): **NOT DONE** — no data source
  available ⇒ "honest by construction; measured in simulation; no measured claim
  about competitors."
- No fresh full-study re-run (existing `docs/P1_RESULTS.md` used as model output).
- One-command `scripts/p1_all.sh` exists but was not re-verified end-to-end here.

---

## 8. Claims ledger (summary)

Full ledger: `docs/CLAIMS.md` (13 claims, status + evidence + limits).

| # | Claim | Status |
|---|---|---|
| 1 | Honest execution (`min_out`/`min_version`) | SUPPORTED |
| 2 | Bounded keeper (anchor/spread/capacity/flow/slot) | SUPPORTED |
| 3 | Safe failure on keeper/oracle failure | SUPPORTED |
| 4 | Fair pro-rata accounting | SUPPORTED |
| 5 | Bonded/open keepers | PARTIAL (MVP allowlists `config.keeper`) |
| 6 | Two-sided quoting | SUPPORTED |
| 7 | Realized-loss breaker | SUPPORTED (on-chain + simulator) |
| 8 | CU numbers (honest) | SUPPORTED (measurement; not cheap) |
| 9 | Min spread 2 bps | SUPPORTED (by design not competitive with sub-bp propAMMs) |
| 10 | LVR reduction / positive markout | SIMULATION ONLY — UNPROVEN |
| 11 | Devnet / live keeper | NOT CLAIMED |
| 12 | Independent audit | NOT CLAIMED (self-review only) |
| 13 | Frontend / demo | NOT CLAIMED |

---

## 9. Confirmations

- **No secrets committed.** Secrets scan clean; `.ENV` untracked; no key files.
- **Nothing pushed to main. No new branch created.**
- **Devnet and the frontend were not touched.**
- **No banned wording** used as a claim ("exploit-free", "audited", "safe",
  "cheap", "guaranteed", "risk-free", "beats propAMMs", "as complete as
  Uniswap", any APY/return projection). Operative wording: *no known issues in
  self-review, independent audit pending.*

---

## 10. Remaining open items

- `update_quote` ≤40k CU target unmet (48,296); reciprocal-verify redesign
  deferred pending approval.
- E8 (real Solana pool data) not done.
- Independent external audit pending.
- Live keeper RPC transport NOT DONE.
- The P1 value claim (Option 1) remains unproven; F-08 calibration gap open.
- `U256::div_rem` suspicion resolved (no bug) — recorded for the record.
