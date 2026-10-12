# FINAL INTEGRATION GAP AUDIT

**Audit date:** 2026-10-12 · **Branch:** `main` @ `380ff4c` · **Mode:** read-only
(no state-changing Devnet tx; no program/authority/config change; no push).

**Canonical plans (verified by inspection):** `MasterPlan.md` (v3) and
`BuilderPlan.md` (v1.0). `docs/BUILD_PLAN.md` is a near-identical duplicate of
`BuilderPlan.md` (only file mode/final-newline metadata differs). There are **no** `MASTERPLAN.md`,
`TruQuote_Master_Plan.md`, or `TruQuote_Build_Plan.md` files — the "TruQuote"
names appear only as prose in the plans. Prior audit: `docs/AUDIT_ACHIEVED_VS_PLAN.md`
(predates the B1 fix, the Devnet vault init/funding, and the S2-6 app wiring).

**Evidence gathered this pass (read-only / local):**
- Deployed program hash vs preserved B1 artifact: **MATCH** (on-chain 698856 B =
  692616 B ELF + 6240 B loader padding; stripped sha256 `9a6e8498…`).
- Canonical WSOL/USDC vault `8yvFBv9g…` fund: reserves **174,120,234** base atoms
  / **19,000,000** quote atoms, `total_shares 57,517,688`, `status 0`; `QuoteState`
  `5MsGbd…` **version 0** (no quote).
- Rust workspace tests **167 passed / 0 failed**; Python `pytest simulation`
  **212 passed / 2 skipped**; app `yarn test` **16 passed**; app `tsc -b`, `yarn
  lint`, `yarn build` green (all run earlier in this cycle; see §C/E).

---

## A. Executive status

| Question | Answer | Evidence |
|---|---|---|
| App buildable? | **Yes** | `app`: `tsc -b`, `oxlint`, `vite build` all pass |
| App demonstrable against live state? | **Yes** | reads canonical vault/config/quote/reserves/tickets live (`app/src/context/ProtocolContext.tsx`, `app/src/chain/program.ts`) |
| Real LP transactions connected? | **Deposit: yes (wired + proven on Devnet).** Withdraw request/claim: wired, **not exercised** post-B1. Swap: wired, **gated** | `app/src/chain/program.ts`; deposit tx `3BEeTcuq…` |
| Live swaps possible right now? | **No** | `QuoteState.version = 0`; keeper cannot publish (oracle blocker) |
| Analytics live / indexed / replay / mixed? | **Mixed** | static replay artifacts (`app/public/artifacts/*`) + live on-chain reads; indexer code exists but is not run as a live service (CLOSED-BY-DECISION) |
| Documentation aligned with active app? | **No** | `docs/INTEGRATION.md` and `FULLGUIDE.md` still contain legacy tSOL/tUSDC/app assumptions in multiple sections |
| Exact external blocker | **Entitled Pyth crypto-spot SOL/USD credential** (or a fresh valid `PriceUpdateV2` poster) | Hermes/Benchmarks `403 Not entitled … crypto/spot`; sponsored candidate min age 17 s > deployed 2 s |

**One-line status:** the backend engine, math, tests, and the app are in good
shape and demonstrable; the single hard blocker to a *live* swap demo is the Pyth
entitlement, which is external. Everything else is polish, evidence, and demo
plumbing.

---

## B. Master Plan compliance matrix (M1–M20)

Status legend: **COMPLETE** · **PARTIAL** · **MISSING** · **BLOCKED EXTERNALLY** ·
**NOT REQUIRED FOR HACKATHON MVP**. "Proof" distinguishes *local* (unit/LiteSVM)
from *end-to-end* (live Devnet).

