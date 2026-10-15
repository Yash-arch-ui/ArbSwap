# S2-42 — Devnet Recovery, Keeper Liveness, Frontend Integration, Live Swap

Status: see the single status line at the end of this report.

All work is Devnet-only. No asset-moving transaction was submitted. No commit was
pushed and no `demo-freeze-1` tag was created. Secrets/keypairs/URLs are redacted.

## Phase 1 — repository and chain state (verified)

- Branch `main`; HEAD `171e945` (`s2-41: supervise keeper and apply runner`).
  Worktree before this task: 3 pre-existing commits ahead of `origin` (not pushed)
  plus one untracked doc (`docs/FRONTEND_INTERFACE_RECOMMENDATIONS.md`).
- No keeper / apply-runner / tmux process was running at task start; no lock held.
- Devnet only; genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.

## Phase 2 — expiry proposal resolved (gate A: PASS)

At task start the S2-37 `set_params` proposal was still **unapplied**
(`Config.expiry_slots = 10`) but the timelock had elapsed
(`slot 511234515 >= activate_slot 511127388`). No apply transaction was in
flight (no process, no lock), so the existing authorized runner was started:

```
[2026-10-15T04:54:43Z] apply-expiry starting (lock=/tmp/arbswap-apply-expiry.lock)
{
  "apply_signature": "2JchnrSstJG1b1G8jQdu8TggwGqK7SwXa4AZs8Pz5BFMAaWauV67jxDzp7YXfsypimefSXGzqbcN8UrFzsFq1CWr",
  "changed_fields": ["expirySlots"],
  "expiry_slots": "120",
  "only_expiry_changed": true
}
[2026-10-15T04:55:07Z] apply-expiry done (attempt 1)
```

Independent on-chain verification:

- `solana confirm -v 2JchnrSstJG1…` → **slot 511234933**, `Status: Ok`,
  `Program log: Instruction: ApplyParams`.
- Re-read via `fresh_quote_probe.ts`: `expiry_slots=120 grace_slots=2`.
- Full `preflight.ts`: `config.expirySlots="120"`, `feeBps=1`,
  `maxStalenessSeconds="2"`, `maxConfBps=10`, `minBond="0"`,
  `keeper=8R3VDePS…`, feed `ef0d8b6f…` — all unrelated fields unchanged.
- `apply_params.ts status`: `PendingConfig.activate_slot = 18446744073709551615`
  (u64::MAX) → **no pending proposal remains**.

No duplicate proposal was created; the timelock was not bypassed.

## Phase 3 — keeper defect fixed (bounded, safety-neutral)

Inspection found a genuine, evidence-driven defect: `broadcastTransaction`
polled `getSignatureStatuses` every **50 ms** across every accepting endpoint
with **no rate limit on the polls** (the token bucket gated only
`sendRawTransaction`). During a 12 s confirmation window that is ~40 status
requests/second across two endpoints sharing one free-tier key. The resulting
`429 Too Many Requests` storms delayed confirmation to 9–14 s on the fallback,
which pushed the wall clock past the deployed **2 s oracle-freshness** rule and
produced the observed on-chain failures:

- `6015 InvalidOracle` — the Pyth push was stale by commit time.
- `6039 StalePendingQuote` — the staged quote aged out before commit.

These are the dominant failure categories (hundreds of occurrences in the
keeper log). The deployed oracle/confidence/stage-age/attribution checks were
**not** weakened.

Fix (one bounded change, no protocol change):

- `scripts/devnet/broadcast.ts`: the first status check is immediate; subsequent
  poll rounds are spaced by `max(pollIntervalMs, 60_000 / rpcPerMinuteCap)` so the
  per-endpoint status-poll rate cannot exceed the configured cap.
- `scripts/devnet/keeper_live.ts`: broadcast options tightened from
  `{pollIntervalMs: 50, rpcPerMinuteCap: 900}` to
  `{pollIntervalMs: 250, rpcPerMinuteCap: 240}`.
- Regression test added (`broadcast.test.ts`): with a 2/min cap a 100 ms poll
  over 55 s would issue ~550 status calls; the gated loop issues ≤ 3. `broadcast`
  tests now **19** (was 17).

Keeper health checks: `keeper_commit.test.ts` **9**, `rpc.test.ts` **24**, all
pass. The keeper runs supervised via `demo_up.sh` under a single-instance `flock`.

## Phase 4 — sustained liveness (30 min, `measure_fresh.sh 1800 400`)

Both runs use the read-only monitor (no competing keeper) while exactly one
supervised keeper holds the lock.

### Run 1 — before the fix (old 50 ms poll)

Artifact `logs/fresh_monitor_20261015T050545Z.json`:

```
samples 2602 · fresh 1081 · fresh_fraction 0.415 · longest_stale_ms 122664
commits_observed 35 · last_version 926 · decision red
```

Keeper cadence: ~122 slots/commit. Dominant failure: the 429 storm above.

### Run 2 — after the fix

Artifact `logs/fresh_monitor_20261015T053948Z.json`:

```
samples 2641 · fresh 2220 · fresh_fraction 0.841 · longest_stale_ms 34577
commits_observed 104 · last_version 1036 · decision green
```

Verdict: **GREEN** (≥ 0.80). Versus run 1: fresh fraction **0.415 → 0.841**,
commits **35 → 104** (~1 commit/17 s), longest stale **122.7 s → 34.6 s**.

Post-fix keeper cadence improved to ~70 slots/commit (e.g. v927→v937 over
704 slots) with far fewer 429-driven stalls. Gate B: **PASS**.

## Phase 5 — frontend / backend integration

Reviewed, not rewritten; no broken behavior was found in the live path.

