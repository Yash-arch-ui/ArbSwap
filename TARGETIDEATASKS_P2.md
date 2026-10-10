# TARGETIDEATASKS_P2.md

### Phase 2 (On-chain program) — deep audit + "what must be done" to meet the idea's P2

*Companion to `TARGETIDEATASKS.md`. Audited on 2026-10-08 against the code in
`vault/program/src/lib.rs` (1,971 lines) and the LiteSVM suite
(`vault/program/tests/`). Target = Build Plan §12 **P2** and Master Plan §11 **P2**.*

---

## 0. TL;DR

**P2 is ~85% built but 0% delivered.** The Anchor program is a correct, well-tested
execution engine *on a local validator*. To meet the idea's P2 you must do **one
hard gate plus four code fixes**:

| # | Must do | Why | Effort |
|---|---|---|---|
| 1 | **Deploy to devnet + run the full money-path loop** | P2 gate literally requires it; today `Anchor.toml` is `cluster = "localnet"` and the deploy script has never run | 3–5 d |
| 2 | **Fix the cross-vault withdraw-ticket substitution (HIGH)** | `claim_withdraw` does not bind the ticket to the vault → a ticket from vault A can drain vault B's queued shares | 0.5 d |
| 3 | **Enforce a minimum spread** (`min_spread_bps`) | the program checks only `half_spread <= max_spread`; a keeper can quote ~0 spread | 0.5 d |
| 4 | **Bind ladder capacity to reserves** (no phantom depth) | `update_quote` validates level *prices* but never that total quoted liquidity ≤ holdings·`u_max` | 2–3 d |
| 5 | **Make `trip_breaker` trip on stale/wide oracle, not only quote expiry** (spec §6.2/§8.3) | today it only checks `now >= expiry_slot` | 1–2 d |

**"Proving the P2 claim" does NOT mean the LVR/markout claim.** That is P1's claim.
P2's claim is narrower and on-chain:

> *Custody is safe, deposits/withdrawals are fair, and a trader's swap executes on
> devnet at (or better than) the keeper's quoted ladder, while the program prevents
> the keeper from quoting or filling outside its on-chain bounds.*

To prove it: a **devnet transaction trace** of the full loop + the **invariant
tests** (including the new ones below). Nothing about profit enters P2.

---

## 1. What the idea's Phase 2 requires

### Build Plan §12 P2 — tasks and gate

| Task | Spec | Status today |
|---|---|---|
| T2.1 | Anchor skeleton: accounts, config, errors, events | **DONE** |
| T2.2 | `deposit`, `request_withdraw`, `claim_withdraw`, `crank_epoch` with warm-up + queue | **DONE (local)** |
| T2.3 | `update_quote` with all guards | **DONE (local), 2 conformance gaps** |
| T2.4 | `swap` using `tq-math`; fee split | **DONE (local)** |
| T2.5 | Breakers, pause, timelocked `set_params` | **PARTIAL** (breaker only on expiry) |
| T2.6 | Local validator tests; invariant tests; **devnet deploy** | tests DONE; **devnet NOT DONE** |

**P2 gate (verbatim):** *"full deposit, update, swap, withdraw loop on devnet; all
invariants pass."*

### Master Plan §11 P2

Modules **M1–M4** (vault core, pro-rata share accounting, quote state, swap engine),
**M8–M10** (risk limits, circuit breakers, warm-up/withdrawal queue); unit + property
tests; local-validator tests; **devnet deployment**. Gate: *"deposit, swap, update,
withdraw loop works with bounds enforced."*

### What "bounds enforced" means (the P2 promise, not the P1 promise)

1. A keeper can never store a quote whose **prices** fall outside the anchor band
   around the verified Pyth price (`Config.max_anchor_dev_bps`, `max_anchor_step_bps`,
   `max_spread_bps`, per-level anchor band, `max_inventory_bps`).
2. A keeper can never cause the vault to **fill more than it holds** (capacity ≤
   available reserves).
