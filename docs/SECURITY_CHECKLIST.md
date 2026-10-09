# SECURITY_CHECKLIST.md

Phase 2 (on-chain program) account-binding and instruction audit.

**Status: same-agent self-review, NOT an independent audit.** The operative claim
is: **"no known issues in self-review; independent audit pending."** Do not write
"exploit-free", "audited", or "as complete as Uniswap".

Test names below are LiteSVM tests in `vault/program/tests/`.

Account validation in Anchor happens before the instruction body
(`try_accounts`), so every "substitution rejected" test proves the binding fires
at the account layer.

Legend for bindings: **PDA** = seeds constraint; **addr** = `address = vault.*`;
**own** = token `owner`/`mint` constraint; **has_one** = stored-key equality
(equivalent, expressed as `address`/seed here); **body** = checked in the handler.

## 1. Account-binding table (every account of every instruction)

| Instruction | Account | Binding | Negative test |
|---|---|---|---|
| `initialize_program` | `admin` | Signer | — |
| | `program_config` | PDA `[b"program"]`, `init` | `initialize_program_is_one_time` |
| | `system_program` | program id | — |
| `initialize_vault` | `admin` | Signer + body `program_config.admin == admin` | `a_non_admin_cannot_initialize_a_vault`, `only_the_program_admin_can_initialize_a_vault` |
| | `program_config` | PDA `[b"program"]` | (above) |
| | `vault` | PDA `[b"vault", base_mint, quote_mint]`, `init` | derives from the mint pair, so a squatter cannot pre-empt |
| | `config` | PDA `[b"config", vault]` | — |
| | `quote_state` | PDA `[b"quote", vault]` | — |
| | `base_mint` | `address = params.base_mint` | `initialize_vault` param checks |
| | `quote_mint` | `address = params.quote_mint` | (above) |
| | `base_reserve`/`quote_reserve` | `init`, `token::mint = *_mint`, `token::authority = vault` | — |
| | `share_mint` | `init`, `mint::authority = vault` | — |
| | `share_lock` | `init`, `token::mint = share_mint`, `token::authority = vault` | — |
| `deposit` | `user` | Signer | — |
| | `vault` | (bound via `config`/reserve addresses below) | `swap_rejects_a_config_from_another_vault` pattern |
| | `config` | PDA `[b"config", vault]` | — |
| | `base_reserve`/`quote_reserve` | `address = vault.*` | `swap_rejects_a_reserve_from_another_vault` |
| | `share_mint` | `address = vault.share_mint` | `claim_withdraw_rejects_a_foreign_share_mint` |
| | `share_lock` | `address = vault.share_lock` | `claim_withdraw_rejects_a_foreign_share_lock` |
| | `user_base`/`user_quote` | `mint == vault.*`, `owner == user` | `request_withdraw_rejects_a_foreign_share_account` |
| | `user_shares` | `mint == vault.share_mint`, `owner == user` | (above) |
| | `deposit_ticket` | PDA `[b"dep", vault, user]`, `init_if_needed` | `request_withdraw_rejects_a_deposit_ticket_from_another_vault` |
| `request_withdraw` | `user` | Signer | — |
| | `vault` | (bound via `share_lock`/tickets below) | — |
| | `share_lock` | `address = vault.share_lock` | `claim_withdraw_rejects_a_foreign_share_lock` |
| | `deposit_ticket` | PDA `[b"dep", vault, user]` | `request_withdraw_rejects_a_deposit_ticket_from_another_vault` |
| | `user_shares` | `owner == user`, `mint == vault.share_mint` | `request_withdraw_rejects_a_foreign_share_account` |
| | `withdraw_ticket` | PDA `[b"wd", vault, user]`, `init_if_needed` | `claim_withdraw_rejects_a_ticket_from_another_vault` |
| `claim_withdraw` | `user` | Signer | — |
| | `vault` | (bound via reserve/mint/lock/ticket below) | — |
| | `base_reserve`/`quote_reserve` | `address = vault.*` | `swap_rejects_a_reserve_from_another_vault` |
| | `share_mint` | `address = vault.share_mint` | `claim_withdraw_rejects_a_foreign_share_mint` |
| | `share_lock` | `address = vault.share_lock` | `claim_withdraw_rejects_a_foreign_share_lock` |
| | `withdraw_ticket` | PDA `[b"wd", vault, user]` + `owner == user` (**fixed p2-T1**) | `claim_withdraw_rejects_a_ticket_from_another_vault` |
| | `user_base`/`user_quote` | `owner == user`, `mint == vault.*` | (owner/mint constraints) |
| `crank_epoch` | `vault` | mut | — |
| | `config` | PDA `[b"config", vault]` | — |
| `update_quote` | `keeper` | Signer + body `keeper == config.keeper`; bond when `min_bond > 0` | `keeper_can_be_rotated_via_the_timelock`, `update_quote_requires_a_keeper_bond` |
| | `vault` | (bound via `config`/`quote_state`) | — |
| | `config` | PDA `[b"config", vault]` | `swap_rejects_a_config_from_another_vault` |
| | `quote_state` | PDA `[b"quote", vault]` | — |
| | `price_update` | `Account<PriceUpdateV2>` (owner = Pyth receiver) + feed/freshness/price/conf checks | `pyth_account_owner_must_be_the_receiver_program`, `pyth_verification_rejects_untrusted_or_stale_updates`, `anchor_far_from_the_oracle_is_rejected` |
| | `keeper_bond` | `UncheckedAccount`; PDA + amount verified only when `min_bond > 0` | `update_quote_requires_a_keeper_bond` |
| `swap` | `trader` | Signer | — |
| | `vault` | (bound via `config`/`quote_state`/reserves) | — |
| | `config` | PDA `[b"config", vault]` | `swap_rejects_a_config_from_another_vault` |
| | `quote_state` | PDA `[b"quote", vault]` | — |
| | `base_reserve`/`quote_reserve` | `address = vault.*` | `swap_rejects_a_reserve_from_another_vault` |
| | `trader_base`/`trader_quote` | `owner == trader`, `mint == vault.*` | (owner/mint constraints) |
| `trip_breaker` | `vault` | mut | — |
| | `quote_state` | PDA `[b"quote", vault]` | state-only breaker design (p2-T4) |
| `reset_breaker` | `admin` | Signer + body `admin == vault.admin` | `admin_only_controls_reject_non_admins` |
| | `vault` | mut | — |
| `wind_down` | `admin` | Signer + body `admin == vault.admin` | `wind_down_is_admin_only_and_pauses_quotes` |
| | `vault` | mut | — |
| `set_params` | `admin` | Signer + body `admin == vault.admin` | `admin_only_controls_reject_non_admins` |
| | `vault` | PDA `[b"vault", base_mint, quote_mint]` | — |
| | `pending_config` | PDA `[b"pending", vault]`, `init_if_needed` | — |
| `apply_params` | `admin` | Signer + body admin/pending-admin + timelock | `params_change_is_timelocked` |
| | `vault` | PDA `[b"vault", ...]` | — |
| | `config` | PDA `[b"config", vault]` | — |
| | `pending_config` | PDA `[b"pending", vault]` | — |
| `bond_keeper` | `keeper` | Signer | — |
| | `vault` | mut | — |
| | `quote_mint` | `address = vault.quote_mint` | — |
| | `keeper_quote` | `owner == keeper`, `mint == vault.quote_mint` | — |
| | `bond_vault` | PDA `[b"bond", vault]`, `token::authority = vault` | `slash_keeper_rejects_a_bond_vault_from_another_vault` |
| | `keeper_bond` | PDA `[b"keeper", vault, keeper]` | `slash_keeper_rejects_a_bond_from_another_vault` |
| `unbond_keeper` | `keeper` | Signer | — |
| | `vault` | mut | — |
| | `config` | PDA `[b"config", vault]` | — |
| | `quote_mint` | `address = vault.quote_mint` | — |
| | `keeper_quote` | `owner == keeper`, `mint == vault.quote_mint` | — |
| | `bond_vault` | PDA `[b"bond", vault]` | `unbond_keeper_rejects_a_bond_from_another_vault` |
| | `keeper_bond` | PDA `[b"keeper", vault, keeper]` | `unbond_keeper_rejects_a_bond_from_another_vault` |
| `slash_keeper` | `admin` | Signer + body `admin == vault.admin` | `admin_only_controls_reject_non_admins` |
| | `vault` | mut | — |
| | `quote_reserve` | `address = vault.quote_reserve` | — |
| | `keeper` | `UncheckedAccount` (only derives the bond PDA) | — |
| | `keeper_bond` | PDA `[b"keeper", vault, keeper]` | `slash_keeper_rejects_a_bond_from_another_vault` |
| | `bond_vault` | PDA `[b"bond", vault]` | `slash_keeper_rejects_a_bond_vault_from_another_vault` |
| `claim_keeper_reward` | `keeper` | Signer + body `keeper == config.keeper` | — |
| | `vault` | (bound via `config`/reserves) | — |
| | `config` | PDA `[b"config", vault]` | — |
| | `base_reserve`/`quote_reserve` | `address = vault.*` | — |
| | `keeper_base`/`keeper_quote` | `owner == keeper`, `mint == vault.*` | — |
| `propose_fee_claim` | `admin` | Signer + body `admin == vault.admin`; `kind != Insurance` | `insurance_bucket_cannot_be_claimed_to_treasury` |
| | `vault` | PDA `[b"vault", ...]` | — |
| | `pending_claim` | PDA `[b"claim", vault]`, `init_if_needed` | — |
| `execute_fee_claim` | `admin` | Signer + body admin/pending-admin + timelock | `fee_claim_is_timelocked_and_pays_only_the_fixed_treasury` |
| | `vault`, `config` | PDA-bound | — |
| | `base_reserve`/`quote_reserve` | `address = vault.*` | — |
| | `treasury_base`/`treasury_quote` | `owner == config.treasury`, `mint == vault.*` | `execute_fee_claim_rejects_a_non_treasury_destination` |

