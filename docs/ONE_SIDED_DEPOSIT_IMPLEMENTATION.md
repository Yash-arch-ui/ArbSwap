# One-Sided Deposit & Single-Token Withdrawal — Implementation Spec

**Purpose:** implementation-ready instructions for a coding agent. This is the build
spec derived from `docs/ONE_SIDED_DEPOSIT_WITHDRAWAL_PLAN.md` (research/proposal).
**Status:** not implemented.
**Program changes:** none for v1. The on-chain vault `deposit` invariant is unchanged.

---

## 1. Goal

Let a user become an LP by supplying **only one asset** (SOL or USDC), and let a user
receive **only one asset** back when withdrawing, without changing the vault's
proportional-share model.

- Deposit: convert part of the input through an external swap route, then call the
  existing proportional `deposit(base, quote, min_shares)` in the **same atomic
  transaction**.
- Withdrawal: settle pro-rata as today, then optionally convert the unwanted token
  after claim.

---

## 2. Non-goals (do NOT do in v1)

- Do **not** add a native `deposit_single_sided` instruction.
- Do **not** apply constant-product (Uniswap v2 / CPMM) single-sided formulas.
- Do **not** mint shares from oracle/USD NAV.
- Do **not** guarantee a single-token vault payout. The vault always pays pro-rata.
- Do **not** submit two separate transactions for the deposit flow.

---

## 3. Files and symbols to use

Read these before coding.

| Concern | Path | Symbols |
|---|---|---|
| Deposit tx helper | `app/src/chain/program.ts` | `deposit`, `getProgram`, `anchorWallet`, `deriveVaultAddresses`, `fetchProtocolState`, `ensureAta`, `readAtaAmount`, `attachFeePayer` |
| Share preview math | `app/src/chain/program.ts` | `expectedDepositShares`, `bigintSqrt` |
| Wrapping | `app/src/chain/wrappedSol.ts` | `wrapSolInstructions`, `unwrapSolInstructions`, `MIN_SOL_FOR_FEES` |
| Withdraw flow | `app/src/chain/program.ts` | `requestWithdraw`, `claimWithdraw`, `withdrawTicket` |
| UI | `app/src/pages/VaultPage.tsx` | `handleDeposit`, `depositSol`, `depositUsdc`, `activeTab` |
| Program (reference) | `vault/program/src/lib.rs` | `deposit`, `request_withdraw`, `claim_withdraw` |
| Math (reference) | `vault/math/src/quote.rs`, `MATH.md` §10 | share math |

There is **no** swap aggregator dependency today. Add one (see §4) or add a
provider adapter.

---

## 4. New modules to add

### 4.1 `app/src/chain/routes.ts` — swap-route adapter

Define a provider-neutral interface so the flow is testable and the provider can be
swapped.

```ts
export interface RouteQuoteRequest {
  inputMint: string;      // base58
  outputMint: string;     // base58
  amountInAtoms: bigint;  // raw atoms of inputMint
  slippageBps: number;
}

export interface RouteQuote {
  inputMint: string;
  outputMint: string;
  inAmountAtoms: bigint;
  outAmountAtoms: bigint;
  otherAmountThresholdAtoms: bigint; // provider min-out floor
  priceImpactPct: number | null;
  routeLabel: string;                // human-readable venue/route
  // Opaque provider payload needed to build the swap instruction(s):
  instructions: {
    programId: string;
    keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    data: string; // base64
  }[];
  addressLookupTableAddresses?: string[];
}

export interface SwapRouteProvider {
  name: string;
  supports(inputMint: string, outputMint: string): boolean;
  quote(req: RouteQuoteRequest): Promise<RouteQuote>;
}

export function getRouteProvider(): SwapRouteProvider; // configured provider
```

Rules:
- Decode provider instructions into `TransactionInstruction[]` and **inspect** them
  (program id, accounts) before signing.
- Reject quotes older than a fixed freshness bound or with missing `outAmountAtoms`.
- v1 may use a versioned transaction; if `supportsVersioned` is false, require the
  instruction set to fit a legacy transaction.

