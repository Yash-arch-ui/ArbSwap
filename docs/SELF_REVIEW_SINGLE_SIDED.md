# SELF_REVIEW_SINGLE_SIDED.md — line-by-line self-review (Task 6 gate)

**Status:** same-agent self-review of the single-sided change. This is **not an
independent audit**; independent audit is pending. **No known issues** were found
in this review.

**Scope:** the diff `pre-single-sided..HEAD` to `vault/program/src/lib.rs`
(adds `deposit_single` / `claim_withdraw_single` and extracts shared helpers),
plus the added test files. `pre-single-sided` is the `volatility` build deployed
on devnet (`42eeac64…`).

**Method:** read the extracted helper bodies against the removed lines in the
diff; confirm the existing instruction tests are **unmodified and green**;
confirm the account layouts are unchanged; run the independent Python differential
(600 vectors) and the 100,000-case brute-force differential; read each new
instruction top to bottom and check every arithmetic, authority and accounting
step.

---

## 1. Layout / compatibility (no Config, QuoteState or Vault change)

- `git diff pre-single-sided..HEAD -- vault/program/src/lib.rs` shows **no change**
  to `struct Config`, `struct QuoteState` or `struct Vault`, and no new account
  type. Only new account contexts (`DepositSingle`, `ClaimWithdrawSingle`), new
  events and new `#[cfg(test)]` items are added.
- `CURRENT_QUOTE_STATE_LEN` stays `897` (lib.rs:37); the deployed account is 897
  bytes and is not migrated.
- New contexts reuse existing account types only (`DepositTicket`,
  `WithdrawTicket`, `KeeperReward`) with their existing spaces
  (`8+32+8+8+1`); no new rent-bearing account.
- ⇒ the upgrade is a **drop-in code upgrade**: no account resizing, no migration,
  no discriminator change.

## 2. Extracted helpers (existing `swap` behaviour must be identical)

Each helper is the verbatim body removed from `swap` (see the removed-lines diff),
re-parameterised to take `&Config` / `&QuoteState` instead of `ctx.accounts`:

| Helper | Extracted from | Correctness argument |
|---|---|---|
| `charge_fee` (lib.rs:3669) | `swap`'s fee block | `arb_math::fee_amount` = `ceil(amount·bps/10_000)`; `net = amount - fee` via `checked_sub`. Same function, same order. |
| `fee_split` (3677) | `swap`'s bucket split | Three independent floor divisions by `insurance_bps`/`keeper_bps`/`protocol_bps`. Identical expressions. |
| `walk_committed_ladder` (3686) | `swap`'s ladder walk | Picks `ask_levels` for `BuyBase`, `bid_levels` for `SellBase`; requires `remaining == 0`. Same `MathLevel` mapping and the same `CapacityExceeded` error. |
| `credit_fee_buckets` (3709) | `swap`'s bucket credit | `BuyBase` credits quote buckets + `keeper_reward.quote`; `SellBase` credits base buckets + `keeper_reward.base`; all `checked_add`. Identical. |
| `apply_flow_cap` (3761) | `swap`'s rolling-window flow cap | Same roll-over predicate, same `mul_div_floor(base_reserve·max_flow_bps, 10_000)`, same `FlowCapExceeded` bound, same signed `flow_n` update. |
| `apply_edge` (3812) | `swap`'s h3 realized-edge tracker | Same oracle-edge formula, same window roll, same `max_edge_loss_bps` loss bound and same `PAUSED` + `EdgeBreakerTripped` emission. |

**Proof of equivalence:** the six pre-existing LiteSVM suites (and the whole
`cargo test --workspace`) are **byte-for-byte unmodified** (`git diff
pre-single-sided..HEAD -- vault/program/tests/` touches only the two new
single-sided files) and pass. Any behavioural drift in the extraction would fail
those suites.

## 3. New plan functions (pure, no state)

- `single_eval` (3880): charges the fee on the swapped notional `s`, walks the
  ladder for `s_net` (returns `None` if the ladder cannot absorb or if the
  post-swap net reserve would be ≤ 0), then computes the vault-favouring
  proportional floors `db·S/Bnet'` and `dq·S/Qnet'` with `checked_mul/checked_div`.
  `shares = min(...)`; `diff = by_base - by_quote`. `SellBase` swaps base→quote
  (walks bid), `BuyBase` swaps quote→base (walks ask) — matching `swap`'s side
  convention. `s = 0` is always feasible and yields `shares = 0`.
