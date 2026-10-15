# Frontend Interface Recommendations

## Highest-Impact Improvements
(j) - Jeremy has to do 
(y) Yash has to do 
(j/y) Anyone can to do 

** DO everything wrt current backend no mock data 
### 1. Trading Terminal

- Add a quote-health header: `LIVE`, `AGING`, `EXPIRED`, or `RPC ERROR`.(j)
- Show a countdown bar for remaining quote slots.(y)
- Display quote version, oracle age, keeper, spread, and expiry together.(y)
- Use a two-step flow: `Preview transaction` then `Confirm & sign`.( j )

### 2. Depth Visualization(j)

- Add a horizontal bid/ask depth chart.
- Highlight the requested size against available liquidity.
- Show the maximum executable size prominently.
- Replace partial-output estimates with an explicit depth warning and `Use max`.

### 3. Wallet Experience(j)

- Show wallet address, network, SOL, USDC, and WSOL balances together.
- Distinguish disconnected wallet, wrong network, insufficient funds, rejected signature, and confirmation states.
- Add a wallet setup checklist before enabling swaps.

### 4. Transaction Preview(j/y)

Show these details before the wallet prompt:

- Input and output tokens.
- Exact integer token amounts.
- Fee and slippage tolerance.
- Minimum received.
- Quote version and expiry.
- Wallet and network.
- Required ATAs.
- Estimated SOL fee.

Only show an explorer link after confirmation.

### 5. Visual Hierarchy(J)

- Use one accent color for executable states.
- Use amber for aging or attention states.
- Use red only for actual failures.
- Animate quote-version changes subtly.
- Align numerical columns and use monospace fonts for values.

### 6. Live State Feedback(J)

- Animate the quote version badge when a new commit is observed.
- Add a small last-updated indicator.
- Show a compact version history such as `v135 -> v136 -> v137`.
- Never animate stale data as if it were current.

### 7. Zero-Balance Funding Panel(J)

Include:

- Solana Devnet faucet link.
- Circle USDC faucet link.
- USDC mint address with copy button.
- `Wrap SOL` action.
- Checklist: `SOL -> USDC -> WSOL -> Ready`.
- Make another page(lets say : Docs) for it !!! and if a user doesnt have it while doing a SWAP redirect him to this page 

### 8. Mobile Layout

- Move the depth chart below the swap form on narrow screens.
- Keep the main action sticky at the bottom.
- Make transaction details expandable.
- Prevent wallet addresses and status badges from overflowing.

### 9. Overview and Risk Pages

Overview should prioritize:(J)

- Live TVL.
- Quote age.
- Vault status.
- Current market price.

Risk should display real gauges for:(Y)

- Oracle staleness.
- Confidence.
- Spread.
- Inventory.
- Quote expiry.

Label provenance clearly:

- `LIVE` for RPC-backed data.
- `INDEXED` for historical analytics.
- `MODEL` for simulation outputs.

### 10. Honest Microcopy(J)

Prefer precise messages:

- `Quote expired — keeper update required`
- `RPC unavailable — last value retained but not executable`
- `Wallet signature required`
- `Simulation failed: QuoteExpired`

Avoid vague messages such as `Something went wrong`.

## Recommended Implementation Order

1. Transaction preview and live countdown.
2. Depth chart and maximum-size flow.
3. Wallet and funding panel.
4. Transaction status lifecycle.
5. Mobile layout pass.
6. Overview and Risk visual polish.
7. Simulator visual refinement.

## Design Principle

The biggest improvement should come from making transaction preview and quote
health feel deliberate and trustworthy, not from adding decorative animation.

## Animation Plan By Surface

### Homepage / Overview

The homepage should receive the richest motion treatment because it introduces
the protocol and has no transaction-critical interaction.

**Hero section**

- Keep the existing aurora background, but use a slow 18–30 second movement cycle.
- Keep particle motion subtle and pause it when the page is hidden.
- Add a soft glow pulse to the `Devnet` and verification indicators.
- Animate the headline once on entry or scroll; do not continuously animate text.
- Add a gentle upward fade to the primary CTA and secondary CTA.

**Live protocol strip**

- Pulse only when the quote version actually changes.
- Animate the version number with a short crossfade or slide.
- Do not animate a slot counter continuously unless the value is genuinely live.
- Use a distinct `LIVE`, `EXPIRED`, or `UNAVAILABLE` transition.

**Metrics ribbon**

- Fade values in after artifact data loads.
- Use a short number transition only when a real value changes.
- Keep unavailable values static as `Unavailable` or `n/a`.
- Do not count from zero to a model value on every page load; that makes static
  data look live.

**Problem and mechanics cards**

- Reveal cards with a staggered 40–70 ms delay as they enter the viewport.
- Use a small translate-y and opacity transition, not large scale effects.
- Animate the protocol diagrams once when visible.
- Keep equations readable and static after their reveal.

**Homepage CTA cards**

- Add a small border-color and translate transition on hover.
- Use a single arrow or underline movement for navigation affordance.
- Avoid bouncing, rotating, or continuously glowing buttons.

### Navbar

