# SINGLE_SIDED_DESIGN.md — single-token deposit and withdrawal on the vault's own ladder

Status: **implemented in the program and covered by LiteSVM tests** (operator
override of the §7 NO-GO; see `docs/DECISIONS.md` D-015/D-016). Two new
instructions (`deposit_single`, `claim_withdraw_single`), two events
(`DepositSingleEvent`, `WithdrawSingleEvent`), no account-layout change, no
redeploy in this window (program-upgrade remains a gated Task 6 action).

Status (frontend): **wired behind `VITE_ENABLE_SINGLE_SIDED` (default off)** —
`app/src/chain/singleSided.ts` mirrors `single_eval`/`solve_deposit_single` and
the `claim_withdraw_single` amount plan with integer arithmetic and uses golden
vectors emitted by the program's own unit tests; `app/src/pages/VaultPage.tsx`
exposes Deposit "Deposit with" and Withdraw "Receive as" toggles with a
build → simulate → preview → confirm flow that re-reads the quote at submission.
See `docs/DECISIONS.md` D-017.

Two deviations from the text below, applied during implementation:
`deposit_single` transfers the **full** `amount_in` in one transfer (the §1.1
"only `dB` is pulled" wording was a leftover error — pulling only `dB` breaks
conservation of the input fee), and `deposit_single` requires an existing funded
pool (`total_shares > 0`) because the internal conversion needs a committed
ladder. Both are recorded in `docs/DECISIONS.md` D-016.

Scope: add **two new instructions** to the existing program, `deposit_single` and
`claim_withdraw_single`, that let a user enter with one token and exit with one
token by trading the unwanted leg **against the vault's own committed ladder**.
No external router. No new account types. The existing two-sided `deposit`,
`request_withdraw`, `crank_epoch`, `claim_withdraw` and `swap` instructions keep
their exact behaviour.

Terminology follows `vault/program/src/lib.rs`. "Net reserves" means a reserve
minus the three fee buckets (`insurance_*`, `keeper_*`, `protocol_*`), as already
done in `deposit` (lib.rs:462-475) and `claim_withdraw` (lib.rs:656-669).

---

## 0. Shared model (read before the two instructions)

- `S = vault.total_shares`, `Bnet`/`Qnet` the net base/quote reserves.
- `fee = ceil(amount * fee_bps / 10_000)` (`arb_math::fee_amount`), the same fee
  the `swap` instruction charges (lib.rs:1023).
- `walk_ladder(levels, side, net)` returns `{out, remaining}`; `remaining == 0`
  is required (lib.rs:1040-1042). `BuyBase` walks the **ask** ladder; `SellBase`
  walks the **bid** ladder (lib.rs:1028-1031).
- The last committed `quote_state.oracle_price` (token units, Q64.64) is the
  reference for the realized-edge tracker (lib.rs:1203-1256).
- A "fresh attributed quote" means exactly the `swap` preconditions:
  `vault.status == ACTIVE`, `quote_state.version >= min_version`,
  `clock.slot < quote_state.expiry_slot`, `quote_state.keeper != default`, and the
  `keeper_reward` PDA bound to `quote_state.keeper`
  (lib.rs:992-1018). The single-sided path therefore shares the **same
  stale-quote exposure window** as `swap`.

The single-sided path **is a trade against the vault's own ladder at the
committed quote**. It is not a synthetic mint. It shares the swap's spread, fee,
flow cap and edge breaker, and it shares the swap's stale-price exposure.

---

## 1.1 `deposit_single(side, amount_in, min_shares, min_swap_out)`

Purpose: enter the pool with one token; the vault internally converts part of the
input to the other token and deposits both.

Preconditions (identical to `swap` + `deposit`):
- `vault.status == ACTIVE`;
- fresh attributed quote (§0);
- `amount_in > 0` and `amount_in <= config.max_quote_size` (`CapacityExceeded`);
- warm-up ticket written exactly like `deposit` (lib.rs:581-588).

Solver (bounded integer bisection). Let the input token be `A`.
- **side = Base** (`SellBase` internally): pick swapped input `s ∈ [0, A)`.
  `fee_s = fee(s)`, `s_net = s - fee_s`,
  `q_out = walk_ladder(bid_levels, Bid, s_net).out`.
  The vault keeps `s_net` base (the used input enters the reserve) and the swap
  output `q_out` quote is **internally redeposited** (no external quote
  transfer). Then `Bnet' = Bnet + s_net`, `Qnet' = Qnet - q_out`,
  `dB = A - s`, `dQ = q_out`.
