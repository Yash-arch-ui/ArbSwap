# One-Sided Deposit, LP Share Math, and Withdrawal Plan

**Status:** Research and proposal only — no program or application code changed.  
**Scope:** Existing ArbSwap two-asset market-making vault and `app/src/pages/VaultPage.tsx`.

## Executive recommendation

Implement one-sided deposits as a **single atomic Solana transaction that converts part of the user's selected asset through an external swap route, then calls the existing proportional vault deposit**. The conversion and deposit must both succeed or both revert. Calculate the paired amounts against the vault's LP-eligible reserves, enforce a user-specified minimum swap output and minimum LP shares, and return unused input/output dust to the user. Do not treat an unconverted one-asset transfer as liquidity and do not mint shares from oracle value alone.

For withdrawals, the app already has a `Withdraw (Epoch Queue)` tab on the vault page, backed by `request_withdraw` and `claim_withdraw`. The gap is not an absent withdrawal screen; the current screen only offers pro-rata two-token output. The proposal is to make that screen a clear, fully reviewed withdrawal experience with **Pro-rata (both tokens)** as the default and an optional **single-token output** mode. Single-token output should be implemented as a queued pro-rata claim followed by an atomic swap of the unwanted token where feasible, or explicitly shown as a separate swap after claim. Preserve current epoch settlement and ticket semantics.

This is the best fit for ArbSwap because the vault is an oracle-anchored, actively quoting market-making vault, not a constant-product pool. Its actual LP ownership math is currently reserve-proportional and excludes fee liabilities. A generic constant-product single-sided-deposit formula cannot be safely applied to it.

## Findings in the current repository

### Vault program and LP accounting

- `vault/program/src/lib.rs::deposit` currently rejects either amount being zero. Existing deposits must provide both base and quote.
- For an initialized vault, the program mints `min(floor(dB*S/Bnet), floor(dQ*S/Qnet))` shares. `Bnet` and `Qnet` are the reserve token-account balances less tracked insurance, keeper, and protocol balances.
- The program only transfers amounts needed to support the minted shares. Excess input amounts are not pulled, avoiding an accidental donation.
- Initial deposits mint geometric-mean shares, subtract `min_liquidity` for the depositor, and mint locked minimum-liquidity shares. `MATH.md` describes this model.
- New deposit shares receive a warm-up ticket. Withdrawals transfer shares into the vault's queue, settle in a later epoch, and pay out pro-rata from available reserves (`request_withdraw`, `crank_epoch`, `claim_withdraw`).
- This share formula is not oracle-priced and deliberately does not value base and quote in a common unit. That is appropriate for accounting proportional ownership in the current system; it also means a single-sided deposit must become a matched two-asset contribution before minting shares.

### Frontend and transaction flow

- `app/src/pages/VaultPage.tsx` is already the vault deposit/withdraw interface with two tabs. Deposit UI currently auto-fills the other side using `quoteState.oraclePrice`, displays an approximate share estimate using floating-point human units, and submits both amounts.
- The transaction helper `expectedDepositShares` in `app/src/chain/program.ts` reproduces integer share math with `bigint` and `vaultAtoms`; this should be the canonical basis for previews and minimum-share calculations, not the human-unit approximation.
- The existing withdrawal UI estimates base/quote amounts pro-rata and shows claim readiness. It needs UX and accounting review, but a brand-new separate withdrawal route is not currently present in the app structure.
- One PDA ticket per user is used for deposits and withdrawals. Any design must define how additional deposits/withdrawals behave while a prior ticket is still active; one-sided support must not silently overwrite an unclaimed ticket.
- The app's currently configured vault uses SOL/USDC, while program semantics are generic base/quote. UI labels should use configured mint metadata rather than hard-coded assumptions in any generalized version.

## Prior-art findings and design implications

