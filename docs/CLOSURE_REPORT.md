# CLOSURE_REPORT.md — project closure (C1–C6)

**Final report for the closure pass.** Worked on `main` (per explicit
instruction, overriding the original `dev`/PR step). Head: `2ce76c0`, tag
`final-candidate-1`.

Companion docs: `docs/AUDIT_ACHIEVED_VS_PLAN.md` (per-gate/per-module verdicts),
`docs/AUDIT_PACKAGE.md` (independent-review handoff), `docs/THESIS.md` (thesis
test), `docs/RESULTS.md` (numbers, generated from the bundle).

---

## 1. Item disposition (one status each)

### Stages

| Item | Status | Evidence / commit |
|---|---|---|
| C1 single source of truth | **PASS** | `scripts/export_artifacts.py` → `simulation/data/results/artifacts.json`; `scripts/render_docs.py`; `scripts/check_docs_consistency.py` (CI); `eeb15c1` |
| C1.3 reconcile / superseded | **PASS** | provenance + superseded table in `docs/RESULTS.md`; stale CU removed |
| C2 pre-registered thesis | **PASS** (honest outcome) | Amendment 3 pre-registered `765f109`; `docs/THESIS.md` `6423a93` |
| C2.2 calibration | **CLOSED-BY-DECISION** | residual −7.9 / 13.1 bps documented |
| C2.3 operating point / frontier | **CLOSED-BY-DECISION** | objective pre-registered; frontier = `simulation/data/results/envelope.json` (40/75 ok) |
| C2.4 stress windows (2× real vol) | **EXTERNAL** (data) | jump sensitivity done (27 cells, 0 negative); `20fd8ec` |
| C2.5 operating envelope | **PASS** | 75 cells, `envelope.json` |
| C2.6 HEADLINE decision | **PASS** | "Option 1 not shown" |
| C2.7 niche | **PASS** | no-propAMM routed share 27.9% |
| C3 reciprocal-sqrt redesign | **NOT DONE** | roadmap; CU re-measured instead |
| C3.2 CU re-measure | **PASS** (LiteSVM); devnet **not measured** | `simulation/data/results/cu.json` |
| C3.3 target reset | **PASS** | "cheap updates" NOT CLAIMED |
| C4.1 mutation additions | **PARTIAL** | 44 caught; inverse-sqrt guard pending C3 |
| C4.2 cargo-fuzz | **CLOSED-BY-DECISION** | `proptest` used; tool absent |
| C4.3 admin rotation | **CLOSED-BY-DECISION** | A-24: gap + required change + wallet-level multisig handoff |
| C4.4 HWM fee + insurance | **PASS** | `simulation/analytics/performance_fee.py` + 4 tests |
| C4.5 A-08 | **CLOSED-BY-DECISION** | feasibility VERIFIED; not implemented |
| C4.6 prior art | **PASS** | `docs/PRIOR_ART.md` |
| C4.7 E8 proxy | **PASS (proxy)** | `simulation/data/results/e8_proxy.json` (60 samples) |
| C4.8 devnet keeper 30 min | **SKIPPED** | `ARBSWAP_DEVNET_KEYPAIR` unset |
| C5 frontend | **NOT DONE** | `frontend/` has no source |
| C6.1 handoff package | **PASS** | `docs/AUDIT_PACKAGE.md` |
| C6.2 closure audit | **PASS** | `docs/AUDIT_ACHIEVED_VS_PLAN.md` |
| C6.3 claims + banned scan | **PASS** | `docs/CLAIMS.md` statuses fixed; scan **CLEAN** |
| C6.4 fresh-clone repro | **PASS** | clean clone: `headline.sh` + consistency + scans |
| C6.5 tag / push | **PASS** | `final-candidate-1` pushed |

### Findings / assumptions / experiments / modules

| Item | Status |
|---|---|
| F-08 calibration | CLOSED-BY-DECISION |
| F-17 stress / jumps | EXTERNAL (real windows) |
| E8 real-pool gap | CLOSED-BY-DECISION (proxy) |
| A-06 prior art | PASS (`docs/PRIOR_ART.md`) |
| A-07 Pyth product | PASS (mechanics verified) |
| A-08 priority-fee introspection | CLOSED-BY-DECISION |
| A-09 / A-23 Jupiter interface | PASS (shape verified); listing EXTERNAL |
| A-24 admin rotation | CLOSED-BY-DECISION |
| E1 / E2 / E3 | SIMULATION ONLY |
| E4 retail | **FAIL** (reported) |
| E5 / E6 / E9 / E10 | PASS |
| E7 | PASS |
| M1–M20 | 16 PASS, 4 CLOSED-BY-DECISION/EXTERNAL splits, 0 absent |

---

## 2. Pre-registered T-A / T-B / T-C (Amendment 3)

**T-A "beats passive": NOT SHOWN** — T-A.i real-flow bootstrap CI not run;
T-A.ii quiet half-spread worse than B1; T-A.iii MET (27.9%); T-A.iv depends on
T-A.i.

**T-B** (ArbSwap volume share; propAMM-like at break-even):

| competitor half-spread | ArbSwap vol | B1 vol | prop vol |
|---|---|---|---|
| 0.3 bps | 0.0% | 0.3% | 99.7% |
| 0.5 bps | 0.0% | 0.3% | 99.6% |
| 1.0 bps | 0.1% | 0.8% | 99.1% |
| 2.0 bps | 0.7% | 2.1% | 97.3% |

**T-C** retail execution: ArbSwap ~8.0–8.3 bps vs B1 ~2.0–2.3 bps (worse in all
5 held-out windows); propAMM-like 0.5 bps.