| M | Requirement (MasterPlan §4) | Files / functions | Status | Left / blockers | Blocks demo? | Completion test |
|---|---|---|---|---|---|---|
| M1 | Vault core: custody, reserves, shares, states | `vault/program/src/lib.rs` (`Vault`, `initialize_vault`, `deposit`) | COMPLETE | none | no | LiteSVM lifecycle + live vault `8yvFBv9…` reads |
| M2 | Pro-rata two-token shares + NAV reporting | `deposit` share math; NAV off-chain only | PARTIAL | NAV not surfaced; app deposit still hardcodes `min_shares=1` and does not create missing user ATAs; live deposit used an external script | **yes for a new LP** | app creates/ensures ATAs, computes safe integer `min_shares`, simulates, confirms, refreshes |
| M3 | Quote state (anchor/spread/skew/depth/version/expiry) | `QuoteState`, `update_quote` | COMPLETE (code) / **BLOCKED EXTERNALLY** (no live quote) | needs Pyth entitlement to populate | **yes (swap)** | `QuoteState.version > 0` on Devnet |
| M4 | Swap engine (ladder walk, fee, expiry, `min_out`, version) | `swap`, `arb_math::walk_ladder` | COMPLETE (code+tests) / end-to-end **unproven post-B1** | no post-B1 live swap (no quote) | **yes** | one live swap on the B1 program |
| M5 | Pricing engine (vol/inventory/conf/directional/throttle) | `vault/keeper/src/lib.rs::compute_quote` | COMPLETE (off-chain policy) | LVR budget is keeper-side, not on-chain (documented) | no | keeper tests + replay parity |
| M6 | Keeper client (Pyth→quote→submit, failures) | `vault/keeper/src/{main,lib}.rs` | COMPLETE (code) / **BLOCKED EXTERNALLY** (cannot publish) | entitled Pyth | **yes** | `keeper live` lands `update_quote` |
| M7 | Keeper network (bond/reward/slash) | `bond_keeper`, `unbond_keeper`, `slash_keeper`, `claim_keeper_reward` | COMPLETE (bonded) / open competition NOT CLAIMED | `min_bond=0` → allowlist MVP | no | bond/slash tests |
| M8 | Risk limits (inventory/size/spread/step) | `Config` bounds enforced in `update_quote`/`swap` | COMPLETE | none | no | `litesvm_lifecycle` cap tests |
| M9 | Circuit breakers | `trip_breaker`, `reset_breaker` | COMPLETE | none | no | `litesvm_breaker.rs` (4) |
| M10 | Warm-up + withdrawal queue/epochs/claim | `deposit` ticket, `request_withdraw`, `crank_epoch`, `claim_withdraw` | PARTIAL | request/ticket reads wired; no claim button/complete UI lifecycle; not exercised post-B1 | P1 | app exposes real ticket state and claim only when eligible; confirmed refresh |
| M11 | Fees/incentives (MVP fee split; HWM off-chain) | fee split in `swap`; `simulation/analytics/performance_fee.py` | PARTIAL (MVP split complete; HWM CLOSED-BY-DECISION) | none for demo | no | fee-split test; performance_fee tests |
| M12 | Insurance buffer | `insurance_*` buckets | COMPLETE | none | no | bucket tests |
| M13 | Attribution (fees/inventory/LVR/gas) | `simulation/analytics/metrics.py` | PARTIAL (model/indexed, not live indexer output) | needs live/indexed run | no | attribution tests on replay |
| M14 | Simulator/backtester | `simulation/sim/` (engine, baselines, studies) | COMPLETE | none | no | `pytest simulation` (212) |
| M15 | Attacker bots (E7) | `simulation/attackers/{scenarios,e7}.py` + tests | COMPLETE | none | no | `python -m attackers.e7`; tests |
| M16 | Analytics API (markouts/quiet/gap/LVR) | `simulation/analytics/` | PARTIAL (computes; no live server) | static-bundle decision | no | `analytics/tests` |
| M17 | Dashboard (LP/trader/risk/comparison/demo) | `app/` + `simulation/analytics/demo.py` | PARTIAL | live vault/risk/swap surfaces exist; in-app replay mode absent; Overview has hardcoded research ribbons/badges needing explicit model/replay labels | P1 | live pages + labeled replay mode + no misleading hardcoded live metrics |
| M18 | Aggregator adapter | `vault/aggregator/src/lib.rs` | PARTIAL / EXTERNAL | Jupiter listing needs Jupiter-side variant | no | `aggregator_quote_matches_onchain_swap` |
| M19 | Governance + timelock | `set_params`/`apply_params`, `propose/accept/cancel_admin`, `propose/execute_fee_claim` | COMPLETE (code) | multisig CLOSED-BY-DECISION | no | timelock tests |
| M20 | Docs + reproducibility | README, `docs/*`, `scripts/headline.sh` | PARTIAL | README and both integration guides contain stale legacy tSOL/tUSDC/app assumptions; refresh after this audit | P1 | fresh checkout docs match canonical WSOL/USDC + B1/oracle state |

**Summary:** most protocol modules exist and are locally tested, but M2/M10/M17/M20
remain integration/documentation partials. The **live swap blocker** is still M3/M4/M6
(no valid quote); a new-LP blocker also remains in the app's ATA/min-share path.