| Prior art | Documented approach | Relevance to ArbSwap |
|---|---|---|
| Uniswap v2 | New LP shares are proportional to existing supply and reserves; existing deposits should match reserve ratios. Unequal deposits alter pool value/price and expose value to arbitrage. | Supports matched-asset contribution and slippage bounds; the constant-product swap-to-LP formula is not directly reusable because ArbSwap is not a constant-product pool. |
| Balancer | Explicit single-token joins/exits exist, priced as pool-specific math that accounts for the pool invariant and swap fees. | Demonstrates that single-sided liquidity is a first-class join type only when pool-specific invariant math is explicitly supported. ArbSwap would need distinct, separately reviewed single-sided accounting if implemented natively. |
| Meteora DLMM | One-sided positions are supported as a strategy/range decision; token placement varies with bins and price location. | Shows one-sidedness may express inventory/range intent, not merely a convenience conversion. ArbSwap has a different continuous quote ladder and no per-LP range positions. |
| Raydium CPMM | Classic CPMM deposits mint LP tokens for proportional two-token amounts; UI can enter one side and calculate the paired side from pool ratio. | Closest UX pattern, but its share formula assumes CPMM pool reserves. Reuse the one-sided input UX, not its invariant math. |
| Saber StableSwap | Documentation describes imbalanced deposits with fees that incentivize balance, and single-token withdrawal options in the UI. | Useful evidence that imbalanced deposits require explicit fee treatment and that withdrawal token selection belongs in a withdrawal interface. StableSwap's invariant/fee math is not applicable to ArbSwap. |

The meaningful design lesson is: **a one-sided UI is not itself a share-minting rule**. Protocols either convert the asset into the pool's accepted deposit composition or explicitly price the imbalanced join against their invariant, including fees. ArbSwap currently has only the proportional join rule.

## Proposed one-sided deposit flow

### Recommended v1: atomic convert + proportional join

1. User chooses input mint and enters an amount. Show the selected route, expected paired-token output, conversion fee/price impact, expected matched deposit amounts, minimum shares, and any remainder.
2. Read fresh vault state and compute LP-eligible `Bnet`, `Qnet`, and `S` as the program does. Exclude fee-liability buckets. Do not use the oracle price as the share minting ratio.
3. Obtain an external swap quote (for example, through a documented Jupiter route integration) that converts only the portion needed to reach the current proportional composition. Solve iteratively from the route quote/output, not using a closed-form constant-product formula unless that route is actually a CPMM with the exact known fee model.
4. Build one transaction containing the aggregator swap instruction(s) and the existing `deposit(base_amount, quote_amount, min_shares)` instruction. Deposit only the amounts required for shares; return all dust to the wallet. The transaction must be atomic.
5. Set `min_out` for the route and `min_shares` for the deposit using the user-selected slippage limit. Reject if the quote is stale, route output is below minimum, expected shares are zero, or post-swap amounts cannot satisfy nonzero two-sided deposit requirements.
6. After confirmation, display the actual deposit event, minted shares, activation slot, actual amounts used, and amounts left in the wallet.

This first version can keep the on-chain vault deposit invariant unchanged: it still receives both tokens and mints shares exactly as today. The external route introduces venue/route risk and transaction account/compute limits, so the route must be visible and all instructions must share one transaction. If the chosen aggregator instruction set cannot fit reliably, stop and reassess instead of falling back silently to two transactions.

### Alternative considered: native single-sided instruction

Adding `deposit_single_sided` to the vault could pull one asset, convert inventory internally, and mint shares. However, the vault has no AMM invariant that supports token-in-for-share-out; its swap engine is an oracle-anchored finite ladder, while deposits use reserve-proportional share ownership. Native conversion would need explicit decisions about whose quote is crossed, whether the swap changes the user's price or LP reserve composition, how trading fees/liability buckets apply, how quote expiry/version is enforced, and how to ensure no depositor trades against themselves or manipulates the quote before joining. This is a larger protocol feature and likely an upgrade/migration plus extensive economic and security review. Do not start here for the convenience flow.

## LP share math and invariants

Let `Bnet` and `Qnet` be reserve balances after subtracting tracked liabilities, `S` be total share supply including locked liquidity, and `dB`, `dQ` be amounts transferred in and accepted by the vault.

For an initialized vault:

```text
shares = min(floor(dB * S / Bnet), floor(dQ * S / Qnet))
used_B = min(dB, ceil(shares * Bnet / S))
used_Q = min(dQ, ceil(shares * Qnet / S))
S_new  = S + shares
```

The first deposit remains:

```text
root   = floor(sqrt(dB * dQ))
shares = root - min_liquidity
S_new  = root
```