**Audit result:** the only unbound account found was `ClaimWithdraw.withdraw_ticket`
(P2-F01), fixed in commit `p2-T1`. Every other account is bound by PDA seeds,
`address`, or mint/owner constraints.

## 2. Per-instruction checks (signer / owner / PDA / math)

- **Signers:** every authority account is `Signer` (`admin`, `user`, `keeper`,
  `trader`); `trip_breaker` and `crank_epoch` are intentionally permissionless.
- **Owner checks:** every token account is `Account<TokenAccount>` (owner = token
  program) or `Mint`; the Pyth account is `Account<PriceUpdateV2>` (owner = Pyth
  receiver program, enforced by Anchor).
- **Token-2022:** rejected via `Program<Token>`; `token_2022_accounts_are_rejected`.
- **PDA/canonical bumps:** seeds use Anchor bump verification; no attacker-supplied
  PDA. Withdraw/deposit tickets, keeper bonds, pending config/claim are seeded.
- **Math:** all arithmetic checked; `arb_math` fixed-point; rounding favors the
  vault; golden + property tests in `vault/math`.
- **CPI:** token program only; no arbitrary CPI; no `remaining_accounts`.

## 2a. Circuit-breaker design (p2-T4)

`trip_breaker` is permissionless but **state-only**: it reads the stored
`QuoteState` and `Config` and trips when (a) the stored quote has expired, or
(b) the stored `oracle_publish_time` is older than
`max_staleness_seconds × STALENESS_TRIP_MULTIPLE` (=2) by the clock.
It **never accepts a caller-supplied `PriceUpdateV2`**, because an attacker can
present an old-but-valid update for the same feed to pause the vault (griefing);
`no_trip_with_a_stale_foreign_account` shows the extra account is ignored.
Evidence-based conditions (fresh oracle with wide confidence, volatility flag)
are evaluated inside `update_quote`; a rejection does not pause the vault, it
leaves the previous quote to expire (safe failure), tested by
`rejected_wide_confidence_leaves_the_old_quote_to_expire`. `reset_breaker` is
admin-only.