- **side = Quote** (`BuyBase` internally): pick `s ∈ [0, A)`,
  `fee_s = fee(s)`, `s_net = s - fee_s`,
  `b_out = walk_ladder(ask_levels, Ask, s_net).out`.
  `Bnet' = Bnet - b_out`, `Qnet' = Qnet + s_net`, `dB = b_out`, `dQ = A - s`.

Choose `s` so the deposit is balanced against the **post-swap** net reserves:
find the `s` minimising `|floor(dB*S/Bnet') - floor(dQ*S/Qnet')|`, i.e. the
existing proportional rule (lib.rs:513-523) evaluated at `Bnet'`, `Qnet'`. As `s`
grows, `dQ` rises and `dB` falls, so the difference is monotone; a bisection on
`[0, A]` converges. **Iteration bound:** `ceil(log2(A)) <= 64` halvings (A is
`u64`); each step calls `walk_ladder` once, cost `O(LEVELS)=6` add/mul ops, and
`fee`. Worst case ≈ 64 x 6 level ops + 64 fees — a few thousand CU, well inside
one legacy transaction. The solver returns the balanced `s` (and, for the guard,
the final `dB`, `dQ`).

Shares and amounts (reuse the `deposit` rule at post-swap reserves):
- `shares = min(floor(dB*S/Bnet'), floor(dQ*S/Qnet'))`; first deposit uses
  `isqrt(dB*dQ) - min_liquidity` and locks `min_liquidity` (lib.rs:480-511).
- Required inputs are rounded **up** (`ceil_div_u128`, lib.rs:536-540) as in
  `deposit`. The **unused atoms stay with the user and are never pulled**: only
  `dB` of the input token is pulled from the user (the `s` portion is the used
  input that enters the reserve; the fee stays in the reserve as buckets).
- Reject `shares == 0` (`InvalidAmount`, mirrors lib.rs:529) and require
  `q_out > 0` (else `InvalidAmount`) — no value from nothing.
- Enforce `shares >= min_shares` (`SlippageExceeded`) and
  `q_out >= min_swap_out` (`SlippageExceeded`) — the latter guards the internal
  conversion the same way `swap`'s `min_out` does.

Net token movement (conservation): the user transfers `A` of the input token
once. Of that, `s - fee_s` enters the reserve as the swapped notional and
`fee_s` enters the buckets; `A - s` is the deposited notional. The other-token
leg is the internal swap output — **no token of the other kind is transferred in
or out**. Fee is charged on the swapped portion exactly like `swap` (ceil),
split into `insurance/keeper/protocol` by bps (lib.rs:1101-1105) and credited to
the same buckets (`vault.*`, `keeper_reward.*`); buckets are excluded from
`Bnet'`/`Qnet'`. The flow cap and the realized-edge tracker are updated exactly
as in `swap` (lib.rs:1048-1256).

Warm-up: identical to `deposit` — `ticket.shares` is set and
`ticket.activate_slot = slot + config.warmup_slots`. A **top-up re-arms** the
ticket exactly as `deposit` does (each `deposit*` overwrites `ticket.shares` and
re-arms `activate_slot`); `request_withdraw` before warm-up is rejected.

## 1.2 `claim_withdraw_single(side, min_out)`

Purpose: exit to a single token.

Every `claim_withdraw` precondition and effect is reused unchanged:
`ticket.epoch <= vault.epoch`; `ticket.owner` binding; burn of the queued shares
from `share_lock`; pro-rata floors `base_out`/`quote_out` from **net** reserves
(lib.rs:647-733). The only addition:

- Let the chosen payout token be `side`. The **unwanted** token's pro-rata amount
  `u` is converted through the ladder with a **fresh attributed quote** using the
  same internal swap helper as §1.1 (same fee, buckets, flow cap, edge update).
  For `side = Base`: `u = quote_out`, convert via `BuyBase` (pay `u` quote,
  receive base) → `c = walk_ladder(ask, u - fee(u)).out`. Payout =
  `base_out + c` base. For `side = Quote`: `u = base_out`, convert via
  `SellBase` → payout `quote_out + c` quote.