Recommendations:

- Keep all on-chain calculations integer-only and checked for overflow. Continue flooring minted shares and rounding required inputs up, so the vault does not become underfunded from division rounding.
- Derive previews from raw token atoms (`bigint`) and available reserves exactly as the program does. The current UI estimate via `parseFloat`, float reserve quantities, and `Math.floor` may be inaccurate for decimals, large quantities, fee buckets, and rounding.
- Show share output as an estimate with explicit slippage and stale-state caveats. Pass a conservative `min_shares`; never submit a hardcoded minimum of 1.
- Do not calculate share ownership using USD/oracle NAV. The oracle may inform a route/valuation display, but the minting contract remains based on actual LP-eligible contributions.
- Define minimum deposit sizes so one side does not round to zero shares/used atoms. Reject zero-share results before sending.
- Reconcile total share supply, locked shares, user share token supply, queued shares, and `vault.total_shares` on every deposit/withdrawal test. Existing behavior should be regression-tested before altering math.
- Define multi-deposit ticket behavior. A second deposit must not overwrite a still-active deposit ticket; either require prior activation/settlement or change ticket representation safely.

## Withdrawal page / flow proposal

The current `VaultPage` has a withdrawal tab; evolve it into an explicit withdrawal panel or page with two output choices:

1. **Pro-rata (recommended/default):** user enters shares or selects a percentage; show estimated base and quote outputs from current LP-eligible reserves, pending epoch, claim status, and any rounding. This maps directly to the existing queue and claim instructions.
2. **Single token (optional follow-up):** user chooses base or quote output. Queue/claim still settles pro-rata on-chain. Convert the unwanted token to the selected token using a user-approved route with minimum output. Prefer an atomic composition where account/compute constraints permit; otherwise make the swap a clearly separate action after claim, with the output and price risk disclosed. This should not imply the vault itself guarantees single-token payout.

For both modes, show the actual wallet share balance (not `vaultState.userShares` if that is stale), max/percentage shortcuts, shares being queued, expected underlying outputs, epoch and warm-up constraints, ticket state, and claim button state. Ensure output estimates subtract the same tracked liabilities as the program. Preserve existing epoch settlement and ticket account binding. UX must handle no ticket, pending ticket, claimable ticket, already-claimed/zero-share ticket, and RPC/data-loading states.

## Delivery plan

### Phase 0 — verify and specify

- Confirm current withdrawal-ticket lifecycle and whether users can have one outstanding ticket of each type; document the behavior before changing transaction composition.
- Confirm exact reserve/total-share values and liability subtraction from on-chain state. Identify whether frontend `vaultAtoms` already exposes raw net values consistently.
- Decide supported external route provider, transaction version, priority-fee policy, account/compute budget, and supported token programs/mints.
- Write a short interface contract for quote freshness, swap minimum output, minimum shares, dust handling, and failures.

### Phase 1 — correct previews and withdrawal UI

- Replace floating-point deposit preview with exact raw-atom `expectedDepositShares` logic and identical values for the preview and `min_shares` calculation.
- Correct withdrawal estimates to use LP-eligible net reserves and raw share atoms; display estimates separately from final claim amounts.
- Improve the existing withdraw tab into the two-token default withdrawal page/panel with clear queue → epoch settlement → claim states.
- No one-token payout promise until the swap route behavior is implemented.

### Phase 2 — one-sided deposit via atomic route

- Add route quote and instruction assembly to the client transaction path; inspect returned instructions and accounts before signing.
- Quote input-to-paired-token conversion and solve for the amount that results in a proportional deposit against the latest `Bnet:Qnet` ratio.
- Compose conversion + existing deposit + ATA setup as one atomic transaction, with explicit minimum output and minimum shares.
- Recheck vault snapshot/quote freshness immediately before submission; use transaction simulation/preflight and fail visibly on state drift.
- Keep conversion and share minting separable in events/analytics so deposited value and route cost can be reconciled.

### Phase 3 — one-token withdrawal output

- Add optional conversion after the epoch claim, starting with a clear separate swap if atomic same-transaction claim-plus-swap is not practical.
- Ensure the UI describes the vault payout as pro-rata and the selected token as a post-claim conversion.
- Consider native single-asset withdrawal only if a compelling product requirement remains and formal math/security review is funded.