## 2b. Keeper unbond (p2-T5)

`unbond_keeper(amount)` is two-phase: the first call queues `amount` and sets
`unbond_ready_slot = now + config.unbond_cooldown_slots`; a second call after the
cooldown releases `min(unbond_amount, bond)` and resets the pending state. The
admin can `slash_keeper` during the cooldown, which reduces the eventual
release. While an unbond is pending, `update_quote` uses the **effective bond**
(`bond − unbond_amount`), so a keeper that releases below `min_bond` can no
longer quote (quoting deactivates). Rewards remain claimable. Tests:
`unbond_keeper_cooldown_and_release`, `unbond_below_min_bond_deactivates_quoting`,
`slash_during_unbond_reduces_the_release`,
`unbond_keeper_rejects_a_bond_from_another_vault`.

## 2c. Guard mutation check (h5)

Each guard was temporarily relaxed, the program rebuilt, and the mapped test run.
Every mutation was **caught** (the test failed). No mutated code was committed
(the tree was restored after each; `git diff` clean). Method: `anchor build
--ignore-keys` + the named test; a mutation that left the test passing would be
a test weakness.

| Guard | Mutation (guard relaxed) | Test that caught it | Result |
|---|---|---|---|
| T1 withdraw-ticket seeds | remove `seeds=[b"wd",vault,user]` binding | `claim_withdraw_rejects_a_ticket_from_another_vault` | caught |
| T1b reserve address | drop `address=vault.base_reserve/quote_reserve` on `Swap` | `swap_rejects_a_reserve_from_another_vault` | caught |
| T2 min spread | `half_spread >= min` → `<= max` only | `a_zero_spread_quote_is_rejected` | caught |
| T3 ask capacity | delete the ask `base_capacity ≤ u·avail_base` require | `a_ladder_deeper_than_the_reserves_is_rejected` | caught |
| T3 buckets excluded | use gross quote reserve (drop bucket subtraction) | `buckets_are_excluded_from_available_reserves` | caught |
| F-04 anchor↔oracle | delete the `AnchorTooFarFromOracle` require | `anchor_far_from_the_oracle_is_rejected` | caught |
| T4 stored staleness | `age > 2·max_staleness` → `> i64::MAX` | `trip_breaker_on_stored_staleness` | caught |
| H4 unbond amount | delete `amount == unbond_amount` | `unbond_release_wrong_amount_is_rejected` | caught |
| H3 edge breaker | `realized_edge < -bound` → `false` | `malicious_keeper_edge_loss_trips_within_the_window` | caught |
| T7 expiry | `slot < expiry_slot` → `true` | `expired_quote_always_rejects_swap` | caught |
| T7 slippage | delete `out >= min_out` | `swap_enforces_slippage_version_and_size` | caught |
| T7 flow cap | delete the window flow-cap require | `window_flow_cap_stops_one_sided_flow` | caught |
| T7 account space | halve the `quote_state` space expression | `account_spaces_match_serialized_sizes` | caught |