- The converted leg stays inside the vault; only the chosen token is transferred
  to `user_<side>`. Burn the full `ticket.shares`; set `ticket.shares = 0`
  (lib.rs:726). Emit the claim event with exact deltas.
- Enforce `payout >= min_out` (`SlippageExceeded`).
- If the ladder cannot absorb `u` (`walk_ladder` returns `remaining != 0`),
  **revert with `CapacityExceeded` and leave the ticket intact** — the shares are
  not burned and no token moves; the user can fall back to two-sided
  `claim_withdraw`.
- The single-token claim **requires a fresh quote**; the normal
  `claim_withdraw` continues to work with an **expired or missing** quote (it does
  not read the ladder).

## 1.3 Shared helper extraction (no behaviour change)

Extract, as internal functions in `lib.rs` (or a new `vault/program/src/single.rs`):
- `charge_fee_and_split(...)` — the `fee/net` computation and the
  insurance/keeper/protocol credit block (lib.rs:1023-1025, 1101-1198, incl. the
  `keeper_reward` PDA binding/init at lib.rs:1011-1018).
- `apply_flow_cap(...)` — the window rollover and `window_base_sold/bought`
  update + cap check (lib.rs:1048-1087) plus the `flow_n` accumulator
  (lib.rs:1088-1100).
- `apply_edge(...)` — the realized-edge computation, window, and breaker trip
  (lib.rs:1200-1256).
- `internal_swap_net(...)` — the ladder walk + `remaining == 0` assertion
  (lib.rs:1028-1042) returning `out`.

`swap` then calls these helpers. **Proof of no change:** the existing LiteSVM
suites (`litesvm_lifecycle`, `litesvm_breaker`, `litesvm_oracle_scaling`,
`litesvm_security`, `litesvm_volatility`, `litesvm_recovery`) are run
**UNMODIFIED** and must stay green, and the CU of `swap` stays within the
recorded sampling range.

## 1.4 Invariants and the named tests that prove each

| # | Invariant | Named test(s) |
|---|---|---|
| I1 | No zero-share mint, no value from nothing | `deposit_single_rejects_zero_shares`, `deposit_single_first_deposit_mints_min_liquidity` |
| I2 | Conservation: token deltas equal the event fields; totals change only by fees to buckets | `deposit_single_conserves_tokens_and_matches_event`, `claim_withdraw_single_conserves_tokens_and_matches_event` |
| I3 | Existing LP value per share does not fall beyond rounding, plus the already-bounded quote-vs-oracle deviation (**worst-case transfer bound = amount x max_anchor_dev_bps**); flow cap and edge breaker apply | `deposit_single_does_not_dilute_existing_lp_value`, `single_sided_ops_respect_anchor_deviation_bound`, `deposit_single_respects_flow_cap`, `deposit_single_updates_edge_and_can_trip_breaker` |
| I4 | `deposit_single` then immediate withdrawal returns at most input minus fee and spread (except stale-quote exposure bounded as I3) | `deposit_single_round_trip_bounded_loss` |
| I5 | Atomic failure leaves balances, shares and tickets unchanged | `deposit_single_atomic_failure_leaves_state_unchanged`, `claim_withdraw_single_capacity_failure_leaves_ticket_intact` |
| I6 | Conversion size obeys `max_quote_size` and the window flow cap | `deposit_single_rejects_over_max_quote_size`, `deposit_single_conversion_within_flow_cap` |
| I7 | Slippage guards cannot be bypassed | `deposit_single_enforces_min_shares_and_min_swap_out`, `claim_withdraw_single_enforces_min_out` |

Additional required tests: stale/expired/unattributed quote rejected on both new
instructions; paused vault; wrong mint/owner; Token-2022 rejection; cross-vault
substitution for every new account; ticket handling identical to
`deposit`/`claim_withdraw` (warm-up, epoch, double claim); normal
`claim_withdraw` works while the quote is expired.

## 1.5 Threat table