- `solve_deposit_single` (3941): ≤ 64-step bisection on the monotone `diff(s)`
  (decreasing for `SellBase`, increasing for `BuyBase`), then evaluates the three
  integers `{lo-1, lo, lo+1}` and returns the maximum-`shares` plan. Monotonicity
  guarantees the `min` of an increasing and a decreasing function is maximised at
  the crossing, so comparing the neighbours is a complete search over the
  crossing. Returns `CapacityExceeded` only when no neighbour is feasible (a
  `BuyBase` whose balance point lies beyond the ladder depth).

## 4. `deposit_single` (lib.rs:741)

Line-by-line:

1. `vault.status == ACTIVE` — same pause gate as every money path.
2. `clock.slot < quote_state.expiry_slot` and `quote_state.keeper != default` —
   the internal conversion trades the committed quote, so a **fresh, attributed**
   quote is required (unlike two-sided `deposit`, which marks at net reserves).
3. Idempotent `keeper_reward` attribution identical to `swap`; mismatched
   attribution is rejected.
4. `amount_in ∈ (0, max_quote_size]` — the same size bound `swap` enforces.
5. `total_shares > 0` — the internal conversion needs a funded ladder; a
   first-depositor cannot use the single-sided path (documented deviation D-016).
6. Net reserves computed net of the fee buckets, `> 0` required.
7. `solve_deposit_single(...)` computes the plan; `db, dq, swap_out, shares` must
   all be `> 0`; `min_shares` / `min_swap_out` slippage bounds enforced **before**
   any transfer.
8. **One** transfer of the full `amount_in` from the input-side ATA to the
   reserve (via `base_transfer_ctx` / `quote_transfer_ctx`). The swapped notional
   plus its fee stay in the reserve; the fee goes to the buckets.
9. `credit_fee_buckets` credits `plan.fee` on the input side.
10. `apply_flow_cap` counts the internal swap's base leg and output — identical
    bounds to `swap`.
11. `apply_edge` reads the post-transfer available reserves and applies the same
    realized-loss breaker.
12. Mints `plan.shares` to the user and increases `total_shares` with `checked_add`.
13. Writes the `DepositTicket` (`activate_slot = slot + warmup_slots`), reusing
    the same warm-up mechanism as two-sided `deposit`.
14. Emits `DepositSingleEvent` with `swap_in`, `swap_out`, `fee`,
    `base_deposited`, `quote_deposited`, `shares`.

**Conservation:** `amount_in = db + dq + fee` on the input side, and the reserve
gains exactly `amount_in` (`db + s` remain as deposit notional; `s_net` + `out`
are the swap; `fee` is bucket-credited). `shares` uses the vault-favouring floors,
so the new shares never dilute existing LPs (proved by
`deposit_single_does_not_dilute_existing_lp_value`).

## 5. `claim_withdraw_single` (lib.rs:902)

1. Same `ACTIVE`, fresh-attributed-quote and keeper-reward gates as `deposit_single`.
2. `withdraw_ticket.epoch <= vault.epoch` — the same epoch gate as `claim_withdraw`.
3. `total > 0`, `shares > 0`; pro-rata floors `base_out`/`quote_out` are
   **identical** to `claim_withdraw`.
4. `side` names the payout token: `BuyBase` pays base (converts the unwanted
   quote via the ask ladder); `SellBase` pays quote (converts base via the bid
   ladder) — the documented withdraw convention (opposite of the deposit input
   convention, matching the design §1.2).
5. `charge_fee` then `walk_committed_ladder` on `swap_net`; if the ladder cannot
   absorb the unwanted leg, the instruction reverts with `CapacityExceeded`
   **before any state write or burn**, leaving the ticket intact
   (`claim_withdraw_single_capacity_failure_leaves_ticket_intact`).
6. `payout = wanted + converted` with `checked_add`; `payout <= side_available`
   (capacity) and `payout >= min_out` (slippage) are enforced before writes.
7. `credit_fee_buckets`, `apply_flow_cap` and `apply_edge` on the conversion leg
   — identical to `swap`.