3. A trader can always get the **quoted-or-better** price (`min_out`/`min_version`,
   expiry) — the honest-execution promise.
4. **Custody and pro-rata accounting are invariant** under arbitrary instruction order.

---

## 2. Instruction-by-instruction conformance

Spec reference: Build Plan §6.2/§6.3/§6.4/§6.5/§6.6; Master Plan §5.2.

| Instruction | Spec | Implemented | Guards present | Gaps |
|---|---|---|---|---|
| `initialize_program` | (added) | ✅ | one-time, front-run protection | — |
| `initialize_vault` | ✅ | ✅ | admin, mints, weights sum, ascending offsets, expiry>grace, bucket split ≤ 10k | does not validate `max_staleness_seconds >= 0` at init (checked later) |
| `deposit` | ✅ | ✅ | ACTIVE, >0, min_shares, shares>0, warm-up ticket, exclude buckets | warm-up gates withdrawal only, not share activation (documented) |
| `request_withdraw` | ✅ | ✅ | warm-up elapsed, shares>0/≤balance, mint+owner, ticket seed-bound | — |
| `claim_withdraw` | ✅ | ✅ | epoch reached, total>0, owner, mint/owner of user accounts | **ticket NOT seed/address-bound to vault (P2-F01)** |
| `crank_epoch` | ✅ | ✅ | time-gated, permissionless | — |
| `update_quote` | ✅ | ✅ | ACTIVE, keeper allowlist/bond, monotonic slot, Pyth Full verify (owner/feed/freshness/price/conf), anchor↔oracle, level↔anchor band, reservation band, spread ≤ max, weights/offsets | **no min spread (P2-F02)**; **no capacity≤reserves (P2-F03)**; no on-chain LVR budget (relabelled) |
| `swap` | ✅ | ✅ | ACTIVE, version, expiry, size cap, fee, `walk_ladder`, `min_out`, per-window one-sided flow cap | **capacity enforced only by token-transfer failure** |
| `trip_breaker` | ✅ | ⚠️ | permissionless, ACTIVE, quote expired | **only checks expiry; not stale/wide-conf/vol (P2-F04)** |
| `reset_breaker` | ✅ | ✅ | admin, PAUSED | — |
| `wind_down` | ✅ | ✅ | admin | no `ParamsChanged`-style event (uses status only) |
| `set_params` / `apply_params` | ✅ | ✅ | admin, timelock `TIMELOCK_SLOTS`, bounded buckets | `min_spread_bps` cannot be set because it does not exist |
| `bond_keeper` | ✅ | ✅ | >0, PDA, vault-owned bond account | **no `unbond_keeper` → "open keepers" not true** |
| `slash_keeper` | ✅ | ✅ | admin, ≤bond, sends to insurance | — |
| `claim_keeper_reward` | ✅ | ✅ | keeper-only, exact accrued buckets | — |
| `propose_fee_claim` / `execute_fee_claim` | ✅ | ✅ | admin, protocol-only, timelocked, fixed treasury | insurance compensation is design-only |

Events (§6.5): `QuoteUpdated`, `SwapEvent`, `DepositEvent`, `WithdrawRequested`,
`WithdrawClaimed`, `BreakerTripped`, `BreakerReset`, `KeeperSlashed`, `ParamsProposed`
/`ParamsApplied` — **all present** (some renamed). No `pre_state_hash` / `price_avg`
field in `SwapEvent` (spec §6.4 suggested; not required).

---

## 3. Deep findings (P2-specific)

Severity is about the **P2 gate and fund safety**, not the market-making claim.

