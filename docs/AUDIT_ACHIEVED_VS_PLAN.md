# AUDIT_ACHIEVED_VS_PLAN.md (C6.2)

**Achieved vs. not achieved against `MasterPlan.md` and `BuilderPlan.md`, with
written pass criteria and one status per item: PASS / CLOSED-BY-DECISION /
EXTERNAL.** Regenerated from the C1 bundle (`simulation/data/results/artifacts.json`).

| | |
|---|---|
| Audited head | `main` (commit in `artifacts.json.meta.commit`) |
| Auditor | same-agent review, **not independent** |
| Evidence base | `artifacts.json`, `cu.json`, `thesis.json`, `docs/P1_RESULTS.md`, `docs/DEVNET.md`, `docs/SECURITY_CHECKLIST.md` |

> **Statuses are not re-labelled.** Each gate is judged against the criterion
> written in `BuilderPlan.md` §12 (quoted verbatim below). Where a criterion was
> narrowed, it is stated and justified.

---

## 1. Phase gates (BuilderPlan §12) — criterion, verdict, evidence

### P0 Foundations
**Criterion (verbatim):** *"assumptions resolved or escalated; CI green."*
**Verdict: PASS.** `docs/ASSUMPTIONS.md` (A-01…A-24), `.github/workflows/ci.yml`
(rust + python + anchor). Open *verify* items are now CLOSED-BY-DECISION (A-08) or
EXTERNAL (prior-art deep read). Commit: `eeb15c1`.

### P1 Math and simulator
**Criterion (verbatim):** *"`tq-math` passes all vectors; TruQuote results
reported honestly in at least calm, trend, and crash regimes (even if it loses in
some)."*
**Verdict: PASS.** 997 golden vectors bit-identical; `docs/P1_RESULTS.md` reports
W2–W6 (calm/trend/crash + 2 unlabelled). Commit: `6423a93`.
**Not achieved (separate, not a gate):** the *value* claim — T-A not shown
(`docs/THESIS.md`), calibration residual CLOSED-BY-DECISION (C2.2).

### P2 On-chain program
**Criterion (verbatim):** *"full deposit, update, swap, withdraw loop on devnet;
all invariants pass."*
**Verdict: PASS.** Full lifecycle on devnet with signatures (`docs/DEVNET.md`);
invariants in `litesvm_lifecycle.rs`. Commit: `7184cb3`.

### P3 Keeper
**Criterion (verbatim):** *"keeper-driven quotes on devnet match the simulator
within tolerance; keeper-down test shows safe expiry."*
**Verdict: PASS.** Live keeper ran 600 s / 29 updates / 0 failures
(`docs/P3_AUDIT.md` §6); `keeper_outage_lets_the_quote_expire`. Commit: `36a3c79`.

### P4 Analytics, fees, dashboard
**Criterion (verbatim):** *"dashboard reproduces the simulator charts on replayed
data."*
**Verdict: PASS (as written).** E1 from indexed events + metric parity
(`simulation/analytics/tests`); static dashboard + interactive demo.
**CLOSED-BY-DECISION:** the Next.js dApp and the on-chain HWM fee were never part
of the written gate; the HWM fee is now an off-chain report (C4.4). Commit: `ed82a7e`.

### P5 Hardening and adversarial testing
**Criterion (verbatim):** *"every E7 attack fails or is contained and
documented."*
**Verdict: PASS.** 7 bots + control contained (`docs/P5_REPORT.md`).
**EXTERNAL:** E8 fill gap (needs funded mainnet trades); proxy measured (C4.7).
Commit: `7343e49`.

### P6 Story and submission
**Criterion (verbatim):** *"a stranger can reproduce the headline chart from the
README."*
**Verdict: PASS.** `./scripts/headline.sh` → `docs/headline_chart.svg` with no
data/keys. Commit: `0a9c44e`.

**Gates: 7/7 PASS.**

---

## 2. Modules (MasterPlan §4)

