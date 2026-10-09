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

## 4. CU table (before → after)

| Instruction | stale docs | current (LiteSVM) |
|---|---|---|
| `update_quote` | 17,962 | **51,296** |
| `swap` | 71,518 | **61,513** |
| `deposit` | 46,477 | 46,533 |
| `request_withdraw` | 24,420 | 19,920 |
| `claim_withdraw` | 24,158 | 24,189 |
| `crank_epoch` | 5,157 | 5,182 |
| `bond_keeper` / `slash_keeper` / `claim_keeper_reward` | 26,409 / 15,507 / 13,967 | 26,541 / 14,153 / 14,026 |
| `unbond_keeper` (queue / release) | 16,242 / 18,379 | 16,242 / 18,379 |

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