| Threat | Mitigation | Residual risk |
|---|---|---|
| **Stale-quote arbitrage** via the single-sided path | Same validity as `swap`: `expiry_slot` (120 slots ≈ 30 s), `max_staleness_seconds` 2 s and `max_conf_bps` at *commit*, the anchor-deviation bound `max_anchor_dev_bps`, the per-window flow cap, and the edge breaker all apply to the internal swap | A longer validity widens stale-price exposure. Worst-case value transfer is bounded by `amount × max_anchor_dev`; the flow cap and breaker cap the aggregate. Acknowledged residual risk. |
| **Self-trade / ladder manipulation** | The user trades the ladder the keeper already committed and verified; a manipulated order cannot change the committed ladder on-chain | The user pays the vault's own spread — an intended cost, not a leak |
| **Share inflation / donation** | `deposit_single` reuses the `deposit` rule (`shares > 0`, `min_liquidity` lock, ceil-rounded pulls); donation cannot mint zero shares | Rounding drift only (≤1 atom per side) |
| **Keeper-reward attribution** | The internal swap credits `keeper_reward` bound to `quote_state.keeper` and re-asserts the binding, exactly as `swap` | None known |
| **Cross-vault substitution** | Every account is address-bound as in `deposit`/`claim_withdraw`/`swap`; new accounts carry the same constraints | None known |
| **Token program** | Classic SPL only; Token-2022 rejected by the token-program constraint as elsewhere | None known |
| **Rounding drift** | All floors/ceils match `deposit`; shares use `min(...)` of two floors | ≤1 atom |
| **Compute budget** | Bounded bisection (≤64 steps × 6 levels); explicit compute budget set client-side if measured >200k CU | None known |

Plain statement: **the single-sided path trades against the vault's own ladder at
the committed quote and inherits the same stale-quote exposure as a swap.** It is not
costless for the pool; it is bounded by the anchor-deviation bound, the flow
cap and the edge breaker. No known issues in self-review; independent audit
pending.

## 1.6 Accounts, sizes, compute, IDL, transaction size

No new account types → **no `Config`/`QuoteState`/`Vault` layout change** and no
migration.

`deposit_single` accounts: `user` (signer), `vault`, `config`, `quote_state`,
`base_reserve`, `quote_reserve`, `base_mint`, `quote_mint`, `user_input_ata`,
`user_shares`, `deposit_ticket` (PDA `[b"dep", vault, user]`), `keeper_reward`
(PDA `[b"reward", vault, keeper]`), `share_mint`, `share_lock`, `token_program`,
`system_program`, `rent`. **~17 accounts.**

`claim_withdraw_single` accounts: `user` (signer), `vault`, `config`,
`quote_state`, `base_reserve`, `quote_reserve`, `base_mint`, `quote_mint`,
`user_shares`/`user_base`+`user_quote` (payout side required), `withdraw_ticket`
(PDA `[b"wd", vault, user]`), `share_mint`, `share_lock`, `keeper_reward`,
`token_program`, `system_program`. **~16 accounts.**

Transaction size: ~17 accounts × 32 B ≈ 544 B account metas + 1 signature
(`user`) + a 4-arg instruction ≈ well under the 1232-B legacy limit. Both fit a
legacy transaction; no address lookup table required.

Compute: bounded bisection ≤ 64 × `walk_ladder(6)`, plus one fee split and one
edge update — expected well under the 200k-CU program limit; measure with
`scripts/measure_cu.sh` in Task 3.5 and set an explicit budget client-side if
above.

IDL changes: **two new instructions only** (`deposit_single`,
`claim_withdraw_single`); new event variants `DepositSingle`/`WithdrawSingle`
carrying `swap_in, swap_out, fee, used amounts, shares, version, slot` (or reuse
existing event shapes). No account-type changes.

---

## 7. GO / NO-GO decision

> **Update (D-015):** the operator explicitly overrode this NO-GO
> ("DOTASK 3 FULLY"). The two instructions are now implemented and covered by
> `vault/program/tests/litesvm_single_sided.rs` (helper extraction done with the
> six existing LiteSVM suites passing unmodified; CU measured under the 200k
> per-instruction budget; IDL regenerated). **No redeploy occurs here** — the
> program upgrade remains the separately gated Task 6 action. The original
> rationale is preserved below for the record.