---

## C. Build Plan gate matrix (P1–P6)

Original criteria quoted from `BuilderPlan.md` §12.

| Phase | Criterion (verbatim) | Verdict now | Evidence / caveat |
|---|---|---|---|
| **P1** Math & simulator | "`tq-math` passes all vectors; TruQuote results reported honestly in at least calm, trend, and crash regimes" | **PASS** | golden vectors parity; `pytest simulation` 212 passed; `docs/P1_RESULTS.md` |
| **P2** On-chain program | "full deposit, update, swap, withdraw loop on devnet; all invariants pass" | **PARTIAL (re-open)** | Pre-B1 loop was proven; post-B1 the program was **redeployed** (update_quote now requires `base_mint`/`quote_mint`) and only **deposit** is re-proven live (`3BEeTcuq…`). update/swap/withdraw are **not** re-proven on the B1 deployment (swap blocked by no quote). Invariants pass locally (167 tests). |
| **P3** Keeper | "keeper-driven quotes on devnet match the simulator within tolerance; keeper-down test shows safe expiry" | **BLOCKED EXTERNALLY** | Keeper code + offline parity tests pass; live publish blocked by Pyth entitlement. Keeper-down/expiry is proven locally. |
| **P4** Analytics/fees/dashboard | "dashboard reproduces the simulator charts on replayed data" | **PARTIAL** | Replay/static charts exist (`app/public/artifacts/*` + `demo.py`); app now shows live vault state. In-app replay/demo mode not built. |
| **P5** Hardening/adversarial | "every E7 attack fails or is contained and documented" | **PASS (simulation)** | `attackers/` 7 bots + control; E7–E10 reported. E8 fill-gap is a **proxy** (CLOSED-BY-DECISION). No independent audit (EXTERNAL). |
| **P6** Submission/reproducibility | "a stranger can reproduce the headline chart from the README" | **PASS (stale caveat)** | `./scripts/headline.sh` runs with no data/keys. README gate table predates B1 + the oracle blocker; needs refresh. |

**Gates:** P1 PASS · P2 PARTIAL (re-open) · P3 BLOCKED EXTERNALLY · P4 PARTIAL ·
P5 PASS(sim) · P6 PASS(caveat). The prior "7/7 PASS" in
`docs/AUDIT_ACHIEVED_VS_PLAN.md` is **superseded** by the B1 redeploy and the
oracle blocker.

---

## D. End-to-end wiring map

| Path | Files | Verified connections | Broken / unproven edges |
|---|---|---|---|
| Pyth → keeper → quote → `update_quote` → `QuoteState` | `vault/keeper/src/*`, `vault/program/src/lib.rs::update_quote` | code + offline parity + B1 normalization tests (`litesvm_oracle_scaling`) | **No live quote**: Pyth entitlement missing; nothing past the keeper read is exercised live |
| `QuoteState` → app reads → swap guards/display | `app/src/chain/{program,live,gating}.ts`, `context/ProtocolContext.tsx`, `pages/SwapPage.tsx` | swap fails closed with the 2 s reason; version/expiry read live | swap path never executed live (needs quote) |
| LP wallet → deposit → reserves/shares → dashboard | `vault/program::deposit`, `app/src/pages/VaultPage.tsx`, `app/src/chain/amounts.ts` | deposit proven live; app reads reserves/shares/ticket | app's `ensureAta` only checks; it does not create missing base/quote/share ATAs; app uses `min_shares=1`; generic-wallet path unproven |
| LP wallet → withdraw request → epoch → claim | `request_withdraw`/`crank_epoch`/`claim_withdraw`, app builders | request/ticket reads wired live | **not exercised** on-chain post-B1; no claim UI button; crank/claim actions not surfaced |
| Program events → indexer → DB → analytics → charts | `simulation/analytics/{indexer,store,metrics}.py` | code + tests exist | **no live indexer service**; app charts come from static artifacts |
| Market data → simulator → artifacts → demo | `simulation/sim/*`, `app/public/artifacts/*`, `simulation/analytics/demo.py` | reproducible via `scripts/headline.sh` | not surfaced *inside the app* as a labeled replay view |

