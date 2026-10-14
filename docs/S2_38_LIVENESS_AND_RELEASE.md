# S2-38 — Verify Expiry Activation, Prove Keeper Liveness, Finish Release Gaps

Status: **Phases 1, 3, 4, 5 completed; Phase 2 (post-change liveness) BLOCKED —
`expiry_slots=120` is still pending on-chain.** `demo-freeze-1` is **NOT tagged**
(see §6). No swap/deposit/withdraw/claim/transfer; the only on-chain writes remain
the S2-37 program upgrade and the single `set_params` proposal.

## 1. Phase 1 — pending parameter change (verified NOT applied)

Observed 2026-10-14T09:30:52Z, current slot 510942319:

```
Config:  expiry_slots=10  grace=2  max_staleness=2  max_conf=10  fee=1  min_bond=0
Pending: admin 8R3V…, activate_slot 511127388, eligible=false
```

- The proposal from S2-37 is **still pending**; `Config.expiry_slots` is **10**.
- Remaining: 511127388 − 510942319 = **185,069 slots ≈ 12.7 h** → ETA **~2026-10-14T22:14Z** (4.04 slots/s measured).
- The `apply-expiry` tmux runner is alive and **recovered from a transient RPC error** (resilience fix `50c5b0c`): log shows `wait poll transient error: fetch failed` then resumed. **No duplicate proposal or second apply process was created.**
- Expected Config diff on apply: exactly `expiry_slots 10 → 120`; all other fields unchanged (validated by `apply_params.ts` read-back).

## 2. Phase 2 — post-change liveness measurement: **NOT RUN (blocked)**

Per the task, the 30-minute measurement must start only after `expiry_slots=120` is
independently verified active. It is not, so `scripts/devnet/measure_fresh.sh 1800 400`
has **not** been run. Command to run after activation (preserve output in `logs/`):

```bash
scripts/devnet/measure_fresh.sh 1800 400   # 30 min, 400 ms; writes JSON to stdout
```

Pre-change (expiry=10) reference — already recorded — **RED**: `logs/fresh_baseline.json`
(1605 samples, 0 fresh, longest stale 1,200,000 ms, 0 commits; codes 6015×7,
6037×3, 6039×4). The keeper now commits after the crash fix (observed v121→v123),
but with a ~2.5 s window and ~10–25 s commit spacing the quote is expired most of
the time.

**2–4 s commit cadence: NOT demonstrated.** The measured critical path is unchanged
(Hermes fetch ~0.4–1.3 s + VAA ~0.9 s + atomic push+commit ~0.9 s vs the 2 s oracle
rule). A longer expiry extends the *validity* window; it does **not** create
updates. Cadence is reported separately from freshness.

## 3. Phase 3 — demo/evidence gaps (completed)

- **Streams + schema:** `simulation.attackers.export_streams` (deterministic; uses
  `simulation.sim.price_source.synthetic_series`) writes
  `artifacts/public/demo_streams.json`, `artifacts/schema/demo_streams.schema.json`
  and the bundled `app/src/data/demoStreams.json` (8 scenarios × 240 steps).
- **Determinism:** Python test (`simulation/attackers/tests/test_export_streams.py`)
  proves same-seed byte-identical output and that the committed file matches; app
  test asserts bundled == published bytes.
- **No network / wallet / tx:** `DemoPage` imports the bundle at build time; tests
  assert no `fetch`/`axios`/`@solana/web3.js`/`useWallet`/`sendTransaction`.
- **Claims page:** `ClaimsPage` mirrors `docs/CLAIMS.md` (shows `NOT CLAIMED` and
  `SIMULATION ONLY — UNPROVEN`; keeps "≤40k CU target **NOT met**"); nav + E2E.
- **Devnet history:** `EvidencePage` lists the real upgrade/`set_params` signatures
  and canonical accounts with explorer links, labelled "devnet history".
- Simulated attack outcomes are labelled "simulation, no funds involved" and kept
  separate from on-chain observations; no profitability is claimed.

## 4. Phase 4 — frontend / swap readiness

- Depth-exceeded renders in both directions (`Exceeds quoted depth. Max now: X (~Y)`
  + Use-max + per-side depth; partial output never shown as the estimate); countdown,
  disabled reasons, WSOL wrap/unwrap (+0.05 SOL reserve), and the funding panel are
  in place. Price normalization verified: on-chain `anchor_sqrt_price → $107`; the
  earlier `$186.98` was a stale/last-known value. Labels distinguish current vs
  last-known.
- Browser E2E **exit 0** (0 exceptions/console errors); screenshots in
  `/tmp/e2e-s238/` (`02-swap`, `07-depth-exceeded`, `07-demo`, `08-evidence`,
  `09-claims`). **No transaction submitted; no mock wallet reported as a live swap.**

## 5. Phase 5 — release gate (all green)

| Check | Result |
|---|---|
| `cargo fmt` / clippy (incl. program) | clean |
| `cargo test --workspace` | green (lifecycle 104, keeper 45; total 211) |
| `pytest simulation -q` | **231 passed, 2 skipped** (233) |
| keeper TS (`broadcast`/`keeper_commit`/`rpc`) | 17 / 9 / 24 |
| app `tsc -b` / lint / tests / build | clean / clean / **125** / clean |
| browser E2E | exit 0 |
| docs-consistency / bundle-freshness | green |
| banned-wording / secrets / `api-key=` scan | CLEAN |
| CU re-measure (5 runs, new binary) | `update_quote` **47,836**, `swap` 63,579 — **≤40k target still NOT met** (host-sensitive); record preserved |

Artifacts republished; bundle records `6389fd9`.

## 6. Tag

**`demo-freeze-1` was NOT created.** Tagging requires both the release gates (which
pass) **and** independent verification that `expiry_slots=120` is active — which is
still false. Creating the tag now would falsely mark the release complete.

## 7. Remaining steps for a real browser-wallet swap (operator)

1. At/after ~2026-10-14T22:14Z, confirm the apply: `cd scripts/devnet && set -a && . ../../.env && set +a && export ARBSWAP_DEVNET_KEYPAIR="$ARBSWAP_DEVNET_KEYPAIR" && npx tsx apply_params.ts status` → `/apply`; then verify `Config.expiry_slots == 120` and that every other field is unchanged (`apply_params.ts` does this read-back).
2. Run the 30-min post-change measurement: `scripts/devnet/measure_fresh.sh 1800 400`.
3. Start the keeper: `scripts/devnet/demo_up.sh 3600` (tmux `arbswap-keeper`); confirm `scripts/devnet/demo_check.sh` shows FRESH.
4. In a browser with a wallet extension, open the app on **`http://localhost:5173`** (not `127.0.0.1`/LAN), connect Phantom (Devnet), fund via the faucets if needed, wrap SOL, and BuyBase ≤ 0.5 USDC (≤ 0.5 % slippage) while the page shows a fresh quote.
5. Independently verify the confirmed `SwapEvent`, token deltas and reserves. Only then is the browser-wallet swap demonstrated.

## 8. Boundary

Only the authorized S2-37 program upgrade and the one `set_params` proposal were
sent. No additional parameter, timelock, authority, oracle, bound or token-math
change. Secrets and credential-bearing URLs are redacted; none tracked.