**NO-GO for deploying `deposit_single`/`claim_withdraw_single` in the
2026-10-16 window.** Reason: the design is sound and bounded, but shipping two
new on-chain instructions correctly requires (a) a Python reference + ≥500
golden vectors + 100k differential cases + fuzz (Task 2), (b) the helper
extraction with `swap` provably byte-identical, the full LiteSVM matrix,
mutation coverage, CU measurement and IDL/fixture regeneration (Task 3), then
(c) a redeploy with rollback inside the same window. That is not achievable
within the remaining session/timebox while preserving the required proof
discipline, and a partially-verified on-chain change is not acceptable.
Accordingly Tasks 2-6 are marked NOT DONE and this design stands as the roadmap.

Browser-only fallback (already flagged in `docs/ONE_SIDED_DEPOSIT_WITHDRAWAL_BUILD_PLAN.md`):
the fast path is a **frontend-only** one-sided flow that composes the existing
on-chain `swap` + `deposit` in a single legacy transaction (no program change, no
redeploy). It reuses the same math (`app/src/chain/swapMath.ts`) and ships weeks
sooner; it is the recommended increment if a demo-grade single-sided entry is
wanted before the program work lands.

---

## 8. Final status (what shipped)

Two new instructions on the existing program, plus a flag-gated frontend:

- `deposit_single(side, amount_in, min_shares, min_swap_out)` — enter with one
  token; the vault converts the swapped portion against its own committed ladder
  and deposits the balanced remainder, returning `DepositSingleEvent`.
- `claim_withdraw_single(side, min_out)` — exit to one token; the unwanted leg is
  converted against the committed ladder and the chosen token is paid out,
  returning `WithdrawSingleEvent`.
- No account-type, `Config`, `QuoteState` or `Vault` layout change; no new account
  sizes; no migration. `swap` was refactored to call shared helpers with its
  behaviour unchanged (six existing LiteSVM suites run unmodified).
- Frontend: `VITE_ENABLE_SINGLE_SIDED` (default off, fail closed) gates the Vault
  page "Deposit with" (both/single) and "Receive as" (both/one token) toggles. The
  UI mirrors the program's integer plan, simulates, shows a preview, and re-reads
  the on-chain quote at submission. Infeasible sizes are disabled with the exact
  reason; the UI never shows a partial-fill estimate.
- Verification (Task 2): an independent Python reference
  (`simulation/reference/single_sided.py`) generates **600** golden vectors
  (400 deposit / 200 withdraw) that the on-chain crate parses in
  `single_sided_python_differential`; a **100,000**-case in-language brute-force
  differential (`single_sided_solver_matches_brute_force_100k`) and a 20,000-case
  fuzz-invariant test back it, mirrored by `simulation/reference/test_single_sided.py`.

### 8.1 Math (see `docs/FORMULA.md` §12.1–12.2)

All amounts are integer atoms; no floating point. Let `S` be total shares and
`Bnet`/`Qnet` the net reserves (reserves minus fee buckets).

- Fee: `fee(x) = ceil(x · fee_bps / 10_000)` — same as `swap`.
- Ladder walk: `walk_ladder(levels, side, net) -> {out, remaining}`, `remaining == 0`
  required. `BuyBase` walks the ask ladder; `SellBase` walks the bid ladder.
- Deposit conversion: pick `s ∈ [0, A)` minimising
  `|floor(dB·S/Bnet') − floor(dQ·S/Qnet')|` at the post-swap reserves, by a bounded
  bisection (`≤64` halvings). `shares = min(floor(dB·S/Bnet'), floor(dQ·S/Qnet'))`.
  Reject `shares == 0` or `swap_out == 0`.
- Withdraw conversion: `payout = pro_rata(unwanted) + walk_ladder(unwanted − fee(unwanted))`
  for the chosen side.
- Golden vectors emitted by the program's own unit tests (fee 30 bps, one ladder
  level `{sqrt_lo=1<<64, sqrt_hi=2<<64, liquidity=1e28}`, `base_net=1e9`,
  `quote_net=2e9`, `total_shares=1e9`, `amount_in=1e8`):

  | op | side | key outputs |
  |---|---|---|
  | deposit | sellBase | s=33897681, fee=101694, swap_out=120197144, db=66102319, dq=120197144, shares=63941356 |
  | deposit | buyBase | s=33652173, fee=100957, swap_out=31595722, db=31595722, dq=66347827, shares=32626582 |
  | withdraw | buyBase | base_out=1e8, quote_out=2e8, unwanted=2e8, fee=600000, net=199400000, converted=145778554, payout=245778554 |
  | withdraw | sellBase | base_out=1e8, quote_out=2e8, unwanted=1e8, fee=300000, net=99700000, converted=291557109, payout=491557109 |

