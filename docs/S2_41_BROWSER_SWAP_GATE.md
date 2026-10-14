# S2-41 — Frontend, Wallet, Swap, and Release Integration

Status: **BLOCKED: CONFIGURATION OR LIVENESS.** The frontend integration is finished
and the full release-check set is green, but acceptance gate **A** (`expiry_slots
== 120` independently verified) is not yet met, so the browser-wallet swap (gate
C) could not be attempted. Nothing was pushed; `demo-freeze-1` was not tagged.

## Phase 0 — on-chain configuration (verified)

`scripts/devnet/apply_params.ts status` + direct read, 2026-10-14T12:27Z, slot
510986357:

```
Config:        expiry_slots=10  grace=2  max_staleness=2  max_conf=10  fee=1  min_bond=0
PendingConfig: admin 8R3V…, activate_slot 511127388, eligible=false
```

- The S2-37 proposal is **still pending**; `expiry_slots == 120` is **not** active.
  Remaining ≈ 141,031 slots ≈ **9.7 h → ETA ~2026-10-14T22:12Z**.
- The `apply-expiry` runner is alive and polling (it now has 20 s RPC timeouts; it
  was recovered in `2e31576` after hanging). No duplicate proposal/apply.
- Gate A **FAILS** → per the task, only independent frontend work was done; the
  liveness (B) and real-swap (C) gates were not attempted.

## Phase 1 — per-page live integration (audited)

Every page reads live on-chain state or the real published artifact bundle; no
mocked data:

| Page | Source of truth |
|---|---|
| Overview | `ProtocolContext` (quote/vault/reserves/params/risk) + `useModelMetrics` (bundle, labelled model) |
| Swap | live `QuoteState` feed (processed, ~700 ms) + `fetchFreshQuote` at submit; integer ladder math |
| Vault | `ProtocolContext` + on-chain deposit/withdraw/claim instruction builders |
| Risk | `ProtocolContext` (breaker/params) with explicit "Unavailable (keeper-local)" where not on-chain |
| Analytics | `/artifacts/*.json` bundle (`useBackend`) + `OnchainAnalyticsPanel`; honest `n/a` states |
| Simulator | deterministic bundled streams (`demoStreams.json`), no network/wallet/tx |

Live quote state is the source of truth; the countdown is `expiry − current slot`;
states for loading / disconnected / wrong-cluster / stale / expired / RPC failure /
insufficient balance / executable are distinct, and a failed refresh can never leave
an old quote marked executable (the `LiveQuoteFeed` + state-aware gate).

## Phase 2 — transaction lifecycle (implemented + tested)

`SwapPage` now runs **build → simulate → preview → confirm**:

1. Re-read the live quote (`fetchFreshQuote`), require fresh, recompute integer
   `min_out` from the current committed ladder.
2. Build the transaction (`buildSwapTransaction`) and **simulate** it
   (`simulateSwap`) — a failing simulation is shown with an actionable reason and
   nothing is signed.
3. Present a **preview panel** (input, expected output, minimum output, fee,
   slippage, quote version/expiry, wallet, network) — no auto-submit.
4. On "Confirm & sign in wallet", **re-read the quote, rebuild and re-simulate**;
   a stale quote discards the prepared tx and is never submitted.
5. `sendSwapTransaction` signs with the **connected wallet adapter**, sends, and
   waits for a **confirmed** status; success is reported only after confirmation,
   then balances/quote/vault are refreshed.

`explainSwapError` maps the deployed codes (6013 Paused, 6015 InvalidOracle, 6021
FlowCapExceeded, 6030 QuoteExpired, 6031 VersionTooOld, 6032 SlippageExceeded,
6033 CapacityExceeded, 6037, 6039) to actionable text; wallet rejection / RPC /
confirmation timeout are handled separately. No floating point in amount/slippage
enforcement. +5 regression tests.

## Phase 3–4 — real browser-wallet swap: BLOCKED

Two blockers: (1) no browser wallet extension exists in this headless environment
(injecting a key is prohibited; a CLI swap is not the acceptance test); and (2)
gate A fails, so the quote is valid only ~2.5 s and a build+sign cannot fit (the
prior preflight reverted `QuoteExpired (6030)`). **No asset-moving transaction was
submitted; no swap is claimed.**

**Operator steps (after ~22:12Z):**
1. Confirm the apply landed: `cd scripts/devnet && set -a && . ../../.env && set +a && export ARBSWAP_DEVNET_KEYPAIR="$ARBSWAP_DEVNET_KEYPAIR" && npx tsx apply_params.ts status` → `expiry_slots 120`, all other fields unchanged.
2. `scripts/devnet/measure_fresh.sh 1800 400` (30-min liveness; keeper runs in tmux `arbswap-keeper`).
3. Browser with Phantom/Solflare on `http://localhost:5173` (Devnet); fund if needed; wrap SOL; open Swap → enter ≤0.5 USDC → **Preview swap** → review → **Confirm & sign in wallet** (≤0.5 % slippage).
4. Verify the confirmed signature, `SwapEvent`, token deltas and reserves.

## Phase 5 — release checks (all green)

Rust fmt/clippy clean; `cargo test --workspace` green (lifecycle 104, keeper 45);
pytest **231 passed / 2 skipped**; keeper TS **17/9/24**; app tsc/lint/**122
tests**/build clean; browser E2E **exit 0** (`/tmp/e2e-s241`); docs-consistency,
bundle-freshness, banned-wording, secrets and the `api-key=` scan CLEAN.

## Phase 6 — release decision

Gate A fails (config), so the other acceptance gates are not attempted; per the
stopping rule the single status is:

**`BLOCKED: CONFIGURATION OR LIVENESS`**

No push and no `demo-freeze-1` tag (awaiting authorization; gates not met).

## Remaining limitations

- `expiry_slots` activation is timelocked (~22:12Z); the frontend cannot extend an
  on-chain expiry.
- The 2–4 s keeper commit cadence remains unmet (3-transaction pipeline ≈3.3 s vs
  the 2 s rule); the longer expiry is the demo enabler, not a cadence fix.
- Real browser-wallet swap cannot be demonstrated without a wallet extension and a
  green config/liveness gate.

## Boundary

Only the previously authorized S2-37 program upgrade and one `set_params` proposal
were sent; no swap/deposit/withdraw/claim/transfer, no mint, no authority/rule
change. Secrets, keypairs and credential-bearing URLs are untracked and redacted.