### 4.2 `app/src/chain/oneSidedDeposit.ts` — solver + builder

```ts
export interface OneSidedDepositPlan {
  inputMint: string;        // what the user pays
  pairMint: string;         // the other vault asset
  routeQuote: RouteQuote;
  baseAmountAtoms: bigint;  // matched base contribution
  quoteAmountAtoms: bigint; // matched quote contribution
  minShares: bigint;
  expectedShares: bigint;
  refundAtoms: bigint;      // unspent input returned to the wallet
  transaction: Transaction; // route swap + deposit, unsigned
}

export async function planOneSidedDeposit(args: {
  connection: Connection;
  wallet: unknown;             // useWallet().wallet (adapter-wrapped)
  inputMint: PublicKey;
  inputAmountAtoms: bigint;
  slippageBps: number;
  protocolState: ProtocolState; // from fetchProtocolState
}): Promise<OneSidedDepositPlan>;

export async function submitOneSidedDeposit(
  connection: Connection, wallet: unknown, plan: OneSidedDepositPlan,
): Promise<string>;
```

---

## 5. Algorithm — solve the conversion amount

The vault mints shares by the **proportional** rule against LP-eligible reserves.
Let `Bnet`, `Qnet`, `S` be the on-chain net reserves and total share supply
(excluding insurance/keeper/protocol buckets, exactly as `deposit` does).

Given the user deposits only one asset, convert exactly enough of it into the pair
asset so the two contributions match `Bnet:Qnet`. Because external route output is
not linear (fees, price impact), solve iteratively; do **not** assume a closed form.

```
inputs: inputMint, I (input atoms), Bnet, Qnet, S, slippageBps

if inputMint == base:
    # need Q such that base_contribution / Bnet == Q / Qnet
    # we spend I in: some stays as base (dB), some is swapped to quote (dQ)
    # dQ = route_out(dB_swapped)
    find dB_used landing dQ == dB_used * Qnet / Bnet
else: symmetric (spend quote, swap to base)

iteration (max 6):
    guess convert_in (atoms of input to swap)
    q = provider.quote({inputMint, outputMint: pair, amountInAtoms: convert_in})
    matched = min(dB, floor(dQ * Bnet / Qnet))         # proportional target
    adjust convert_in toward the fixed point
    stop when |residual| <= tolerance (e.g. 1 atom of pair, or < 1 bps)
if not converged: throw new Error("Could not reach a proportional match; increase slippage or lower size.")

dB, dQ = matched contributions (input atoms + route-out atoms)
shares = min(floor(dB * S / Bnet), floor(dQ * S / Qnet))   # call expectedDepositShares
minShares = floor(shares * (10000 - slippageBps) / 10000)
usedB = min(dB, ceil(shares * Bnet / S))
usedQ = min(dQ, ceil(shares * Qnet / S))
refund = I - (input-side used amount)
```

Guards (throw, do not silently degrade):
- `shares <= 0n` → reject (deposit too small for current vault).
- route `outAmountAtoms < otherAmountThresholdAtoms` → reject.
- `Bnet <= 0n || Qnet <= 0n || S <= 0n` → vault not in a depositable state.
- input is native SOL and `inputAmountAtoms + MIN_SOL_FOR_FEES > walletSolAtoms` → reject.
- quote is stale / version drifted between plan and submit → rebuild, never reuse.

---

## 6. Transaction composition

One atomic transaction, in this order:

1. ATA setup for the input mint, pair mint, and share mint (only missing ATAs).
2. If input mint is native SOL: create/fund the WSOL ATA for the amount that will be
   swapped (`wrapSolInstructions`), and keep the non-swapped portion as base.
3. Provider swap instruction(s) converting `convert_in` input → pair asset.
4. If the pair mint is native WSOL and the deposited base must be WSOL: ensure the
   WSOL ATA holds the matched `dB` before `deposit`.
5. Existing `deposit(baseAmountAtoms, quoteAmountAtoms, minShares)`.
6. Dust handling: do not transfer more than the matched amounts. Any wrapped excess
   that cannot be used must be unwrapped/refunded in the same transaction where
   feasible; otherwise size the wrap to the exact matched amount.

