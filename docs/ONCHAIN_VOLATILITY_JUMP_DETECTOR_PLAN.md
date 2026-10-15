# On-Chain EWMA Volatility and Jump Detector Plan

**Status:** Proposal only. No program or frontend code changes are included.  
**Goal:** Make volatility and jump detection independently verifiable on Solana instead of relying only on keeper-local calculations.

## Decision

Move the volatility state and jump detector on-chain. Keep the keeper responsible for proposing quotes, but make the program calculate and enforce the volatility-dependent spread and depth limits.

Use a separate PDA instead of enlarging the existing `QuoteState` account:

```text
volatility_state = PDA(["vol", vault])
```

This avoids unnecessary `QuoteState` layout migration risk and gives the volatility state its own lifecycle.

## Current state

- EWMA volatility is calculated in `vault/keeper/src/lib.rs`.
- The keeper also calculates the jump flag, volatility spread component, depth throttle, jump cooldown, and adaptive priority fee.
- The on-chain program verifies Pyth data and enforces quote bounds, expiry, anchor movement, spread movement, utilization, and flow limits.
- Raw EWMA and jump state are not currently stored on-chain.
- The frontend must not present keeper-local volatility as independently verified protocol state.

## Proposed on-chain state

The new `VolatilityState` account should contain:

```text
short_ewma_q64
medium_ewma_q64
last_price_q64
last_publish_time
last_observation_slot
jump_detected
observation_nonce
bump
```

All values must use checked integer/fixed-point arithmetic. No floating-point values may be used on-chain.

## Permissionless observation instruction

Add a permissionless instruction with the conceptual interface:

```text
observe_volatility(pyth_price_update)
```

The instruction must:

1. Verify Pyth account ownership, feed identity, verification level, price, confidence, and freshness.
2. Reject an older or repeated `publish_time`.
3. Calculate the return from the previous stored price.
4. Apply time-normalized short and medium EWMA updates.
5. Calculate the jump flag.
6. Store the new state atomically.
7. Increment the observation nonce.
8. Emit a `VolatilityObserved` event.

Anyone may submit a valid observation. The observer receives no authority over the vault and cannot alter the configured risk parameters.

## EWMA calculation

The on-chain implementation must match the keeper reference implementation bit-for-bit.

Conceptually:

```text
return = abs(current_price - previous_price) / previous_price

ewma_new = decay(dt) * ewma_old
         + (1 - decay(dt)) * return
```

The implementation must specify behavior for:

- First observation
- Same publish time
- Older publish time
- Large time gaps
- Zero or invalid prices
- Extreme returns
- Integer overflow
- Price decimal normalization

The keeper and program must share golden vectors for these cases.

## Jump detection

The initial rule should be:

```text
jump_detected = return > jump_multiple * short_ewma
```

When a jump is active, the protocol may:

- Increase the minimum permitted spread
- Reduce permitted quote depth
- Apply a jump cooldown
- Increase the keeper priority fee recommendation
- Stop quoting if the configured volatility kill-switch is exceeded

The exact response must be configured through the existing timelocked configuration path.

## Quote enforcement

The keeper can continue proposing:

- Anchor price
- Spread
- Ladder levels
- Depth multiplier

The program must validate those values against `VolatilityState`:

```text
spread >= volatility-derived minimum
depth <= volatility-derived maximum
jump restrictions are respected
sigma <= configured maximum
```

The keeper must not be able to submit a quote that claims low risk while the on-chain state records high volatility or an active jump.

## Transaction lifecycle

The preferred lifecycle is:

```text
observe_volatility()
update_quote()
commit_quote()
```

The keeper may submit the observation and quote updates close together, but the volatility observation must be independently permissionless.

Keeping observation separate is important because a rejected quote must not roll back a valid oracle observation. A large price move should still be recorded even when the proposed quote is rejected by anchor or spread limits.

## Configuration additions

Add timelocked configuration values for:

- Short EWMA decay
- Medium EWMA decay
- Jump multiplier
- Maximum volatility
- Jump cooldown duration
- Volatility spread coefficient
- Volatility depth coefficient
- Maximum observation age

Parameter validation must reject invalid decay ranges, zero denominators, unsafe multipliers, and inconsistent maximum/minimum bounds.

## Frontend requirements

### Placement decision

Show the volatility and jump-detector values in the **existing Risk page Keeper Eligibility card**. Do not create a separate page.

This is the correct location because volatility is a risk-control input, not a user action or trading workflow. A separate page would fragment the explanation and make the demo harder to follow. The current card already contains keeper eligibility and slashing information, so the volatility regime belongs directly below those rows.

Keep the card compact and display the actual numbers, not a separate chart:

```text
Keeper Eligibility       Permissionless / Bonded
Configured keeper        <address>

Volatility Regime        ON-CHAIN VERIFIED
Short EWMA               <value>
Medium EWMA              <value>
Jump Detector            CLEAR / ACTIVE
Observation age          <seconds or slots>
```