**Scenarios that can be demonstrated today:** (1) wallet-less visitor sees real
vault data — **yes**; (2) connect wallet + see balances/LP position — **yes**;
(3) small deposit lifecycle — **yes** (already funded; re-run at operator's
discretion); (4) withdraw request/claim lifecycle — **partial** (request wired,
claim not surfaced); (5) missing/expired quote disables swaps — **yes**;
(6) valid-quote path — **blocked externally**; (7) keeper outage/stale → safe
expiry — **local proof only**; (8) historical replay analytics — **yes via
artifacts/CLI, not in-app**; (9) fresh checkout build/tests — **yes** (cargo,
pytest, app); (10) honest error/wrong-network/unavailable handling — **partial**
(status surfaces exist; wrong-network messaging is basic).

---

## E. Prioritized remaining work

Estimates are **judgment**, not measured time. Ordered by demo impact/dependency.

| # | Pri | Task | Why | Files | Dep | Est | Acceptance | Blocks demo |
|---|---|---|---|---|---|---|---|---|
| 1 | **External** | Obtain **entitled Pyth** crypto-spot SOL/USD access; post a fresh `PriceUpdateV2`; run keeper `live` | only path to a live quote → swaps | `.ENV`, `scripts/devnet/update_feed.ts`, `vault/keeper` | credential | small (once cred) | `QuoteState.version>0`, unexpired; `keeper live` lands updates | **yes** |
| 2 | P0 | Re-prove **post-B1** live `update_quote` → `swap` → `withdraw`/`claim` on the funded canonical vault (operator-run, not auto) | P2 gate re-open; swaps unproven on B1 | `vault/program`, app builders | #1 | small | signatures for update+swap+withdraw+claim | yes |
| 3 | P1 | Add an **in-app replay/demo mode** (labeled) reading `app/public/artifacts/*` | judges need analytics without the oracle | `app/src/pages/AnalyticsPage.tsx`, `app/src/data/backend.ts` | none | medium | charts render from artifacts with provenance labels | no (high value) |
| 4 | P1 | Surface **withdraw claim** UI + epoch/eligibility state | completes LP lifecycle | `app/pages/VaultPage.tsx`, `app/src/chain/program.ts` | none | small | claim button gated on ticket epoch; confirmed refresh | no |
| 5 | P1 | **Refresh README + gate tables** to the B1 + oracle-blocker reality | judges read the README first | `README.md`, `docs/AUDIT…`, this file | none | small | gates match evidence; external blocker stated | no |
| 6 | P1 | Cross-boundary **integration tests** (builder↔IDL accounts, decimals, fail-closed; no-mock) | prevent regressions; evidence | `app/test/`, `vault/program/tests/` | none | small | tests green in CI | no |
| 7 | P2 | Live **indexer/service** for analytics (optional) | show "indexed" metrics live | `simulation/analytics/` | infra | large | endpoint + reconciliation | no |
| 8 | P2 | Aggregator/Jupiter adapter completion | routing claim | `vault/aggregator` | Jupiter-side | large | order parity | no |
| 9 | P2 | Full E1–E10 refresh against the B1 build; independent review | rigor slide | `simulation/`, `docs/` | time | medium | reproducible report | no |

**Code-defect vs missing-evidence vs MVP vs external:** #1 external; #2 missing
live evidence (no code defect); #3–#6 missing tests/demo plumbing; #7–#9 deliberate
MVP deferrals (documented non-goals/scoped).

---

## E.1 Post-integration corrections discovered after `380ff4c`

These are concrete gaps in the current app that the high-level integration
report did not make sufficiently explicit:

| Priority | Gap | Evidence | Acceptance |
|---|---|---|---|
| P0 for new LPs | `program.ts::ensureAta` only checks token accounts; it does not create missing WSOL/USDC/share ATAs. `VaultPage` uses `min_shares=1`. | `app/src/chain/program.ts`, `app/src/pages/VaultPage.tsx`; the successful deposit used an external script that created/wrapped accounts | A fresh wallet can simulate and submit a deposit after idempotently creating ATAs; integer expected shares produce a conservative `min_shares`, not a hardcoded 1 |
| P0 after oracle unblock | `SwapPage` still derives `min_out` from a floating-point reservation-price estimate. | `app/src/pages/SwapPage.tsx` (`effectivePrice`, `expectedOut`, `minOut`) | Valid quote path uses an integer quote/simulation result; client estimate cannot become authoritative execution |
| P1 | No claim-withdraw button or complete epoch/eligibility UI. | `app/src/chain/program.ts` has `claimWithdraw`; `VaultPage` does not expose a claim action | Real ticket is read, claim enabled only when eligible, confirmation refreshes shares/reserves/ticket |
| P1 | No in-app replay selector/charts; analytics page mostly shows N/A after mock removal. | `app/src/pages/AnalyticsPage.tsx`, `app/src/data/backend.ts` | Replay mode renders artifact data with manifest commit/schema/scenario labels |
| P1 | Overview has hardcoded research ribbons/badges such as markout/CU/gap claims. | `app/src/pages/OverviewPage.tsx` (`problemCards`, ticker, metrics ribbon, principles) | Every number is live or artifact-backed and explicitly labelled model/replay; otherwise N/A |
| P1 | Integration guides still describe the legacy tSOL/tUSDC app configuration. | `docs/INTEGRATION.md`, `FULLGUIDE.md` contain tSOL/tUSDC paths and old app assumptions | Both guides describe canonical WSOL/USDC, current IDL/B1, and the external Pyth blocker |