Set `feePayer` and a fresh `recentBlockhash` via `attachFeePayer`. Sign only at
submit time. Simulate before signing; fail visibly on simulation error.

---

## 7. UI changes — `VaultPage.tsx` deposit tab

Current: `depositSol` + `depositUsdc` are both required and auto-filled from
`quoteState.oraclePrice`.

Required:
1. Add an **input-asset selector** (`SOL` | `USDC`) and a single amount input.
2. Show: selected route label, provider min-out, price impact/fees, expected matched
   `SOL`/`USDC`, share estimate, `min_shares`, and refund.
3. Button: `Deposit with SOL` / `Deposit with USDC` (disabled unless
   `TRANSACTIONS_ENABLED && vaultInitialized && connected`).
4. On click: build plan → simulate → show preview → on confirm, re-plan (fresh
   state) → `submitOneSidedDeposit`.
5. Never report success before the awaited send.
6. Keep the existing two-sided pro-rata path intact; this is additive.

Withdrawal tab (single-token output):
1. Keep **Pro-rata (both tokens)** as the default and only on-chain payout.
2. Add an optional **Output as** (`Both` | `SOL` | `USDC`) selector.
3. If single-token: label it clearly as a **post-claim conversion** of the unwanted
   token with a user-approved route and minimum output.
4. If atomic claim+swap is not practical, present the swap as a clearly separate
   action after claim. Disclose price risk.
5. Show states: no ticket, pending warm-up, queued epoch, claimable, claimed, error.

---

## 8. Ticket and multi-deposit behavior

- One PDA deposit ticket per user. A second deposit must **not** overwrite an active
  ticket. Before planning, read the deposit ticket; if active, either block with a
  clear message or require the prior ticket to activate. Document the chosen rule.
- Withdrawals use the existing queue/ticket semantics; do not change them.

---

## 9. Tests

Add under `app/test/`.

Route adapter (`routes.test.ts`):
- decodes provider instructions; rejects stale/missing output; supports() gating.

Solver (`one-sided-deposit.test.ts`):
- converges for both directions on representative `Bnet:Qnet`.
- `shares` and `minShares` match `expectedDepositShares`.
- rejects zero-share, insufficient SOL for fees, non-convergence.

Transaction (`one-sided-deposit-tx.test.ts`):
- all instructions (wrap + route swap + deposit) are in **one** transaction.
- `feePayer` and `recentBlockhash` are set.
- expected accounts/PDAs present; no hardcoded `min_shares = 1`.

Failure/atomicity:
- route failure / simulation error leaves balances and share supply unchanged.
- quote drift between plan and submit triggers a rebuild, not a reduced-share mint.

UI (`vault-one-sided.test.tsx` source assertions at minimum):
- single-asset selector present; preview fields rendered; success after await.

Regression:
- full existing suite stays green (`npm test`), `tsc -b`, `oxlint`, and
  `python3 scripts/banned_words.py` = `CLEAN`.

---

## 10. Acceptance criteria

- A user supplies only SOL or only USDC and becomes an LP in **one atomic tx**.
- Shares come only from matched two-token amounts via the existing proportional rule.
- Min-out (route) and min-shares (deposit) are both enforced; failures revert.
- Refund/dust is returned; the vault is never underfunded by rounding.
- Withdrawal remains pro-rata on-chain; single-token output is a disclosed conversion.
- No fabricated previews: values derive from raw atoms and live reserves.
- Existing two-sided deposit, warm-up, epoch queue, claim, and locked-liquidity
  behavior are unchanged and regression-tested.

---

## 11. Build order

1. `routes.ts` adapter + tests (mock provider).
2. `oneSidedDeposit.ts` solver + `expectedDepositShares` parity tests.
3. Transaction composition + fee payer + simulation guard.
4. VaultPage deposit UI (single-asset input) wired to plan/submit.
5. Withdrawal tab single-token output (post-claim swap).
6. Ticket/multi-deposit guard.
7. Devnet E2E: deposit SOL-only and USDC-only, then withdraw both ways.
8. Redeploy frontend; verify on the hosted build.