Recommended presentation:

- Use a small `Volatility Regime` subsection inside the same card.
- Show `CLEAR` or `ACTIVE` as a colored status badge for the jump detector.
- Show short and medium EWMA as numbers with their unit and fixed precision.
- Show observation age so the user can distinguish current state from stale state.
- Show `ON-CHAIN VERIFIED` beside the subsection heading.
- Keep the configured keeper address and slashing-condition footer unchanged.
- Do not create a new volatility page for the hackathon demo.

Before the volatility PDA exists, or when its observation is stale, leave the value area blank and show a small state label such as `Awaiting verified observation`. Do not show keeper-local fallback numbers.

The Risk page should display the following only after the new account is readable:

```text
Short EWMA Volatility       <value>
Medium EWMA Volatility      <value>
Jump Detector               CLEAR / ACTIVE
Last Oracle Observation     <publish time / slot>
Volatility State Nonce      <nonce>
Source                      Verified Pyth + on-chain calculation
```

The provenance label should be:

```text
ON-CHAIN VERIFIED
```

Before the account exists or the data is stale, the UI should show a blank/unavailable state rather than a keeper-local estimate.

The frontend must not display keeper-local EWMA values as protocol truth after this feature is enabled.

## Program and math tests

Add unit, property, and LiteSVM tests for:

- First observation initialization
- Normal price movement
- Increasing and decreasing volatility
- Jump activation
- Jump cooldown
- Replayed publish time
- Older publish time
- Stale Pyth update
- Wrong feed identity
- Wide confidence interval
- Large time gaps
- Decimal normalization
- Arithmetic overflow boundaries
- Permissionless observer behavior
- Invalid quote rejection against volatility state
- Volatility kill-switch behavior
- Keeper bypass attempts

Property tests must prove:

- EWMA calculations cannot overflow.
- Older observations cannot rewrite state.
- Jump detection is deterministic.
- Invalid oracle data cannot update state.
- A keeper cannot bypass volatility spread/depth limits.

## Migration and rollout

### Phase 1: Reference specification

- Freeze the exact EWMA, return, time-normalization, and jump formulas.
- Generate shared golden vectors from the keeper implementation.
- Decide whether the jump flag remains active for a fixed cooldown or until a normalized condition clears it.

### Phase 2: Math implementation

- Implement the fixed-point math in the shared math crate.
- Add Rust unit and property tests.
- Make keeper calculations consume the shared implementation.
- Confirm bit-exact results between keeper and program-side calculations.

### Phase 3: On-chain account and instruction

- Add the `VolatilityState` account and PDA validation.
- Add permissionless observation instruction.
- Add replay and monotonic publish-time protection.
- Add event emission and account-size tests.

### Phase 4: Quote integration

- Make quote generation consume the latest volatility state.
- Enforce spread/depth/jump limits during quote update or commit.
- Test behavior when volatility state is missing, stale, or expired.
- Ensure valid observations survive rejected quote proposals.

### Phase 5: Frontend

- Read and validate the `VolatilityState` account.
- Add on-chain volatility and jump fields to the Risk page.
- Display source, observation age, nonce, and stale status.
- Remove keeper-local values from any authoritative risk display.

### Phase 6: Devnet rollout

- Deploy the upgraded program to a test deployment first.
- Initialize the volatility PDA.
- Run an independent observer separate from the configured keeper.
- Verify normal movement, jump activation, quote rejection, and recovery.
- Publish transaction signatures and account snapshots for the demo.

## Security and economic review

Review these risks before deployment:

- An observer spamming repeated observations
- Oracle publish-time manipulation or replay
- EWMA reset through account reinitialization
- Overflow from extreme price changes
- Volatility state desynchronization from rejected quotes
- Keeper quoting against stale volatility state
- Excessive compute cost per observation
- A jump flag that never clears or clears too quickly
- Admin parameter changes weakening the detector

The volatility PDA must be seed-bound to the vault, initialized once, and impossible for a user or keeper to reset independently.

## Acceptance criteria

The feature is complete when:

- EWMA values and jump status are stored in a vault-bound on-chain account.
- Any valid observer can update the state from verified Pyth data.
- Replayed, stale, invalid, and wrong-feed observations are rejected.
- Keeper quotes are constrained by the on-chain volatility state.
- Keeper and program math match all golden vectors.
- The Risk page labels the values `ON-CHAIN VERIFIED`.
- Rejected quote attempts do not erase valid volatility observations.
- The complete behavior is covered by Rust, property, LiteSVM, and frontend tests.

## Final architecture

```text
Verified Pyth update
        |
        v
Permissionless volatility observation
        |
        v
On-chain EWMA + jump state
        |
        v
Keeper quote proposal
        |
        v
On-chain spread/depth validation
        |
        v
Executable, expiry-bound quote
```

This gives the hackathon demo a stronger trust model: the keeper proposes market parameters, but the protocol itself proves the volatility regime used to constrain those parameters.
