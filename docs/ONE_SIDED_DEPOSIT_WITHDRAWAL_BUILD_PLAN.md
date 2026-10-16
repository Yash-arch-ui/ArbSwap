# One-Sided Deposit & Single-Token Withdrawal — Full Build Plan

**Status:** plan only (no code yet).
**Derived from:** `docs/ONE_SIDED_DEPOSIT_WITHDRAWAL_PLAN.md` (research) and
`docs/ONE_SIDED_DEPOSIT_IMPLEMENTATION.md` (implementation spec).
**Target:** the `volatility` branch of `/home/ash10/solana/arbswap` (frontend
`app/`, program unchanged).

---

## 0. Deployment-delay question (answered up front)

**No on-chain delay. Deployment is a frontend redeploy — minutes, not hours.**

| Item | Volatility feature | One-sided deposit / withdrawal |
|---|---|---|
| Program upgrade | yes (one ABI change) | **no** — `deposit`/`request_withdraw`/`claim_withdraw` unchanged |
| Timelock (`216_000` slots ≈ 24 h) | yes (`apply_volatility_params`) | **no** — nothing is timelocked |
| PDA init / governance tx | yes | **no** |
| Deploy a change | `solana program upgrade` + frontend | **frontend only** |
| Propagation | after timelock | Vercel build ~1–2 min + CDN ~1–2 min |

The 7-hour wait belonged **only** to activating the volatility risk guard through
the program's timelocked parameter path. This feature adds **no** on-chain state
and **no** program instruction, so there is nothing to wait for. (A *native*
`deposit_single_sided` instruction would change this — explicitly out of scope.)

---

## 1. Goal

- **Deposit:** an LP supplies **only SOL or only USDC** and becomes an LP in **one
  atomic transaction**: convert exactly the needed part of the input to the pair
  asset via an external route, then call the existing proportional
  `deposit(base_amount, quote_amount, min_shares)`.
- **Withdraw:** keep the on-chain **pro-rata** payout (unchanged), and optionally
  deliver a **single token** by converting the unwanted token *after* claim.

## 2. Non-goals (v1)

- No native `deposit_single_sided` / single-asset program instruction.
- No constant-product (CPMM) single-sided share formula.
- No shares minted from oracle/USD value.
- No guarantee of a single-token vault payout.
- No two-transaction deposit flow (deposit must stay atomic).

## 3. Key invariant

Shares are minted **only** by the existing proportional rule against LP-eligible
reserves (`Bnet`, `Qnet`), excluding insurance/keeper/protocol buckets:

```text
shares = min( floor(dB * S / Bnet), floor(dQ * S / Qnet) )   # S = total_shares
usedB  = min(dB, ceil(shares * Bnet / S))
usedQ  = min(dQ, ceil(shares * Qnet / S))
refund = input_in - (input-side used amount)
```

The external route is a *means to reach the ratio*, never a share-minting rule.

---

## 4. Dependency to decide first (Phase 0)

The only external dependency is a **Devnet swap route** from `{SOL|WSOL, USDC}` to
the other side.

| Option | Notes |
|---|---|
| **Devnet AMM pool** (Raydium/Orca WSOL–USDC) | direct instructions; needs a funded devnet pool; most controllable |
| **Jupiter route API** | robust on mainnet; **thin on devnet** — verify a live devnet route first |
| Existing vault `swap` (self-route) | avoids a new dependency but is self-referential and consumes the vault's own ladder — last resort only |

Provider-neutral adapter (Phase 2) means the choice can be swapped later.

---

## 5. Deliverables (files)

**New**
- `app/src/chain/routes.ts` — provider-neutral swap-route adapter.
- `app/src/chain/oneSidedDeposit.ts` — solver + atomic tx builder.
- `app/src/chain/oneSidedWithdraw.ts` — post-claim single-token conversion helper.
- `app/test/routes.test.ts`, `app/test/one-sided-deposit.test.ts`,
  `app/test/one-sided-deposit-tx.test.ts`, `app/test/one-sided-withdraw.test.ts`.

**Edited**
- `app/src/pages/VaultPage.tsx` — deposit input-asset selector; withdrawal
  `Output as` selector; previews.
- `app/src/chain/program.ts` — reuse `expectedDepositShares`, `attachFeePayer`,
  `ensureAta`, `readAtaAmount`; add raw net-reserve helper if missing.
- `app/src/chain/wrappedSol.ts` — reuse wrap/unwrap + `MIN_SOL_FOR_FEES`.

---

## 6. Phased build (with time estimates)

Estimates are **engineering time** (focused dev time), not wall-clock with waits.
They assume the Phase 0 route decision is made up front.

| Phase | Work | Est. |
|---|---|---|
| **0 — Decide & verify** | Route provider + tx version/priority-fee/compute budget; confirm ticket lifecycle (one per user; no overwrite); confirm `Bnet/Qnet/S` from `vaultAtoms`; write interface contract | **0.5–1 d** |
| **1 — Exact previews + withdrawal UX** | Replace float preview with exact `expectedDepositShares`; use raw share atoms + LP-eligible reserves; improve withdraw tab states (no ticket / warm-up / queued / claimable / claimed / error); Max/%; label estimates | **1 d** |
| **2 — Route adapter** | `routes.ts` + mock-provider tests; decode + inspect ix program-ids/accounts; reject stale/missing output | **0.5–1 d** |
| **3 — Deposit solver + tx** | `oneSidedDeposit.ts`: iterative solver (≤6), `expectedDepositShares` parity, guards, one atomic tx, feePayer + simulate; tests incl. atomicity | **1.5–2 d** |
| **4 — Deposit UI** | Single-asset selector + preview; plan→simulate→confirm→re-plan→submit; success only after await; keep two-sided path | **1 d** |
| **5 — Withdrawal single-token** | `Output as: Both/SOL/USDC`; post-claim conversion (separate swap first, atomic later if it fits); disclosure | **1 d** |
| **6 — Ticket/multi-deposit guard** | Block/sub-rule when an unclaimed deposit ticket exists; document | **0.5 d** |
| **7 — E2E + regression** | Devnet E2E (SOL-only, USDC-only deposits; both withdrawal modes); failure/atomicity; full suite | **1 d** |
| **8 — Deploy** | Frontend rebuild + redeploy; hosted verification | **0.5 d** |