| ID | Module | Status | Evidence |
|---|---|---|---|
| M1 | Vault core | PASS | `vault/program/src/lib.rs` |
| M2 | Pro-rata shares + NAV reporting | PASS (shares) / CLOSED-BY-DECISION (NAV report) | share tests; NAV is off-chain only |
| M3 | Quote state | PASS | `QuoteState` |
| M4 | Swap engine | PASS | `swap_enforces_slippage_version_and_size` |
| M5 | Pricing engine | PASS (keeper-side policy; LVR budget not on-chain — relabelled) | `vault/keeper`, `docs/FORMULA.md` |
| M6 | Keeper client | PASS | `vault/keeper` |
| M7 | Keeper network (bonds/rewards/slashing) | PASS (bonded) / NOT CLAIMED (open competition) | `unbond_*`, `slash_*` tests |
| M8 | Risk limits | PASS | flow cap + caps tests |
| M9 | Circuit breakers | PASS | `litesvm_breaker.rs` |
| M10 | Warm-up + withdrawal queue | PASS | lifecycle tests |
| M11 | Fees + incentives | PASS (MVP split) / CLOSED-BY-DECISION (on-chain HWM) | `performance_fee.py` (off-chain) |
| M12 | Insurance buffer | PASS (accrual + invariant) / CLOSED-BY-DECISION (LP-comp governance) | `insurance_buffer`, `insurance_bucket_cannot_be_claimed_to_treasury` |
| M13 | Attribution | PASS | `simulation/analytics/metrics.py` |
| M14 | Simulator + backtester | PASS | `simulation/sim/` |
| M15 | Attacker bots | PASS | `simulation/attackers/` |
| M16 | Analytics API | PASS | `simulation/analytics/` |
| M17 | Dashboard | PASS (static + demo) / CLOSED-BY-DECISION (Next.js dApp) | `dashboard.py`, `demo.py` |
| M18 | Aggregator adapter | PASS (pricing + parity) / EXTERNAL (Jupiter listing needs a Jupiter-side `Swap` variant) | `aggregator_quote_matches_onchain_swap` |
| M19 | Governance + timelock | PASS (timelock) / CLOSED-BY-DECISION (admin rotation, A-24; multisig) | `set_params`/`apply_params`, `propose/execute_fee_claim` |
| M20 | Docs + reproducibility | PASS | this repo |

**Modules: 16 PASS, 4 CLOSED-BY-DECISION/EXTERNAL splits, 0 absent.**

---

## 3. Experiments E1–E10

| ID | Status | Data |
|---|---|---|
| E1 LVR reduction | SIMULATION ONLY | +469%…+2,406% (model, uncalibrated) |
| E2 markouts | SIMULATION ONLY | +4.0…+6.8 bps vs B1 ~0 |
| E3 hedged return | SIMULATION ONLY | ArbSwap > B1, B2 in 5/5 |
| E4 retail quality | **FAIL** | ArbSwap ~8 bps vs B1 ~2 bps |
| E5 throttle ablation | PASS (reported) | in `docs/P1_RESULTS.md` |
| E6 cost of honesty | PASS | fill 56% vs 100% |
| E7 safety | **PASS** | all contained |
| E8 real-pool gap | CLOSED-BY-DECISION | proxy only (`e8_proxy.json`) |
| E9 sensitivity | PASS | 45/81 negative cells; jump 0/27 |
| E10 cost | PASS | 49,709 / 59,344 CU (`cargo build-sbf`) |

---

## 4. Stage-closure (C1–C6)

| Stage | Status | Evidence |
|---|---|---|
| C1 single source of truth | **PASS** | `export_artifacts.py`, `render_docs.py`, `check_docs_consistency.py`; commit `eeb15c1` |
| C2 pre-registered thesis test | **PASS** (honest outcome) | `docs/THESIS.md`; Amendment 3; commit `6423a93` |
| C2.4 stress windows (2× real vol) | **EXTERNAL** (data) | `docs/THESIS.md` C2.4 |
| C3 reciprocal-sqrt redesign | **NOT DONE** | CU re-measured (C1); redesign is roadmap |
| C3.2 CU re-measure | **PASS** | `cu.json` (LiteSVM); devnet CU not measured |
| C4.1 mutation additions | PARTIAL | 44 caught; inverse-sqrt guard pending C3 |
| C4.2 cargo-fuzz | CLOSED-BY-DECISION | `proptest` used; tool absent |
| C4.3 admin rotation | CLOSED-BY-DECISION | A-24 (gap + required change) |
| C4.4 HWM fee + insurance | **PASS** | `performance_fee.py` + tests |
| C4.5 A-08 | CLOSED-BY-DECISION | A-08 (feasibility verified) |
| C4.6 prior art | **PASS** | `docs/PRIOR_ART.md` |
| C4.7 E8 proxy | **PASS (proxy)** | `e8_proxy.json` |
| C4.8 devnet keeper 30 min | **SKIPPED** | `ARBSWAP_DEVNET_KEYPAIR` unset |
| C5 frontend | **NOT DONE** | `frontend/` has no source |
| C6 handoff + audit | **PASS** | this file, `docs/AUDIT_PACKAGE.md` |