These do not invalidate the current live account reads or the confirmed first
deposit, but they prevent the app from being called a complete generic-user LP
client.

## F. Final hackathon demo checklist

1. **Setup (stranger, no secrets):** `cargo test --workspace` → 167 pass;
   `pytest simulation -q` → 212 pass/2 skip; `cd app && yarn install && yarn test
   && yarn build` → 16 pass + build OK; `./scripts/headline.sh` → headline chart.
2. **Open the app** (Devnet): Navbar shows **Devnet**; Vault page shows the
   canonical **WSOL/USDC** vault TVL/reserves/shares **read live from chain**.
3. **Connect a Devnet wallet:** address shown; SOL/WSOL/USDC and share balance
   read live (no fabricated values).
4. **LP flow:** deposit form builds the real `deposit` instruction (integer
   amounts, canonical mints) — demonstrate simulation/confirm on a funded demo
   wallet (operator-run; already funded).
5. **Swap (honest limitation):** open Swap → swaps are **disabled** with the
   reason *"no fresh Pyth quote. The oracle must meet the deployed 2-second
   freshness requirement."* Explain the external entitlement blocker.
6. **Analytics/replay:** show `app/public/artifacts/*` (manifest commit/schema)
   and/or `python -m simulation.analytics demo`; label everything
   model/replay, **not** live trading.
7. **Evidence capture:** program hash MATCH, vault address, deposit tx link,
   funded balances, and the oracle status line.

---

## G. Unresolved decisions & scope deviations

1. **`docs/BUILD_PLAN.md` duplicates `BuilderPlan.md`** — keep one canonical;
   flag the copy.
2. **NAV reporting (M2)** is off-chain only (v3 decision); the app shows shares,
   not NAV. Confirm this is acceptable for the demo.
3. **Keeper network (M7)** is an **allowlist MVP** (`min_bond = 0`), not open
   bonded competition — a documented deviation; do not claim "open keepers".
4. **Analytics (M13/M16)**: no live indexer service; the app shows static replay
   artifacts + live chain reads. Decide whether to add an in-app replay mode.
5. **P4 gate wording** "dashboard reproduces the simulator charts on replayed
   data" is satisfied by the CLI/static dashboard, not the in-app pages yet.
6. **Prior audit `AUDIT_ACHIEVED_VS_PLAN.md` is superseded** by the B1 redeploy
   and the oracle blocker; its P2/P3 "PASS" no longer holds as written.
7. **Honesty caveats to keep in the pitch:** no independent audit; E1–E4 are
   simulation/model outputs; T-A thesis not achieved; retail (E4) lost to
   passive; E8 is a proxy. Do **not** claim ArbSwap beats passive AMMs/propAMMs.

---

## Blunt recommendation — the next three tasks, in order

1. **Get entitled Pyth access and publish the first quote** (external), then
   re-prove the post-B1 live lifecycle (`update_quote → swap → withdraw → claim`)
   on the funded canonical vault. This is the only task that turns on the live
   swap demo.
2. **Finish generic-user LP transaction integrity:** idempotently create base/
   quote/share ATAs, compute integer-safe `min_shares`, add claim/epoch UI, and
   add the cross-boundary tests. The already-funded operator deposit does not
   prove a fresh-wallet app deposit path.
3. **Add labeled in-app replay mode and refresh stale submission docs/marketing
   numbers** (`app/public/artifacts/*`, `README.md`, `docs/INTEGRATION.md`,
   `FULLGUIDE.md`) so the judge can see reproducible research while every live
   metric remains honest.