Note: the first attempt at the bucket mutation relaxed `available_base`, but
`buckets_are_excluded_from_available_reserves` exercises the **quote** bucket;
re-targeting `available_quote` was caught. This is a mutation-targeting lesson,
not a test weakness.

### S4.1 — extended mutation coverage (every guard)

All guards relaxed, rebuilt, mapped test run; every one **caught**. Two weak
tests were strengthened with new tests (`per_swap_size_cap_is_enforced`,
`effective_bond_below_min_is_rejected`). No mutated code committed (tree clean).

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
| Per-swap size cap | drop `<= max_quote_size` | `per_swap_size_cap_is_enforced` (new) | caught |
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
| min_bond gate | drop effective-bond require | `effective_bond_below_min_is_rejected` (new) | caught |
| Admin-only | drop `admin == vault.admin` | `admin_only_controls_reject_non_admins` | caught |
| Timelock delay | drop `slot >= activate_slot` | `params_change_is_timelocked` | caught |
| Account space | halve `quote_state` space | `account_spaces_match_serialized_sizes` | caught |

**Not mutated (covered by type system, not a runtime guard):** Token-2022
rejection is the `Program<Token>` type (`token_2022_accounts_are_rejected`);
the inverse-sqrt verification was not implemented (S2 reciprocal redesign
deferred).