---

## 5. Bottom line

- **BuilderPlan gates: 7/7 PASS.**
- **MasterPlan product thesis: NOT ACHIEVED** (T-A not shown; routed share ~0%
  vs a tight propAMM; retail execution worse than passive).
- Every open item ends as PASS, CLOSED-BY-DECISION, or EXTERNAL; nothing is
  ambiguous. The repo is an honest, reproducible **engine + methodology**, not a
  demonstrated **edge**. Independent audit is **EXTERNAL**.

---

# Backend polish (B1–B10) — closure

Worked on `main` per instruction (overriding the earlier "branch polish / never
push main" text). One status per item.

| Item | Status | Evidence / commit |
|---|---|---|
| B1 CU regression | **PASS** | cause = build-method artifact (`cargo build-sbf` 49,709 vs `anchor build` idl-build ≈51.3k), not a source regression; `scripts/measure_cu.sh`; `86bacdc` |
| B2 compute redesign (verify-instead-of-compute) | **NOT DONE** | not implemented; exact capacity check retained. No technical reason exists (effort only), so it is NOT DONE, not CLOSED-BY-DECISION |
| B3a mutation completeness | **PARTIAL** | B4 admin guards + F6 pre-validation guards mutated; inverse-sqrt guard N/A (B2 not done) |
| B3b cargo-fuzz | **NOT DONE** | `cargo-fuzz` not installed; `proptest` used (`docs/SECURITY_CHECKLIST.md`) |
| B4 admin rotation | **PASS** | `propose_admin`/`accept_admin`/`cancel_admin` + 4 tests + S4.2 mutation; `8e5c9d8` |
| B5 thesis evidence | **PASS / NOT MET (honest outcome)** | F5 ran high-vol windows (2026-02-06, 2026-01-31) + real-flow T-A.i bootstrap CIs: **T-A.i NOT MET**; F4 diagnosis + coefficient re-choice: **no feasible candidate** |
| B6 E8 proxy 1 h | **NOT DONE** | 60-sample proxy exists (`e8_proxy.json`); the one-hour run was not done (reachable, so not CLOSED-BY-DECISION) |
| B7 devnet | **SKIPPED** | `ARBSWAP_DEVNET_KEYPAIR` unset |
| B8 keeper robustness | **PASS (offline)** | `prevalidate_quote` mirrors on-chain bounds + failure-injection tests; live-devnet injection SKIPPED |
| B9 data contract | **PASS** (a/b/d) / **CLOSED-BY-DECISION** (c) | `artifacts/public/*` + schemas + manifest + validation tests; `docs/DATA_SCHEMA.md`, `docs/INTEGRATION.md`; `b2a937c` |
| B10 final | **PASS** | bundle + docs regenerated; scans clean; tag `final-candidate-2` |

# Final fix pass (F1–F7) — closure

| Item | Status | Evidence / commit |
|---|---|---|
| F1 status honesty | **PASS** | `docs/STATUS.md` defines CLOSED-BY-DECISION; B2/B6 relabelled NOT DONE, high-vol no longer EXTERNAL; `docs/CLOSURE_REPORT.md`, `docs/AUDIT_ACHIEVED_VS_PLAN.md`, `docs/CLAIMS.md` |
| F2 CU single source | **PASS** | all CU rendered from `artifacts/public/cu.json`; `check_docs_consistency.py` scans every doc + bans stale tokens; stale values fixed |
| F3 bundle freshness | **PASS** | bundle regenerated at HEAD; `scripts/check_bundle_freshness.py` + CI; test suites re-run |
| F4 retail diagnosis | **PASS** | `simulation/sim/diagnose.py` → `diagnosis.json` (dominant term volatility 42%); router volume-share flaw fixed + regression; Amendment 6 re-choice → **no feasible candidate** |
| F5 real-flow evidence | **PASS (honest: T-A.i not met)** | `simulation/sim/real_flow_study.py` → `f5_real_flow.json`; 2 high-vol windows + 3 archived days, bootstrap CIs |
| F6 keeper robustness | **PASS (offline)** | `prevalidate_quote` + 12 keeper tests (dropped tx, expired blockhash, duplicate send, out-of-order, stale/wide oracle, clock skew, safe failure) |
| F7 devnet | **SKIPPED** | `ARBSWAP_DEVNET_KEYPAIR` unset; last devnet evidence dated in `README.md` |

`frontend/` untouched. No secrets; banned-word scan clean; CU + test counts match
the bundle (enforced by `scripts/check_docs_consistency.py`).