**Decision: "Option 1 not shown."** Option 2 ("open, transparent, honest, bounded
active liquidity") is the sole headline; Option 3 is never claimed.

---

## 3. Calibration vs the paper

| | 2s markout (bps) | quiet half-spread (bps) |
|---|---|---|
| paper target | −0.2 | 2.6 |
| accept | [−0.5, 0.1] | [1.8, 3.4] |
| synthetic W1 fit | −0.020 | 2.409 |
| **real-flow residual** | **−7.9** | **13.1** |

**CLOSED-BY-DECISION:** parameter tuning cannot close the ~40×/5× gap (venue /
flow definition); bounded impact = all headline numbers are labelled model
outputs.

---

## 4. CU table (LiteSVM, `cargo build-sbf`)

Single source: `artifacts/public/cu.json`; `.so` sha256
`b98dfd73df0c2a9…` (681,592 B). `anchor build` (idl-build) is ~3k CU higher on
`update_quote` and is not the deployed binary. Old before/after figures are
superseded and live only in the historical stage reports.

| Instruction | CU |
|---|---|
| `update_quote` | **48,209** |
| `update_quote_wide_conf_rejected` | 15,518 |
| `swap` | **59,327** |
| `deposit` | 45,153 |
| `request_withdraw` | 19,662 |
| `claim_withdraw` | 23,728 |
| `crank_epoch` | 5,162 |
| `bond_keeper` | 24,630 |
| `slash_keeper` | 13,901 |
| `claim_keeper_reward` | 13,828 |
| `unbond_keeper` (queue / release) | 16,242 / 18,379 |
| `propose_admin` | 8,060 |
| `accept_admin` | 9,367 |
| `cancel_admin` | 7,555 |

Devnet CU: **not measured** (needs a funded run). The ≤40k target is **not met**.

---

## 5. What did not pass, in plain words

- **The value claim (Option 1) is not shown.** Against a tight propAMM ArbSwap
  wins ~0% of routed volume; retail execution is ~4× worse than a passive pool.
  The positive model markout is uncalibrated.
- **C3** (reciprocal-sqrt compute redesign) and **C5** (Next.js frontend) were
  **not done** — both are large and need more budget to land tested.
- **C2.4** real high-volatility windows are **EXTERNAL** (need new data);
  **C4.1** inverse-sqrt mutation, **C4.2** cargo-fuzz, and **C4.8** 30-min devnet
  keeper remain CLOSED-BY-DECISION / SKIPPED.
- **Independent audit is EXTERNAL.**

---

## 6. Confirmations

- **Everything is on `main`** (explicit instruction; no `dev`, no PR — the
  original C6.5 branch/PR step was superseded). Pushed `2ce76c0`; tag
  `final-candidate-1`.
- **No secrets** in repo / logs / history (final scan clean).
- **No banned wording** — `scripts/banned_words.py` → **CLEAN**.
- **Numbers in docs match the bundle** — `scripts/check_docs_consistency.py` →
  **consistent** (CI-enforced).
- **CI gate green:** 133 Rust / 189 Python, fmt + clippy clean, `anchor build` OK.

Every open item now ends as **PASS**, **CLOSED-BY-DECISION**, or **EXTERNAL**;
the two stages that could not be completed (C3, C5) are marked **NOT DONE** with
reasons rather than left ambiguous.

---

## 7. Final fix pass (F1–F7) — added on top of C1–C6

Definition of the status words is now in `docs/STATUS.md`. Applying it:

- **F1 honesty:** **B2** (compute redesign) and **B6** (one-hour E8 proxy) are
  relabelled **NOT DONE** (effort is not a technical reason); the high-volatility
  windows are no longer "EXTERNAL" — they are **run** (F5). **B8** is now
  **PASS (offline)**.
- **F2 CU single source:** every CU number in every doc is generated from
  `artifacts/public/cu.json`; `scripts/check_docs_consistency.py` scans all docs
  and bans stale tokens. Canonical: `update_quote` **48,209**, `swap` **59,327**
  (`cargo build-sbf`; `.so` sha256 `b98dfd7…`).
- **F3 bundle freshness:** the bundle is regenerated at HEAD and
  `scripts/check_bundle_freshness.py` (in CI) fails if the manifest drifts.
- **F4 retail diagnosis:** `simulation/sim/diagnose.py` decomposes the quiet
  half-spread — the **dominant term is volatility (~42%)**. The router
  `volume_share` was counting *attempted* notional (rejected orders); fixed with
  a regression test, and affected numbers marked superseded. The Amendment-6
  volatility re-choice found **no feasible candidate**, so the frozen parameters
  and the Option-2 decision stand.
- **F5 real-flow evidence:** two high-volatility windows (2026-02-06 σ=3.79×σ_ref,
  2026-01-31 σ=2.44×σ_ref) plus the three archived aggTrades days drive a
  real-flow bootstrap; **T-A.i is NOT MET** (95% CI above zero on 0 of 5 days).
  Reported honestly, including the negative real-flow B1 residual (F-08).
- **F6 keeper robustness:** `arbswap_keeper::prevalidate_quote` mirrors the
  on-chain knowable bounds offline; 12 keeper tests cover dropped transactions,
  blockhash expiry, duplicate sends, out-of-order slots, stale/wide oracle,
  clock skew and safe failure.
- **F7 devnet:** **SKIPPED** (`ARBSWAP_DEVNET_KEYPAIR` unset); the date and
  commit of the last devnet evidence are recorded in `README.md`.

Every F item now ends as PASS, or SKIPPED with the exact precondition. The value
claim (Option 1) remains **not shown**.