| ID | Finding | Sev | Evidence | Fix |
|---|---|---|---|---|
| **P2-F01** | **Cross-vault withdraw-ticket substitution.** `ClaimWithdraw.withdraw_ticket` is validated only by `owner == user`, not by the vault PDA seed. A ticket created under vault A (`[b"wd", A, user]`) can be passed to vault B's `claim_withdraw`; B computes `shares·B_available/B_total`, burns that many of **B's** shares from **B's** `share_lock` (other queued users' shares) and pays the attacker. | **HIGH** | `lib.rs:1525` (`#[account(mut,constraint=withdraw_ticket.owner==user.key())]`); `lib.rs:278-304` creates it seed-bound; `lib.rs:327-413` never re-binds | add `seeds=[b"wd", vault.key().as_ref(), user.key().as_ref()], bump=withdraw_ticket.bump` |
| **P2-F02** | **No minimum spread.** `Config` has `max_spread_bps` only; `update_quote` checks `half_spread_bps <= max_spread_bps`. A keeper can quote `half_spread = 0` (a tight band inside the anchor tolerance). Spec §5.16/§6.3 requires `s_min ≤ s ≤ s_max`. | MED | `lib.rs:504-507`; no `min_spread` anywhere in the program | add `min_spread_bps` to `InitParams`/`Config`/`ParamsUpdate`, require `half_spread >= min_spread` |
| **P2-F03** | **Capacity is not bound to reserves (phantom depth).** `update_quote` checks each level's *price* is inside the band and `liquidity > 0`, but never checks that the implied base/quote capacity across levels ≤ `utilization_max · available_reserves`. A keeper can quote arbitrarily deep liquidity; over-deep swaps then revert on token-transfer (bad UX) instead of being rejected at quote time. Spec §5.7 "capacity never exceeds holdings". | MED | `lib.rs:525-612` (validates prices, not capacity); `lib.rs:688-690` (only `remaining`) | require `Σ base_cap_k ≤ u_max·base_avail` and `Σ quote_cap_k ≤ u_max·quote_avail`; add `utilization_max` to `Config` |
| **P2-F04** | **Breaker only trips on quote expiry.** Spec §6.2 says trip on "stale oracle, wide confidence, or volatility flag provable on-chain"; Master Plan §8.3 lists five triggers. Today `trip_breaker` needs only `now >= expiry_slot`. | MED | `lib.rs:846-859` | pass the `PriceUpdateV2` and trip on `get_price_no_older_than` failure / `conf_bps > max_conf`; optionally store a keeper `vol_flag` |
| **P2-F05** | **`depth_mult_bps` is stored and emitted but never read by `swap`.** The ladder's `liquidity` already encodes depth, so the field is informational; the depth throttle is not an on-chain control. | LOW | `lib.rs:629,646`; no read in `swap` | either drop it from `QuoteState` or document it as an indexer hint |
| **P2-F06** | **LVR depth budget not enforced on-chain.** `V_active ≤ 8(R−gas)/σ²` is not computed; `depth_mult_bps` is clamped to ≤10,000. | MED (claim) | `docs/FORMULA.md` §9; relabelled in `docs/SECURITY.md` | keep relabel, or store realized σ and enforce (needs defined `R`, `g_gas`) |
| **P2-F07** | **No `unbond_keeper`.** A keeper can bond but never withdraw; the "open, bonded keeper network" claim is not backed by the code. | MED | `lib.rs:948-964` (bond only) | add `unbond_keeper` with a cool-down window during which admin can still slash |
| **P2-F08** | **`update_slot` is not required to equal `clock.slot`.** Spec §6.3 says `==`; code uses `<=` intentionally (landing delay). Documented decision, but the docs and spec disagree. | INFO | `lib.rs:453-466` | update the spec note / keep the code |
| **P2-F09** | **`flow_n` stored but never read for pricing**, and uses mixed units (gross-in vs net-out on the two sides). | LOW | `lib.rs:781-832`; `QuoteState` comment | fix units or drop the field |
| **P2-F10** | **No devnet config/client.** `Anchor.toml` has `[programs.localnet]` and `cluster = "localnet"` only; `scripts/devnet_deploy.sh` prints the bootstrap instruction but there is **no client that calls `initialize_program`/`initialize_vault`/the loop**, and no scripted Pyth account creation. | **BLOCKER** | `Anchor.toml`; `scripts/devnet_deploy.sh:36-45` | P2-T2 |
| **P2-F11** | **Account `space` is hand-computed** and untested at runtime; a mismatch only surfaces on deploy. | LOW | `lib.rs:1401-1405`, `1691`, `1714` | add a test asserting `space ≥ 8 + serialized LEN` for each account |
| **P2-F12** | **Docs stale / missing.** `docs/ARCHITECTURE.md`, `docs/ANALYTICS.md`, `docs/SECURITY_CHECKLIST.md`, `docs/P5_REPORT.md` are referenced by README but absent; `docs/FORMULA.md` still lists F-03/F-10/F-17 as open and points at old paths (`programs/arbswap`, `crates/arb-math`). | LOW | `README.md`; `docs/FORMULA.md` §2/§6/§12 | rewrite/repair in P2-T8 |
| **P2-F13** | **No sell-then-buy "no free money" on-chain test** (Build Plan §10 invariant 2) surfaced as a named test. | LOW | `litesvm_lifecycle.rs` has value-conservation but not this explicit property | add test in P2-T7 |