8. Transfers `payout` from the payout-side reserve to the user's ATA, then
   `burn`s the ticket shares from the share lock, decrements `total_shares`,
   zeroes the ticket and emits `WithdrawSingleEvent`.

**Two-sided still works:** `claim_withdraw` is unchanged and, per its contract,
**does not require a fresh quote** (`two_sided_claim_withdraw_still_works_with_an_expired_quote`),
so a ticket is always releasable even if the single-sided path reverts.

## 6. Invariant → test map

| Invariant | Test(s) |
|---|---|
| Base-in pulls only base, mints shares, no quote pulled | `deposit_single_base_pulls_only_base_and_mints_shares` |
| Quote-in pulls only quote | `deposit_single_quote_pulls_only_quote_and_mints_shares` |
| No dilution of existing LPs | `deposit_single_does_not_dilute_existing_lp_value` |
| Size / zero-amount bounds | `deposit_single_rejects_over_max_quote_size`, `deposit_single_rejects_zero_amount` |
| Slippage bounds honoured | `deposit_single_enforces_min_shares_and_min_swap_out` |
| Fresh + attributed quote required | `deposit_single_rejects_expired_and_unattributed_quotes` |
| Atomic failure leaves state unchanged | `deposit_single_atomic_failure_leaves_state_unchanged` |
| Flow cap applies | `deposit_single_respects_flow_cap` |
| Single payout only | `claim_withdraw_single_pays_only_the_chosen_token`, `claim_withdraw_single_quote_side_pays_only_quote` |
| Fresh quote required on single claim | `claim_withdraw_single_requires_a_fresh_quote` |
| `min_out` enforced | `claim_withdraw_single_enforces_min_out` |
| Capacity failure reverts, ticket intact | `claim_withdraw_single_capacity_failure_leaves_ticket_intact` |
| Two-sided claim works with expired quote | `two_sided_claim_withdraw_still_works_with_an_expired_quote` |
| Paused vault blocks both | `single_sided_ops_reject_a_paused_vault` |
| Paused vault / foreign quote state blocked | `single_sided_ops_reject_a_paused_vault`, `single_sided_ops_reject_a_foreign_quote_state` |
| Token-2022 rejected (legacy SPL only) | `deposit_single_rejects_token_2022` |
| Reserve conservation | `deposit_single_conserves_reserves_and_ticket` |
| Epoch gate / one-shot ticket | `claim_withdraw_single_rejects_before_the_epoch`, `claim_withdraw_single_double_claim_rejected` |
| CU within budget | `single_sided_compute_units_within_budget` |

## 7. Independent differential and fuzz (Task 2)

- `simulation/reference/single_sided.py` is an independent integer reference of
  `charge_fee`/`single_eval`/`solve_deposit_single` and the withdraw plan.
- **600** golden vectors (400 deposit / 200 withdraw) generated by
  `simulation/reference/single_sided_golden.py` → `vault/program/tests/single_sided_vectors.txt`,
  parsed by `single_sided_python_differential`. **Clean.**
- **100,000**-case in-language brute-force differential
  (`single_sided_solver_matches_brute_force_100k`): exhaustive scan over every
  candidate `s`. **Clean.**
- **20,000**-case fuzz invariants (`single_sided_fuzz_invariants`) and Python
  `simulation/reference/test_single_sided.py` (incl. a high-precision `Decimal`
  fee check). **Clean.**

## 8. Compute units

Measured via LiteSVM on the `cargo build-sbf` artifact:

- `deposit_single` = **161,693 CU**
- `claim_withdraw_single` = **49,355 CU**

Both **< 200,000** (`single_sided_compute_units_within_budget`).

## 9. Residual risks (plain words)

- The single-sided path trades at the **committed quote**, so it shares the
  `swap` stale-quote exposure (bounded by `expiry_slot`, `max_staleness_seconds`,
  `max_conf_bps`, the anchor-deviation bound, the flow cap and the edge breaker).
  A keeper that commits a stale or mis-anchored quote can be arbitraged within
  those bounds; this is acknowledged and unchanged from the two-sided design.
- `deposit_single` requires an existing funded pool and a live ladder; a
  first-depositor cannot use it.
- A `BuyBase` deposit whose balance point lies beyond the ladder depth reverts
  with `CapacityExceeded` rather than partially filling.
- This is a same-agent review, not an independent audit. **No known issues in
  self-review; independent audit pending.**