### 8.2 Invariants and the tests proving them

Rust (LiteSVM, `vault/program/tests/litesvm_single_sided.rs`, 22 tests) proves the
on-chain invariants I1–I7 in §1.4. The frontend integer mirror is proved against
the same integers:

| Invariant | Rust proof | Frontend proof |
|---|---|---|
| I1 no zero-share/value-from-nothing | `deposit_single_rejects_zero_shares` | `singleSided.test.ts` (zero-share plan returns null) |
| I2 conservation = event fields | `deposit_single_conserves_tokens_and_matches_event`, `claim_withdraw_single_conserves_tokens_and_matches_event` | golden-vector legs sum to the payout |
| I3 no LP dilution beyond rounding; bounded vs anchor | `deposit_single_does_not_dilute_existing_lp_value`, `single_sided_ops_respect_anchor_deviation_bound` | impact computed as `converted` vs reservation mid |
| I4 round-trip bounded loss | `deposit_single_round_trip_bounded_loss` | deposit/withdraw golden vectors are consistent |
| I5 atomic failure leaves state intact | `deposit_single_atomic_failure_leaves_state_unchanged`, `claim_withdraw_single_capacity_failure_leaves_ticket_intact` | `capacityExceeded` flag + disabled-with-reason; empty-ladder guard returns `{out:0}` |
| I6 obeys `max_quote_size` + flow cap | `deposit_single_rejects_over_max_quote_size`, `deposit_single_conversion_within_flow_cap` | "Exceeds quoted depth. Max now: X" |
| I7 slippage guards | `deposit_single_enforces_min_shares_and_min_swap_out`, `claim_withdraw_single_enforces_min_out` | `minWithSlippage` floor + `min_out` display |

UI-state and interface coverage is in `app/test/task4-single-sided-ui.test.ts`
(18 tests): the flag fails closed; the IDL exposes both instructions; both/one
deposit and both/one withdraw states render; the disabled reasons appear; the
build→simulate→preview→confirm ordering holds.

### 8.3 Residual risks

1. **Stale-quote exposure (shared with `swap`).** The single-sided path trades at
   the committed quote. A longer quote validity widens the window in which a stale
   price can be filled. The worst-case transfer is bounded by
   `amount × max_anchor_dev_bps`; the per-window flow cap and the realized-edge
   breaker cap the aggregate. This is a bounded, acknowledged risk — not a claim
   that it is zero.
2. **Capacity / depth.** On a thin ladder the conversion may not be absorbable; the
   operation is then refused (never partially filled), so a user can be blocked at
   a size rather than filled at a worse price.
3. **Rounding drift.** ≤1 atom per leg, matching `deposit`/`claim_withdraw`.
4. **Audit status.** Same-agent self-review only. No known issues in self-review;
   independent audit pending.
5. **On-chain smoke pending.** The frontend flag stays off until an on-chain smoke
   of the new instructions succeeds; until then the path is unproven end-to-end
   against the live program.

### 8.4 Plain statement

**The single-sided path trades against the vault's own ladder at the committed
quote and shares the same stale-quote exposure as a swap.** It is not a synthetic
mint and it is not costless for the pool; it is bounded by the anchor-deviation
bound, the per-window flow cap and the realized-edge breaker. Test funds only.

---

## 9. Reading list (external references)

Verified live on 2026-10-16 (HTTP 200):

- Uniswap v2 whitepaper (constant-product AMM + fee model):
  <https://uniswap.org/whitepaper.pdf>
- Balancer joins and exits (pool joins — proportional/single-token):
  <https://docs-v2.balancer.fi/reference/joins-and-exits/pool-joins.html>
- Balancer pool exits (single-token/proportional/custom exits):
  <https://docs-v2.balancer.fi/reference/joins-and-exits/pool-exits.html>
- Meteora DLMM (discrete price bins, single-sided liquidity, dynamic fees):
  <https://docs.meteora.ag/core-products/dlmm/what-is-dlmm>
- Raydium (AMM v4 / CPMM / CLMM reference):
  <https://docs.raydium.io/>
- Saber (stable-swap LP token pricing):
  <https://docs.saber.so/>