## 3. Compute units (LiteSVM, program instruction only)

Measured on this branch; re-measured in `measure_instruction_compute_units`
(run with `-- --nocapture`). Full before/after table is in
`docs/AUDIT_FULL.md`; the reconciled table is in `TARGETIDEATASKS_P2.md`.

Single source of truth: `simulation/data/results/cu.json` (regenerated by
`measure_instruction_compute_units`; the C1.1 exporter reads it). Current
measurement (2026-10-09, LiteSVM):

| Instruction | CU |
|---|---|
| `update_quote` | **51,296** |
| `update_quote` (wide-conf rejected) | 17,189 |
| `swap` | **61,513** |
| `trip_breaker` | 12,377 |
| `deposit` | 46,533 |
| `request_withdraw` | 19,920 |
| `claim_withdraw` | 24,189 |
| `crank_epoch` | 5,182 |
| `bond_keeper` / `slash_keeper` / `claim_keeper_reward` | 26,541 / 14,153 / 14,026 |
| `unbond_keeper` (queue / release) | 16,242 / 18,379 |

`update_quote` exceeds the keeper's former 60k limit, so
`MAX_UPDATE_COMPUTE_UNITS` is 80,000. All instructions remain inside the
200,000 CU transaction default. We do **not** claim a "cheap" update.

### h2 — update_quote profile and the <=40k target

Profiled by ablation (LiteSVM, two-sided ladder, 12 levels):

| Section | CU | How measured |
|---|---|---|
| account validation + Pyth verification + store + misc | ≈30k | full minus the capacity loops |
| **ask `base_capacity` (6 U256 divisions)** | **≈23k** | remove the ask capacity loop |
| bid `quote_capacity` (6 U256 mul+shift) | ≈8k | remove the bid capacity loop |
| level band binding (24 `price_from_sqrt`) | ≈0 | remove the binding loop |
| keeper-bond PDA check | ≈2k | bonded vs unbonded |

**Target <=40k is NOT met** (measured **51,296 CU**, `cu.json`). The remaining dominant cost is the ask-side
`base_capacity` (`floor(L·Δ/(lo·hi))`, a 256-bit division per level), on top of
the fixed account-validation + Pyth verification (~30k) that the program cannot
remove without dropping the on-chain oracle check.

**Proposed design change (WAITING for approval; semantics change).** Validate
capacity **coarsely** at update time and enforce the **exact** consumption cap at
swap time:
- update time: require the *lower-cost* per-side `quote_capacity` sums
  (`Σ L·Δ/2¹²⁸`, no 256-bit division) ≤ `utilization × value` of the reserve, so
  an over-deep ladder is still rejected;
- swap time: the existing `walk_ladder` `remaining != 0` check plus the token
  transfer already hard-cap the actual outflow to the reserve, so no swap can
  pay out more than the vault holds.
This removes the 6 ask divisions (~23k) and would land `update_quote` near the
30k stretch target. It changes the *update-time* guarantee from exact base
capacity to exact value capacity, so it needs sign-off.

**Correction (S1):** the earlier note that a single-U256-divisor `base_capacity`
"silently returned wrong values" was a **false alarm**. The Stage-1 differential
harness (`simulation/reference/test_wide_diff.py`, 1,000,000 cases per operation
plus 3/4-limb-divisor edges) and a direct probe of the exact deep-ladder values
both show `U256::div_rem` is correct, and re-applying the single-division form
keeps `a_ladder_deeper_than_the_reserves_is_rejected` and
`buckets_are_excluded_from_available_reserves` green. The H2 measurement was a
build/staleness artifact. The single-division form is mathematically equal
(`floor(floor(x/lo)/hi) == floor(x/(lo·hi))`) and is a legitimate S2 optimization.