---

## 4. What must be done — P2 task list

Ordered. "Gate" = required for P2 PASS.

### P2-T1 — Fix cross-vault withdraw-ticket substitution (**gate, HIGH**)
- Add to `ClaimWithdraw`:
  `#[account(mut, seeds=[b"wd", vault.key().as_ref(), user.key().as_ref()], bump=withdraw_ticket.bump, constraint=withdraw_ticket.owner==user.key())]`.
- Add regression test `claim_withdraw_rejects_a_ticket_from_another_vault`:
  create two vaults, queue a withdrawal in A, attempt `claim_withdraw` on B with A's ticket → must fail.
- **Acceptance:** test fails on the old code, passes on the fix; full suite green.
- **Effort:** 0.5 d.

### P2-T2 — Devnet deployment + full money-path loop (**gate, BLOCKER**)
- **P2-T2a Config:** add `[programs.devnet] arbswap = "<id>"` and a devnet provider
  (env-driven) to `Anchor.toml`; document the wallet path.
- **P2-T2b Client (`scripts/devnet_e2e.ts` or a Rust bin):** the loop below. Every
  step prints its signature and asserts balances.
  1. `initialize_program` (deployer claims admin).
  2. Create two test mints (base 9 dp, quote 6 dp) + vault token accounts + a user
     token account; mint test balances.
  3. `initialize_vault` with a **real devnet Pyth feed id** (SOL/USD) and a `Config`
     whose Pyth receiver account is the real devnet receiver program.
  4. `deposit(base, quote, min_shares)`.
  5. **`update_quote`**: obtain a `PriceUpdateV2` on devnet. Two options:
     - *in-band*: fetch Hermes VAAs and include the receiver's `update_price_feeds`
       CPI in the same tx, then call `update_quote`; or
     - *sponsored*: create a `PriceUpdateV2` via the receiver in a prior tx and pass it.
     Record the update's compute units.
  6. `swap(BuyBase, amount_in, min_out, min_version)` and `swap(SellBase, …)`;
     assert the executed output ≥ `min_out`.
  7. `request_withdraw(shares)` → warp → `crank_epoch` → `claim_withdraw`; assert
     fair pro-rata token deltas.
- **P2-T2c Artifacts:** commit `docs/DEVNET.md` with the program id, mint ids, vault
  PDA, feed id, and every signature.
- **Acceptance:** a fresh clone + funded devnet key reruns the loop with one command;
  `docs/DEVNET.md` links the signatures.
- **Effort:** 3–5 d (Pyth posting is the long pole).

### P2-T3 — Minimum spread bound (**gate, MED**)
- Add `min_spread_bps` to `InitParams`, `Config`, `ParamsUpdate`; require
  `min_spread_bps <= half_spread_bps <= max_spread_bps` in `update_quote`; add a
  matching check in `initialize_vault`/`apply_params`.