**Total: ≈ 7.5–9.5 engineering-days sequential.** With Phase 1 ‖ Phase 2 and
Phase 5 ‖ Phase 6 partially parallel, a realistic calendar is **≈ 5–6 working
days**.

---

## 7. Detailed flow

### 7.1 One-sided deposit (atomic)

```text
User picks input (SOL or USDC) + amount I, and slippage
  -> fetchProtocolState(): Bnet, Qnet, S (LP-eligible, raw atoms)
  -> read deposit ticket: if ACTIVE (unclaimed) -> block (Phase 6 rule)
  -> solve convert_in (<=6 iters):
        quote(pair) for convert_in
        matched = min(dB, floor(dQ * Bnet / Qnet))
        adjust convert_in toward proportional target; stop at |residual| <= 1 atom
  -> shares = expectedDepositShares(dB, dQ);  minShares = shares*(10000-bps)/10000
  -> usedB/usedQ (ceil); refund = I - input-side used
  -> tx = [ missing ATAs | wrap(native SOL portion) | route swap | deposit(dB,dQ,minShares) ]
        feePayer + fresh blockhash (attachFeePayer); simulate; fail visibly
  -> sign + send; success only after confirmed; report event shares, activation slot,
        amounts used, refund
```

Guards (throw, never degrade silently): `shares ≤ 0`; route `out < threshold`;
`Bnet/Qnet/S ≤ 0`; native SOL and `I + MIN_SOL_FOR_FEES > wallet SOL`; quote/slot
drifted between plan and submit → **rebuild**, never mint fewer shares.

### 7.2 Single-token withdrawal

```text
request_withdraw(shares)          # unchanged, on-chain
  -> crank_epoch (keeper) -> epoch settles pro-rata in base AND quote
  -> claim_withdraw()             # unchanged: pays base + quote pro-rata
  -> OPTIONAL: convert the unwanted token -> selected token
        (Phase 5: separate, user-approved swap with min-out; disclose price risk)
```
The vault payout is always pro-rata; single-token is a **post-claim conversion**,
never a vault guarantee.

---

## 8. Test matrix

| Area | Cases |
|---|---|
| Solver | both directions converge on representative `Bnet:Qnet`; parity with `expectedDepositShares`; zero-share rejected; insufficient-SOL rejected; non-convergence rejected; extreme ratio |
| Tx | all instructions in **one** tx; `feePayer`+blockhash set; expected PDAs/ATAs present; no `min_shares=1` |
| Atomicity | failed route / simulation error → balances + share supply unchanged |
| Preview | exact raw-atom values = on-chain math; never `NaN`/∞ on missing data |
| Withdraw UX | no wallet / no shares / warm-up / queued / claimable / claimed / RPC error |
| Route adapter | decode + inspect ix; reject stale/missing output; `supports()` gating |
| Regression | existing `npm test`, `tsc -b`, `oxlint`, `banned_words.py` CLEAN |

---

## 9. Acceptance criteria

- One asset in → LP in **one atomic tx**; any failed step reverts all.
- Shares from matched two-token contributions only, via the existing rule.
- Route `min-out` and deposit `min_shares` both enforced; failure reverts.
- Dust/refund returned; vault never underfunded by rounding.
- Withdrawal stays pro-rata on-chain; single-token is a disclosed conversion.
- Existing two-sided deposit, warm-up, epoch queue, claim, locked-liquidity, and
  liability accounting unchanged and regression-tested.

---

## 10. Deployment (no waiting)

1. `cd app && npm run lint && npm test && npm run build` (green).
2. Commit + push to the deploy branch (`volatility`) → Vercel rebuilds.
3. Verify the hosted build (SOL-only and USDC-only deposit paths visible).
4. Rollback = redeploy the previous commit (frontend only; no chain state).

No program upgrade, no PDA, no timelock, no on-chain state change.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Thin Devnet route liquidity | Phase 0 spike; fall back to a direct devnet pool instruction; provider adapter makes it swappable |
| Route ix + deposit exceed tx size/compute | use **v0 + ALT**; if it still cannot fit reliably, **stop and reassess** (never silently split into two txs) |
| Multi-deposit ticket overwrite | Phase 6 guard; never overwrite an unclaimed ticket |
| Preview vs execution drift | re-check state immediately before submit; enforce `min-out` + `min_shares`; rebuild on drift |
| Decimal/rounding errors | all math in raw `bigint` atoms via `expectedDepositShares`; no float previews |

---

## 12. Suggested delivery order (shippable increments)

1. **Phase 1 alone** ships independently: correct previews + clear withdrawal UX
   (frontend-only, immediate deploy).
2. **Phases 2–4**: atomic one-sided **deposit**.
3. **Phase 5–6**: single-token **withdrawal** + ticket guard.
4. **Phases 7–8**: E2E + deploy.

Each increment is independently deployable and adds no on-chain delay.