- Animate the active-tab underline or border with a 150–220 ms transition.
- Pulse the quote-version indicator only when a new on-chain version arrives.
- Animate wallet connection state from disconnected to connected with a short
  color transition.
- Keep the navbar stable while scrolling; avoid excessive movement.

### Swap Page

Swap animations must communicate state, not create urgency.

**Quote lifecycle**

- Animate the countdown bar continuously but subtly.
- Transition `Fresh → Aging → Expired` with color and label changes.
- Flash the quote version briefly when a new verified version arrives.
- Animate depth rows only when the actual quote version changes.
- Never animate an expired quote as if it were current.

**Depth ladder**

- Use a short width transition when real level capacity changes.
- Highlight the user's selected input size against available depth.
- Animate the `Use max` action with a brief input highlight.
- Show a clear red/amber state when the requested size exceeds depth.

**Transaction flow**

- `Preview`: fade and slide in the preview card.
- `Simulating`: show a compact spinner or progress indicator.
- `Wallet signature required`: use a static attention state with a subtle pulse.
- `Confirming`: show a progress state with the signature when available.
- `Confirmed`: use a brief success transition, then settle to a static status.
- `Failed`: use a stable error panel; do not shake the entire page.

**Wallet modal**

- Animate the modal backdrop opacity and panel translate-y.
- Do not animate wallet icons continuously.
- Keep rejection and disconnection messages visible until dismissed or replaced.

### Vault Page

- Animate TVL and reserve values only when a new live read arrives.
- Use a smooth transition for inventory-ratio changes.
- Animate deposit/withdraw tabs with a short underline transition.
- Show a progress state while a wallet transaction is pending.
- After confirmation, briefly highlight the changed balance or ticket row.
- Do not animate unavailable values from zero; show `Unavailable` directly.

### Risk Page

- Animate risk gauges when the underlying live value changes.
- Use a slow breathing pulse for a healthy status indicator.
- Use a stronger but controlled pulse for a tripped breaker.
- Transition parameter-bound rows only when Config changes on-chain.
- Keep `Unavailable (keeper-local)` static and visibly distinct from healthy data.
- Do not show green animation for stale or unavailable oracle data.

### Analytics Page

- Fade chart panels in after the artifact bundle loads.
- Draw model/replay charts once on entry with a short path animation.
- Animate hover tooltips and selected windows only.
- Do not animate historical metrics continuously.
- Add a small `MODEL`, `INDEXED`, or `LIVE` provenance badge transition when the
  source state changes.
- Keep missing analytics visibly unavailable instead of filling charts with zeros.

### Simulator Page

This is the correct place for richer animation because it is explicitly offline.

- Animate the mid-price line and PnL lines during playback.
- Animate scenario transitions with a short crossfade.
- Highlight attack events such as `oracle frozen`, `keeper killed`, `flow cap
  binds`, and `breaker trips`.
- Animate play/pause and speed controls.
- Show a persistent `SIMULATION — NO FUNDS INVOLVED` label.
- Keep the seed visible so every replay is reproducible.
- Never imply that simulator frames are live chain observations.

### Evidence And Claims

Claims and historical evidence should be mostly static.

- Use a subtle reveal when evidence rows enter the viewport.
- Animate explorer-link hover states only.
- Highlight verified signatures with a short confirmation transition when copied.
- Do not animate historical signatures, claims, or model outcomes as live data.
- Keep negative results and `NOT CLAIMED` states visually prominent.

### Funding Panel

- Fade the panel in when a connected wallet has zero relevant balances.
- Animate the copy-button state from `Copy` to `Copied` for about 1.2 seconds.
- Show a short step-completion transition when a balance becomes nonzero.
- Do not display a success state before an actual balance refresh.

### Global Motion Rules

- Default transition duration: 150–250 ms for controls and 300–600 ms for
  viewport reveals.
- Use spring motion only for panels, drawers, and wallet modals.
- Pause canvas, timers, and replay loops when the document is hidden.
- Honor `prefers-reduced-motion: reduce` by disabling particle movement, chart
  drawing, number rolling, and repeated pulses.
- Animate only after the relevant data has a valid provenance state.
- Never use animation to conceal loading, stale data, failed RPC reads, or pending
  wallet signatures.

## Implementation Order

1. Homepage hero, live-status pulse, and scroll reveals.
2. Swap countdown, quote-version transition, depth updates, and transaction states.
3. Wallet modal and funding-panel transitions.
4. Vault and Risk live-value transitions.
5. Analytics provenance and chart-entry animations.
6. Simulator playback and attack-event animation.
7. Reduced-motion, hidden-tab pausing, and mobile performance review.

## Acceptance Checks
- Just check it genuinely looks good !!!!! leaving just implementing it !! see whather it genunely looks good or not .......
- Verify every animation is driven by real state or deterministic simulator data.
- Confirm expired quotes never receive a Fresh animation.
- Confirm no success animation appears before transaction confirmation.
- Test desktop, mobile, slow RPC, wallet rejection, quote expiry, and reduced-motion.
- Capture screenshots for Homepage, Swap Fresh, Swap Expired, Depth Exceeded,
  Zero Balance, Simulator, and Claims/Evidence history states where applicable.