- Test `a_zero_spread_quote_is_rejected`.
- **Acceptance:** sub-minimum spread fails; default params still valid.
- **Effort:** 0.5 d.

### P2-T4 — Bind ladder capacity to reserves (**gate, MED**)
- Add `utilization_max_bps` to `Config`.
- In `update_quote`, after price checks, compute each level's implied base/quote
  capacity from `sqrt_lo/sqrt_hi/liquidity` and require the sums ≤
  `utilization_max_bps · available_reserves_bps` (excluding fee buckets, consistent
  with share math).
- Test `a_ladder_deeper_than_the_reserves_is_rejected`.
- Depends on the client/keeper actually sizing from available reserves (already noted
  in `docs/FORMULA.md` §6).
- **Acceptance:** over-deep ladder rejected on-chain; the honest ladder still passes.
- **Effort:** 2–3 d.

### P2-T5 — Breaker on stale / wide confidence (**gate, MED**)
- Extend `trip_breaker` to accept the `PriceUpdateV2` and trip when
  `get_price_no_older_than` fails, `conf_bps > max_conf_bps`, or (new) a stored
  `vol_flag` is set by `update_quote`.
- Keep the permissionless, no-arg expiry path.
- Tests: `trip_breaker_on_stale_oracle`, `trip_breaker_on_wide_confidence`.
- **Acceptance:** all three trigger paths pause the vault; `reset_breaker` (admin) resumes.
- **Effort:** 1–2 d.

### P2-T6 — `unbond_keeper` with cool-down (**enables the P2/P5 keeper claim**)
- `unbond_keeper(amount)` sets `unbond_ready_slot = now + COOLDOWN`; a second call
  after the cooldown releases the tokens; admin may still `slash_keeper` during the
  window. Tests: bond→unbond too early fails; after cooldown succeeds; slash inside
  the window works.
- **Acceptance:** the "open bonded keepers" claim is now backed by code.
- **Effort:** 1–2 d.

### P2-T7 — Invariant test completeness
Add named tests for the Build Plan §10 invariants:
- `sell_then_buy_same_size_never_creates_value` (invariant 2).
- `claim_withdraw_rejects_a_ticket_from_another_vault` (P2-T1).
- `a_ladder_deeper_than_the_reserves_is_rejected` (P2-T4).
- `a_zero_spread_quote_is_rejected` (P2-T3).
- `expired_quote_always_rejects_swap` (invariant 4; exists via breaker test — make explicit).
- `account_spaces_match_serialized_sizes` (P2-F11).
- **Effort:** 1–2 d.

### P2-T8 — Docs + config reconciliation
- Add/repair `docs/ARCHITECTURE.md`, `docs/SECURITY_CHECKLIST.md`; delete the dangling
  references in `README.md`.
- Update `docs/FORMULA.md` to the current code (remove stale F-03/F-10/F-17 status,
  fix old paths).
- Update `Anchor.toml` for devnet (P2-T2a).
- **Effort:** 1 d.

### P2-T9 — LVR depth-budget decision (claim alignment)
Either enforce `V_active ≤ 8(R−gas)/σ²` on-chain (store realized σ in `QuoteState`,
define `R`, `g_gas`) **or** keep the honest relabel and remove the language everywhere.
- **Effort:** 0.5 d (relabel) / 3–5 d (enforce).

### P2-T10 — `flow_n` fix-or-drop
Fix the units (both sides net base) or remove the field and its writes.
- **Effort:** 0.5 d.

---

## 5. Devnet end-to-end runbook (P2-T2 detail)

