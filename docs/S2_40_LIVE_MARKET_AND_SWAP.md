# S2-40 — Complete Live Market + Real Frontend Swap

Status: **Phases 1, 2, 4, 6 executed; Phase 3 (post-activation liveness) and
Phase 5 (real wallet swap) BLOCKED by two precisely evidenced external
conditions.** No asset-moving transaction was submitted. `demo-freeze-1` is **NOT
tagged**.

## Phase 1 — `expiry_slots = 120`: still pending

Independently read at 2026-10-14T10:37Z, slot 510957475:

```
Config:        expiry_slots=10  grace=2  max_staleness=2  max_conf=10  fee=1  min_bond=0
PendingConfig: admin 8R3V…, activate_slot 511127388, eligible=false
```

- The S2-37 proposal is **unchanged and still pending** — no duplicate proposal,
  no competing apply process. The `apply-expiry` tmux runner is alive and healthy.
- Remaining ≈ **169,913 slots ≈ 11.7 h** at 4.04 slots/s → **ETA ~2026-10-14T22:16Z**.
- Post-apply read-back (`apply_params.ts`) enforces exactly `expiry_slots 10→120`
  with every other field unchanged.

## Phase 2 — keeper reliability (measured) + bottleneck

Critical path across the recent attempts (14 timed cycles, Helius primary +
public fallback):

| Stage | p50 | p90 | max |
|---|---|---|---|
| Hermes fetch | 525 ms | 745 ms | 812 ms |
| Quote engine | 12 ms | 15 ms | 20 ms |
| Oracle age at fetch | 1,086 ms | 1,308 ms | 1,352 ms |
| `stage_quote` confirm | 1,050 ms | 1,256 ms | 1,365 ms |
| Wormhole VAA confirm | 960 ms | 1,217 ms | 1,362 ms |
| push+`commit_quote` confirm | 1,152 ms | 1,686 ms | 1,778 ms |
| **Age at commit** | **3,000 ms** | 3,000 ms | 3,000 ms |

**Bottleneck:** wall publish→commit ≈ `1.1 s (age at fetch) + 1.0 s (VAA; stage
overlaps) + 1.15 s (atomic push+commit) ≈ 3.3 s` against the deployed 2 s oracle
rule. Commits land only when the cluster clock lags enough; observed cadence ≈
**1 commit / 23 s** (QuoteState v158→v175 over ~5 min). **The 2–4 s cadence goal
is NOT met — this is an architectural limit of the 3-transaction pipeline, not a
tuning miss.**

Conservative reliability improvements already in place and verified: concurrent
Hermes/slot/blockhash fetch, first-accepted multi-endpoint broadcast, `processed`
confirmation, bounded backoff, a **catch-all** so an unhandled Helius
`UND_ERR_CONNECT_TIMEOUT` can no longer crash the keeper (it survived 400 s+ after
the fix), skip-if-already-too-old, ambiguous-outcome inspection before retry, and
redacted endpoints (no `api-key=` in logs). A further reduction requires collapsing
a transaction leg — a protocol change needing separate review + redeploy, **not
done**.

## Phase 3 — post-activation liveness: BLOCKED

`scripts/devnet/measure_fresh.sh 1800 400` requires `expiry_slots == 120`, which is
not active. Not run. (The script now refuses to run without a live keeper and logs
its JSON to `logs/`.) Pre-change reference `logs/fresh_baseline.json` (expiry=10):
**0/1605 fresh, 0 commits, RED**.

## Phase 4 — real frontend workflow (verified, read-only)

Browser↔chain correlation over a 300 s window (real app, live `QuoteState`):

- Browser versions observed **158→171**; **`changedWithoutReload: true`** — new
  commits update the page without a reload.
- Version mismatches vs chain: transient only (≤ one 700 ms poll); fresh/expired
  classification matched the chain except at boundary samples.
- Countdown used the current slot and real expiry (e.g. "valid for 7 more slots
  (~1.7s)"); a `10-swap-fresh.png` screenshot was captured while FRESH.
- The app is in **transaction-enabled** Devnet mode (`modeBadge: trading`); depth,
  wrap/unwrap, funding panel and submit-time re-read are wired. State-aware gates
  (expired/unavailable/RPC error) never present a stale quote as fresh.

**Read-only swap preflight** (`swap_preflight.ts`, no submit) for BuyBase 0.5 USDC,
0.5 % slippage:

```
quote_version 175  quote_expiry_slot 510959339  current_slot 510959326  fresh true
wallet 8R3V…  balances: 9.95 SOL, 0.016290295 WSOL, 2.25 USDC
fee 50 atoms  net_in 499950  expected_out 4,682,396  min_out 4,658,984
accounts: vault/config/quote_state/base+quote_reserve/trader ATAs/keeper_reward
tx 573 B, pre_instructions 0  — simulation error: QuoteExpired (6030)
```

The quote was fresh when the plan was built but **expired during simulation**:
the build+simulate round trip exceeds the ~2.5 s window. This is direct evidence
that `expiry_slots = 10` is **unusable for a real signed swap** — the operator
cannot build, sign and submit within ~2.5 s.

## Phase 5 — real browser-wallet swap: BLOCKED

Two external blockers: (1) no browser wallet extension exists in this headless
environment (injecting a key is prohibited; a CLI swap is not the acceptance
test); (2) even with a wallet, the ~2.5 s window fails before signing. A real
browser-initiated swap is therefore **not demonstrated** and is **not claimed**.

## Phase 6 — tests / gate

Rust fmt/clippy clean; `cargo test --workspace` green (lifecycle 104, keeper 45);
pytest **231 passed / 2 skipped**; keeper TS **17/9/24**; app tsc/lint/**117
tests**/build clean; browser E2E **exit 0**; docs-consistency + bundle-freshness
green; banned-wording + secrets + `api-key=` scans CLEAN. `swap_preflight.ts` now
waits for a fresh quote and derives the trader's real ATIs (manual, no spl-token
dep); read-only.

## Phase 7 — release

`demo-freeze-1` **NOT created**: acceptance requires a verified on-chain
`expiry_slots == 120` and a confirmed browser-wallet swap, neither of which holds.

**Exact operator actions for a genuine swap (after ~22:16Z):**
1. Confirm the apply landed: `apply_params.ts status` → `Config.expiry_slots==120`.
2. Run the 30-min liveness measurement: `scripts/devnet/measure_fresh.sh 1800 400`.
3. `scripts/devnet/demo_up.sh 7200`; confirm FRESH via `demo_check.sh`.
4. Browser with Phantom/Solflare on `http://localhost:5173` (Devnet); fund if
   needed; wrap SOL; BuyBase ≤ 0.5 USDC (≤ 0.5 % slippage) during a fresh quote.
5. Verify the confirmed signature, `SwapEvent`, token deltas and reserves.
6. Only then tag `demo-freeze-1`.

## Boundary

Only the previously authorized S2-37 program upgrade and the single `set_params`
proposal were sent. No swap/deposit/withdraw/claim/transfer, no mint, no authority
change, no rule change. Secrets/URLs redacted and untracked.