- Live quote state is derived from the on-chain `QuoteState` at `processed`
  (`liveQuote.ts`); version changes update without a reload.
- The countdown uses the real `expirySlot` and current slot; a quote is
  `Fresh`/`Aging`/`Expired`/`Unavailable`, and only `Fresh` is executable.
- Submit-time re-read: `SwapPage.buildPlan()` calls `fetchFreshQuote` and
  `submitFreshnessReason`; `handleConfirm` rebuilds and re-simulates — a stale
  quote is never submitted.
- Integer math (`swapMath.ts`, bigint) drives expected output and minimum output;
  no floating point in the transaction path.
- `explainSwapError` maps `QuoteExpired (6030)`, `VersionTooOld (6031)`,
  `SlippageExceeded (6032)`, `CapacityExceeded (6033)`, oracle/attribution codes,
  wallet rejection, RPC failure and confirmation timeout to actionable text.
- Success is shown only after confirmed on-chain status.

Checks (all green):

| Check | Result |
|---|---|
| `app` tsc + `vite build` | clean |
| `app` lint (`oxlint`) | clean |
| `app` unit tests (vitest) | **122 passed** |
| Browser E2E (`browser-smoke.mjs`) | **exit 0** — 0 exceptions, 0 console errors, **30/30** fresh-quote samples |

**Finding (fixed):** the local production build inlined the live Helius
`api-key` from the untracked `app/.env.local` into the public bundle
(`dist/assets/*.js`), failing the S2-32 "no secrets in the bundle" test. The
bundle is gitignored, but it is what a deploy would publish. Rebuilt keyless
(`VITE_SOLANA_RPC_URL=https://api.devnet.solana.com`, matching CI which has no
`.env.local`); the gate is green and the credential is no longer embedded.

**Read-only swap preflight** (`swap_preflight.ts`, BuyBase 0.5 USDC / 0.5 %,
never submits):

```
quote_version 945 · quote_fresh true · fee 50 · net_in 499950
expected_out 4,888,066 · min_out 4,863,625 · tx 573 B
simulation_err: null → Program log: Instruction: Swap … success; SwapEvent emitted
```

At `expiry_slots=10` the identical path reverted `QuoteExpired (6030)`; the
120-slot window now comfortably covers build+simulate.

## Phase 6/7 — real browser-wallet swap

**Not executed.** A CDP probe of the running app confirmed no injected wallet
provider (`hasSolana/hasPhantom/hasSolflare = false`, no `window.solana|phantom|
solflare`). Injecting a keypair, impersonating a wallet, or a CLI-signed swap is
prohibited and is not the acceptance test. No asset-moving transaction was
submitted; no swap is claimed.

Operator steps (app left running):

1. `cd app && npm run dev` → open `http://localhost:5173/` (already running).
2. Install Phantom or Solflare, switch to **Devnet**; fund if needed; wrap SOL.
3. Swap tab → flip input to **USDC**, enter **≤ 0.5**, keep slippage ≤ 0.5 %.
4. **Preview swap** → review input / expected output / minimum output / fee /
   version+expiry / wallet+network → **Confirm & sign in wallet**.
5. Read the confirmed signature; verify `SwapEvent`, token deltas and reserves.

## Phase 8 — release checks

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` | clean |
| `cargo clippy` (canonical CI set `-p … -- -D warnings`) | clean |
| `cargo test --workspace` | green (lifecycle 104, keeper 45, math/aggregator/… green) |
| pytest | **231 passed, 2 skipped** |
| keeper TS (`broadcast`/`keeper_commit`/`rpc`) | **19 / 9 / 24** |
| app tsc/lint/tests/build | clean / clean / 122 / clean |
| browser E2E | exit 0 |
| docs-consistency / bundle-freshness | pass |
| banned-wording / secrets / `api-key=` | CLEAN |

Note: `cargo clippy --workspace --all-targets -- -D warnings` additionally flags
`clippy::result_large_err` in the `litesvm_lifecycle` **test** target; this is not
part of the repository's CI clippy invocation (`.github/workflows/ci.yml`), which
is clean.

## Boundary

Only the already-authorized `apply_params` transaction was sent (Phase 2). No
swap/deposit/withdraw/claim/transfer, no mint, no authority/rule change, no
program redeploy. Changes are confined to `scripts/devnet/broadcast.ts`,
`scripts/devnet/keeper_live.ts`, `scripts/devnet/broadcast.test.ts`, three
comment-only updates in `app/src`, and documentation. Nothing was pushed.

## Known limitations / remaining blocker

- The browser-wallet swap requires a wallet extension and explicit user
  approval, neither of which exists in this environment.
- The 3-transaction pipeline is inherently near the deployed 2 s oracle-freshness
  rule; reducing it further needs a protocol-level redesign (separate approval),
  which is not required once a commit lands within the 120-slot window.
- The local `app/.env.local` (untracked) carries a live RPC key; production
  builds must not embed it (documented above).

## Release decision

Gates A (config `expiry_slots == 120`) and B (sustained liveness, 0.841 green) both
**PASS**. The frontend, backend, and all non-transactional release checks are
green. The only unmet gate is the real browser-wallet swap (C), which requires a
wallet extension and explicit user approval that do not exist in this
environment. `demo-freeze-1` is **not** tagged and nothing is pushed (awaiting
authorization).

**Single next action:** open `http://localhost:5173/` in a browser with Phantom or
Solflare on Devnet, connect, and complete the documented BuyBase ≤ 0.5 USDC /
≤ 0.5 % swap, then record and verify the confirmed signature.

**BLOCKED: USER WALLET OR APPROVAL**