```text
prereq: funded devnet keypair at ~/.config/solana/id.json (solana airdrop)
1  anchor build
2  CLUSTER=devnet ./scripts/devnet_deploy.sh           # deploy (adds provider env)
3  client: initialize_program { admin }                  # claim admin (front-run guard)
4  client: create mints + user ATAs; mint test balances
5  client: initialize_vault {
       base_mint, quote_mint, keeper, treasury,
       pyth_feed_id = <devnet SOL/USD>, fee_bps, buckets,
       min_liquidity, warmup_slots, epoch_slots, grace/expiry,
       max_staleness_seconds, max_conf_bps, max_anchor_step_bps,
       max_spread_bps, max_quote_size, max_inventory_bps, min_bond,
       max_anchor_dev_bps, flow_window_slots, max_window_flow_bps,
       offsets_bps, weights_bps }
6  client: deposit(base, quote, min_shares)               # ticket activate_slot = now+warmup
7  keeper/client: post Pyth PriceUpdateV2; update_quote   # record CU
8  client: swap BuyBase(amount_in, min_out, min_version)  # assert out >= min_out
9  client: swap SellBase(...)                             # both directions
10 client: request_withdraw(shares)
11 anyone: crank_epoch (after epoch_slots)
12 client: claim_withdraw
13 assert: reserves ≥ liabilities; token deltas pro-rata; no account underflow
```

**Pyth on devnet (the risky hop):** `update_quote` requires an existing
`PriceUpdateV2` account owned by the Pyth receiver. The clean path is in-band:
include the receiver's `update_price_feeds` CPI (fetch VAAs from Hermes) in the same
transaction, then call `update_quote`. Budget the tx CU accordingly (Receiver
verification ≈ 15k CU + our ~18–20k CU).

---

## 6. P2 gate checklist (definition of P2 done)

- [ ] P2-F01 fix merged + regression test.
- [ ] P2-F02/F03/F04 fixes merged + negative tests.
- [ ] Devnet deploy with `initialize_program` claimed.
- [ ] Full loop (`deposit → update_quote → swap → request_withdraw → crank_epoch →
      claim_withdraw`) executed on devnet, both swap directions, **signatures published**.
- [ ] "Bounds enforced" demonstrated: (a) out-of-band keeper quote rejected,
      (b) over-deep ladder rejected, (c) zero-spread quote rejected, (d) expired quote
      rejects swap, (e) per-window flow cap rejects, (f) cross-vault ticket rejected.
- [ ] All invariant tests green; `cargo test --workspace` + `anchor build` green.
- [ ] CU table published for every instruction (already partly in `docs/AUDIT_FULL.md`).
- [ ] `docs/ARCHITECTURE.md` + `docs/SECURITY_CHECKLIST.md` exist; dangling README
      links removed; `docs/FORMULA.md` reconciled.
- [ ] (Claim) `unbond_keeper` done **or** the "open keepers" wording removed until P5.

When all of the above is true, **Phase 2 matches the idea's Phase 2**: a
custody + execution program whose bounds are enforced, proven end-to-end on the real
Solana devnet.

---

## 7. Scope fence — what is NOT Phase 2

Do not pull these into P2 or the gate will drift:

- **P3:** live Pyth streaming keeper, adaptive priority fee, bonded open network
  (though `unbond_keeper` is on-chain code).
- **P4:** analytics indexer, metrics, dashboard/demo mode.
- **P5:** attacker bots, aggregator/Jupiter adapter, independent audit.
- **P6:** video, deck, one-command reproduction.

The devnet loop can be driven by a **scripted client**; a live keeper is not required
to satisfy the P2 gate.

---

## 8. Decisions needed from the human

1. **Devnet program id / keypair ownership** — who funds and owns the deployer, and
   will the deployer be the `initialize_program` admin (recommended: multisig/later
   rotation via timelock)?
2. **Pyth on devnet** — in-band Hermes update vs a sponsored push account? (affects
   the client and the CU story)
3. **LVR budget** (`P2-T9`) — enforce or relabel?
4. **`unbond_keeper`** (`P2-T6`) — include now for a true "open keeper" claim, or
   defer to P5?
5. **Minimum spread default** (`P2-T3`) — pick a default `min_spread_bps` consistent
   with the P1 frozen `spread_floor` (2 bps) so the simulator, keeper, and program agree.