## Required tests and acceptance criteria

### Share-math and program tests

- Existing golden/property tests continue passing; add cases for zero/near-zero amounts, large atom values, rounding boundaries, extreme reserve ratios, and fee-liability-adjusted reserves.
- Any native instruction must prove: no zero shares; no reserve underfunding; no value minted for a contribution below accepted minima; fee buckets unchanged unless explicitly specified; and no locked-share accounting drift.
- Test first-depositor/locked-liquidity behavior and initialized-vault deposits separately.
- Test a one-sided input for each token direction, amount just under the minimum, extreme ratio, stale quote, slippage failure, insufficient balance, and failed aggregator instruction. Atomic failure must leave wallet/vault balances and share supply unchanged.
- Test dust/refund amounts and exact event amounts against actual token transfers.

### Frontend/transaction tests

- Preview shares match program integer math for different mint decimals and very large amounts; never display `NaN`/infinity on unavailable reserve data.
- Quote changes between preview and execution fail at the specified minimums rather than silently minting fewer shares.
- Transaction instructions are all in one transaction for one-sided deposit; inspect that user, vault, mints, reserve accounts, share mint, and ticket PDAs are expected.
- Test withdraw UI states: no wallet, no shares, pending deposit warm-up, pending withdrawal epoch, claimable, claimed, and RPC errors.
- Verify estimates use available reserves and accepted share amounts and clearly label output as estimated.

### Acceptance criteria

- One-sided user flow takes one asset and finishes in one atomic transaction; any failed step reverts the entire operation.
- Shares are minted by the existing proportional rule from matched two-token amounts, with precise on-chain raw-unit math and minimum-share protection.
- UI discloses swap route, expected/minimum output, price impact/fees where available, share estimate, and remainder.
- Existing two-sided deposit, warm-up, queued pro-rata withdrawal, claim, locked liquidity, and liability accounting remain intact.
- Withdrawal experience explicitly supports the current both-token pro-rata payout; optional single-token output is represented as a conversion and never as a guaranteed vault asset payout.

## Research references

Official or primary documentation where possible; read as mechanism references, not claims that their exact math applies to ArbSwap.

1. Uniswap v2 whitepaper — LP token initialization and reserve-proportional minting: <https://uniswap.org/whitepaper.pdf>
2. Uniswap v2 pools — pool tokens and proportional ownership: <https://docs.uniswap.org/docs/protocols/v2/concepts/pools>
3. Uniswap v2 liquidity provisioning — ratio matching and slippage-aware adds: <https://developers.uniswap.org/docs/protocols/v2/guides/providing-liquidity>
4. Balancer v2 pool joins — single-token join kinds: <https://docs-v2.balancer.fi/reference/joins-and-exits/pool-joins.html>
5. Balancer v2 pool exits — single-token vs proportional exits: <https://docs-v2.balancer.fi/reference/joins-and-exits/pool-exits.html>
6. Meteora DLMM strategies — one-sided liquidity as a bin/strategy choice: <https://docs.meteora.ag/core-products/dlmm/strategies-and-use-cases>
7. Meteora DLMM overview — bin architecture and one-sided positions: <https://docs.meteora.ag/core-products/dlmm/what-is-dlmm>
8. Raydium user flows — CPMM/CLMM add and remove liquidity UX: <https://docs.raydium.io/user-flows/add-remove-liquidity>
9. Raydium CPMM instructions — proportional deposit and pro-rata withdrawal: <https://docs.raydium.io/products/cpmm/instructions>
10. Saber providing-liquidity tutorial — imbalanced deposit fee disclosure and withdrawal currency choices: <https://docs.saber.so/getting-started/providing-liquidity>
11. Local protocol math: `MATH.md` §10; implementation: `vault/program/src/lib.rs::deposit`, `request_withdraw`, `claim_withdraw`; fixed-point tests: `vault/math/src/quote.rs`; UI: `app/src/pages/VaultPage.tsx`.

---

**Decision summary:** First fix exact share previews and make the existing queued withdrawal flow clear. Add one-sided deposits as an atomic external conversion followed by the existing proportional deposit. Avoid importing constant-product single-sided formulas into this oracle-priced market-making vault.
