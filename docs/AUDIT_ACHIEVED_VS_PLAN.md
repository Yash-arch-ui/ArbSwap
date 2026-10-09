# AUDIT_ACHIEVED_VS_PLAN.md

**Achieved vs. not achieved against `MasterPlan.md` and `BuilderPlan.md`, phase
by phase, with data.**

| | |
|---|---|
| Audited head | `main` @ `0a9c44e` (2026-10-09) |
| Auditor | same-agent review, **not independent** |
| Scope | `MasterPlan.md` (v3, 521 lines) and `BuilderPlan.md` (v1.0, 779 lines) |
| Method | every row tagged with a file, test, command, or measurement; unrun = **UNVERIFIED**, absent = **NOT DONE** |
| Honesty rule | model outputs are labelled; losing/zero-share regimes are shown |

> **The one-sentence finding.** Every *engineering* phase gate in the BuilderPlan
> (P0–P6) is **PASSED**, and the submission package exists. The *economic thesis*
> the MasterPlan sets out to prove — that open, active, honest quoting **beats a
> passive pool and is competitive with propAMMs** — is **NOT ACHIEVED**: the
> headline numbers are uncalibrated model outputs (F-08) and, in the routed world,
> ArbSwap wins **~0% of volume**.

---

## 0. Scorecard

| Phase | BuilderPlan gate | Gate verdict | MasterPlan phase intent | Intent verdict |
|---|---|---|---|---|
| P0 Foundations | assumptions resolved/escalated; CI green | **PASS** | spec, threat model, data access | **PASS** (a few `VERIFY` items open) |
| P1 Math + simulator | `tq-math` passes vectors; honest results in ≥3 regimes | **PASS** | "beats B1 and B2 in ≥2 regimes on paper" | **PARTIAL** — beats B1/B2 in the model (5/5 windows) but uncalibrated; value claim not credible |
| P2 On-chain program | full loop on devnet; invariants pass | **PASS** | M1–M4, M8–M10 on devnet | **PASS** |
| P3 Keeper | devnet quotes match sim; keeper-down expiry | **PASS** | Pyth client, priority fee, replay | **PASS** |
| P4 Analytics/fees/dashboard | dashboard reproduces E1–E4 charts | **PASS** (as defined) | indexer, attribution, fee split, HWM fee, dashboard | **PARTIAL** — HWM/hedged-profit fee NOT DONE; Next.js dApp NOT built |
| P5 Hardening/network | every E7 attack contained + documented | **PASS** | attacker bots, bonds/slashing, aggregator, governance, fuzz | **PASS** (E8 partial; full Jupiter listing needs a Jupiter-side `Swap` variant) |
| P6 Story/submission | stranger reproduces the headline chart from the README | **PASS** | reproducibility, deck, demo, backup | **PASS** |

**Gates: 7/7 PASS. Product thesis: NOT ACHIEVED.**

---

## 1. Evidence base (current head)

| Check | Result |
|---|---|
| `cargo test --workspace` | **133 passed** |
| `pytest simulation -q` | **183 passed** (reference 53, sim 99, analytics 17, attackers 8, +6 misc) |
| `cargo fmt --check` / `cargo clippy -D warnings` (incl. program) | clean |
| `anchor build` | green |
| Golden vectors | **997**, regen bit-identical |
| Guard mutation table | **31 guards**, all mutations caught (`docs/SECURITY_CHECKLIST.md` §2c) |
| Devnet program | `CCR33kX4Q9iucvgN4kRga2txmtu32vxy3bXpKyxPdBQx` (deployed, admin claimed) |

---

## 2. Phase-by-phase

### P0 — Foundations

| BuilderPlan task | Status | Evidence |
|---|---|---|
| T0.1 Read priority sources, answer study questions | DONE | `docs/READING_NOTES.md` (215 lines) |
| T0.2 Repo + workspace + CI (`cargo test` + Python) | DONE | `.github/workflows/ci.yml`; local steps green |
| T0.3 `docs/ASSUMPTIONS.md`, resolve every *verify* | PARTIAL | 401 lines, A-01…A-23; **open**: A-06 (deep prior-art read), A-07 (Pyth product choice), A-08 (priority-fee introspection), A-14 (production boundary) |
| T0.4 Confirm data access | DONE | Binance klines + aggTrades + USDC archives; `docs/DATA_MANIFEST.md` (SHA-256) |

**Gate:** PASSED. **MasterPlan §17 limits** addressed in `docs/ASSUMPTIONS.md` + `docs/THREAT_MODEL.md`.

### P1 — Math and simulator

| BuilderPlan task | Status | Evidence / data |
|---|---|---|
| T1.1 Python reference (Section 5) | DONE | `simulation/reference/` (53 tests) |
| T1.2 Golden vectors ≥500 | DONE | **997** vectors, bit-identical regen |
| T1.3 Rust `arb-math` matches vectors | DONE | `vault/math` (27 tests incl. `proptest.rs`) |
| T1.4 Simulator B1/B2/TruQuote + metrics | DONE | `simulation/sim/venues.py`, `metrics.py` |
| T1.5 Walk-forward calibration | DONE | W1 calibrate → W2–W6 frozen; `frozen_params.json` |
| T1.6 E1–E4 results | DONE | `docs/P1_RESULTS.md` |

**Gate:** PASSED (vectors + honest reporting in calm/trend/crash).

**MasterPlan P1 intent — "TruQuote beats B1 and B2 in ≥2 regimes, honestly reported."**
Achieved *in the model*, honestly reported:

| Window | Regime | E1 (vs B1) | ArbSwap | B1 | B2 |
|---|---|---|---|---|---|
| W2 | unlabelled | +686.9% | 4,895.3 | 622.1 | −10,341.8 |
| W3 | crash | +469.9% | 4,356.9 | 764.5 | −8,561.0 |
| W4 | trend | +726.1% | 3,960.8 | 479.4 | −12,034.4 |
| W5 | unlabelled | +2,406.5% | 4,859.9 | 193.9 | −4,023.4 |
| W6 | calm | +750.5% | 4,960.4 | 583.2 | −2,004.5 |

Mean E1 **+1,008%**, 5/5 vs B1 and 5/5 vs B2. **These are model outputs.**

**NOT ACHIEVED (the credibility problem, F-08):** the passive benchmark is not the
paper's benchmark. B1 calibration best fit is **−0.020 bps / 2.409 bps** vs the
paper's **−0.2 / 2.6** on W1, but with *real* flow it **saturates at ≈ −7.9 / 13.1
bps** (~40× / 5× the paper). So the E1 magnitudes cannot be presented as a product
result. Additionally the **routed world** (a real order stream routed to the best
price) gives ArbSwap **~0% volume** — see §5.

### P2 — On-chain program

| BuilderPlan task | Status | Evidence |
|---|---|---|
| T2.1 Anchor accounts/config/errors/events | DONE | `vault/program/src/lib.rs` |
| T2.2 deposit/request_withdraw/claim_withdraw/crank_epoch (warm-up + queue) | DONE | LiteSVM lifecycle tests |
| T2.3 update_quote with all guards | DONE | `pyth_verification_rejects_untrusted_or_stale_updates`, anchor/level/spread/capacity/flow tests |
| T2.4 swap via `arb-math`; fee split | DONE | `swap_enforces_slippage_version_and_size`; aggregator parity test |
| T2.5 breakers, pause, timelocked set_params | DONE | `trip_breaker`/`reset_breaker`/`wind_down`/`set_params` |
| T2.6 Local validator + invariants + devnet deploy | DONE | `docs/DEVNET.md`; full lifecycle signatures |

**Gate:** PASSED — full deposit→update→swap→withdraw on devnet (`docs/DEVNET.md`),
all invariants pass (reserves ≥ liabilities, shares consistent, rounding favors
vault).

**MasterPlan M1–M4, M8–M10:** all DONE (vault core, pro-rata shares, quote state,
swap engine, risk limits, breakers, warm-up/queue).

**Measured CU (MasterPlan R1 / E10):**

| Instruction | CU | Paper reference | Note |
|---|---|---|---|
| `update_quote` | 17,962 | 485–676 | ≈27–37× — **"cheap update" claim NOT supported** |
| `swap` | 71,518 | ≥16,938 | ≈4.2× |
| `deposit` | 46,443 | — | fits 200k default |
| `claim_withdraw` | 22,578 | — | |

Not like-for-like: the paper's update excludes on-chain oracle verification, which
dominates ours.

### P3 — Keeper

| BuilderPlan task | Status | Evidence |
|---|---|---|
| T3.1 Pyth client, vol estimators, quote via `arb-math` | DONE | `vault/keeper` (16 tests) |
| T3.2 Sender, adaptive priority fee, tight CU, retries | DONE | `LiveSender`, `MAX_UPDATE_COMPUTE_UNITS` |
| T3.3 Replay identical to simulator | DONE | `test_keeper_parity.py`; `replay complete: 347 quote updates` |
| T3.4 Keeper bond + reward flow | DONE | `bond_keeper`/`claim_keeper_reward`/`slash_keeper`/**`unbond_keeper`** |

**Gate:** PASSED — live keeper ran **600 s on devnet, 29 `update_quote`, 0
failures** (`docs/P3_AUDIT.md` §6); keeper-down safe expiry tested.

### P4 — Analytics, fees, dashboard

| BuilderPlan task | Status | Evidence |
|---|---|---|
| T4.1 Indexer + database | DONE | `store.py` (SQLite) + `live.py` (indexed 8 `QuoteUpdated` on devnet) |
| T4.2 Metrics engine (markout, quiet flow, hedged PnL, gap, attribution) | DONE | `metrics.py`; parity with simulator asserted |
| T4.3 Dashboard views + **demo mode** | DONE (demo) / **NOT DONE** (Next.js dApp) | `dashboard.py` (static HTML/SVG); `demo.py` (split-screen, scenario + attack buttons); `frontend/` has no source |
| T4.4 E1–E4 from indexed data | DONE (E1 + parity) | `test_reproduces_e1_from_indexed_events` |

**Gate:** PASSED (as defined).

**MasterPlan P4 extras NOT ACHIEVED:**
- **Hedged-profit performance fee with high-water mark** (MasterPlan §8.5) —
  **NOT DONE**; only the MVP fixed fee split exists.
- **Insurance-buffer LP-compensation governance** — design only.
- **Next.js dashboard / live demo app** — **NOT BUILT** (Stage-6 scope).

### P5 — Hardening and network

| BuilderPlan task | Status | Evidence / data |
|---|---|---|
| T5.1 Attacker bots; run E7 | DONE | 7 bots + control; all contained (`docs/P5_REPORT.md`) |
| T5.2 Fuzzing + property tests | DONE (substitute) | `proptest` (math 6 props ×2000, aggregator 3) + program state-machine test; **`cargo-fuzz` not installed** |
| T5.3 Security checklist + threat model | DONE | `docs/SECURITY_CHECKLIST.md` (31-guard mutation table), `docs/THREAT_MODEL.md` |
| T5.4 Aggregator adapter (verify Jupiter interface) | DONE (pricing + parity) | `arb-aggregator` + LiteSVM parity test `aggregator_quote_matches_onchain_swap`; interface verified (ASSUMPTIONS A-23); **full listing needs a Jupiter-side `Swap` variant** |
| T5.5 E8 / E9 / E10 | E9, E10 DONE; **E8 PARTIAL** | E9 45/81 negative cells; E10 CU above; E8 one real Jupiter quote (BisonFi 110.2525, impact 0.0005%) |

**Gate:** PASSED — every E7 attack contained and documented.

**MasterPlan M7/M19 (keeper network, governance):** bonds + rewards + slashing +
**unbond-with-cooldown** DONE; timelocked `set_params` + timelocked
`propose/execute_fee_claim` (protocol-only, fixed treasury) DONE; **multisig kill
switch NOT DONE** (pause-only exists via `wind_down`/`reset_breaker`).

### P6 — Story and submission

| BuilderPlan task | Status | Evidence |
|---|---|---|
| T6.1 README one-command headline chart | DONE | `./scripts/headline.sh` → `docs/headline_chart.svg` |
| T6.2 Methodology doc; results with limits | DONE | `docs/METHODOLOGY.md`, `docs/RESULTS.md` |
| T6.3 Demo video + live script + backup | DONE | `docs/DEMO_SCRIPT.md`; `docs/demo_backup.mp4` (36 s, 1280×720, h264) + auto-play HTML |
| T6.4 Pitch deck | DONE | `docs/PITCH_DECK.md` → `docs/pitch_deck.html` + `.pdf` |

**Gate:** PASSED — a stranger can reproduce the headline chart with no data/keys.

---

## 3. MasterPlan modules (M1–M20)

| ID | Module | Phase | Status |
|---|---|---|---|
| M1 | Vault core | P2 | **DONE** |
| M2 | Pro-rata shares + NAV reporting | P2 | **DONE** (shares); NAV reporting partial |
| M3 | Quote state | P2 | **DONE** |
| M4 | Swap engine | P2 | **DONE** |
| M5 | Pricing engine (vol/inventory/throttle) | P1 | **DONE** (keeper-side; LVR budget not enforced on-chain, relabelled) |
| M6 | Keeper client | P3 | **DONE** |
| M7 | Keeper network (bonds/rewards/slashing) | P5 | **DONE** (allowlisted + unbond; open competition not tested) |
| M8 | Risk limits | P2 | **DONE** (incl. per-window flow cap) |
| M9 | Circuit breakers | P2 | **DONE** (state-only, not griefable) |
| M10 | Warm-up + withdrawal queue | P2 | **DONE** |
| M11 | Fees + incentives | P4 | **PARTIAL** — MVP split DONE; HWM hedged-profit fee **NOT DONE** |
| M12 | Insurance buffer | P4 | **DONE (accrual)**; LP-compensation governance **NOT DONE** |
| M13 | Attribution | P4 | **DONE** |
| M14 | Simulator + backtester | P1 | **DONE** |
| M15 | Attacker bots | P5 | **DONE** |
| M16 | Analytics API | P4 | **DONE** |
| M17 | Dashboard | P4 | **PARTIAL** — static + demo DONE; Next.js dApp **NOT DONE** |
| M18 | Aggregator adapter | P5 | **PARTIAL** — pricing + parity DONE; live Jupiter listing **NOT DONE** |
| M19 | Governance + timelock | P5 | **PARTIAL** — timelock DONE; multisig kill switch **NOT DONE** |
| M20 | Docs + reproducibility | P6 | **DONE** |

**Modules: 15 DONE, 5 PARTIAL, 0 absent.**

---

## 4. Experiments E1–E10

| ID | Question | Status | Data |
|---|---|---|---|
| E1 | LVR reduction vs B1 | Model DONE; **credibility NOT ACHIEVED** | +469% … +2,406% (mean +1,008%), 5/5 windows — model output, uncalibrated (F-08) |
| E2 | Positive markouts | Model DONE | ArbSwap 2s markout +4.0 … +6.8 bps vs B1 +0.03 … +0.32 bps |
| E3 | Hedged LP return | Model DONE | ArbSwap > B1 and > B2 in all 5 windows |
| E4 | Retail execution quality | **NOT ACHIEVED** | ArbSwap quiet half-spread **~8 bps vs B1 ~2 bps** — worse than passive |
| E5 | Depth-throttle value | DONE | ablation B3; negative in some windows (e.g. W2 −498) |
| E6 | Cost of honesty | DONE | ArbSwap fill rate 56% vs B4 100%; gap −2.27 bps (better than quoted) |
| E7 | Safety | **DONE** | 7 bots + control contained; keeper-down → 1 update, fills stop |
| E8 | Real Solana pool quote gap | **PARTIAL** | 1 real Jupiter quote (BisonFi 110.2525, impact 0.0005%); **fill gap not measured** |
| E9 | Sensitivity | DONE | **45/81 cells negative E1** (losing regimes reported) |
| E10 | Solana cost | DONE | `update_quote` 17,962 CU, `swap` 71,518 CU; 26.6× / 4.2× paper |

---

## 5. Success metrics (BuilderPlan §2.5) — the honest scoreboard

| Metric | Target | Result | Achieved? |
|---|---|---|---|
| LVR vs passive | lower | model: E1 +1,008% | **UNPROVEN** (uncalibrated) |
| 2s markout | positive | +4.0 … +6.8 bps (model) | model only |
| Hedged return | > passive | model: 5/5 windows | model only |
| Quote-versus-fill gap | ≈0 | on-chain: −2.27 bps (fills better than quoted) | **YES (on-chain)** |
| Quiet half-spread | ≤ passive | **~8 bps vs B1 ~2 bps** | **NO** |
| CU per update | "under ~1,000 (verify)" | **17,962** | **NO** |
| Routed volume share | competitive | **ArbSwap 0.0%**, B1 0.3%, propAMM-like 99.6% | **NO** |

Routed-world table (W1–W6 mean; real price path, synthetic flow;
`./scripts/headline.sh`):

| Venue | Volume share | Fill share | 2s markout (bps) |
|---|---|---|---|
| ArbSwap | 0.0% | 1.6% | +1.99 |
| B1 passive | 0.3% | 16.9% | −5.13 |
| PropAMM-like | 99.6% | 81.5% | −1.19 |

---

## 6. Win map, demo, submission (MasterPlan §15, BuilderPlan §15)

| Item | Status |
|---|---|
| Working devnet loop (not slides) | **DONE** |
| One headline claim, three charts | **DONE** (`docs/HEADLINE.md`, `headline_chart.svg`) |
| LVR / markout-curve charts | **PARTIAL** — value-path charts + metrics, not the paper's exact LVR/markout curves |
| 3-minute demo + live script + backup recording | **DONE** |
| Pitch deck (10 slides) | **DONE** (`docs/pitch_deck.pdf`) |
| Hard-questions Q&A | **DONE** (deck + `docs/CLAIMS.md`) |
| Submission checklist (README, one-command reproduce, architecture, demo video, deck, deployed addresses, methodology) | **DONE** |
| "Admit limits before judges find them" | **DONE** (`docs/RESULTS.md`, deck close) |

---

## 7. Honest limits (MasterPlan §17) — resolved vs open

| # | Limit | Status |
|---|---|---|
| 1 | Solana spoofing unverified (39%/1.08 bps are Base) | **OPEN** — E8 partial only |
| 2 | Priority-fee introspection feasibility | **OPEN** (A-08; no on-chain penalty) |
| 3 | Pyth access/product | **RESOLVED** — persistent receiver feed, verified on devnet |
| 4 | Jupiter AMM-interface requirements | **RESOLVED** (A-09/A-23) — integration still open |
| 5 | LVR secondary-report figures | **DOCUMENTED** in ASSUMPTIONS |
| 6 | Edge risk vs top propAMMs | **DOCUMENTED** (mitigated, not removed) |
| 7 | Backtests are not live adversaries | **STATED** everywhere |
| 8 | Prior art (Lifinity) | **OPEN** (A-06 deep read) |
| 9 | Coefficients are heuristics | **STATED** |
| 10 | Not financial advice / regulatory | **STATED** |
| 11 | Q64.64 conventions/license | **RESOLVED** in ASSUMPTIONS |
| 12 | LVR with oracle-anchored quotes | **VALIDATED** in simulator (caveat kept) |
| 13 | Pro-rata deposits reduce UX flexibility | **ROADMAP** (single-sided not built) |
| 14 | Compute budget fits limits | **RESOLVED** (all instructions < 200k CU) |

---

## 8. Open findings (still not done)

| ID | Finding | Sev | Status |
|---|---|---|---|
| F-08 | Flow not calibrated to the paper (−7.9/13 vs −0.2/2.6) | **HIGH** | OPEN |
| E8 | Real Solana-pool quote/fill gap | MEDIUM | PARTIAL (1 quote, no fill gap) |
| F-17 | Stress windows / injected jumps (pre-registered weeks measured mid/low) | LOW | OPEN |
| A-06 | Deep prior-art read before demo | LOW | OPEN |
| A-08 | On-chain priority-fee introspection | LOW | OPEN |
| — | Multisig kill switch | LOW | NOT DONE (pause-only exists) |
| — | Hedged-profit HWM fee | LOW | NOT DONE (roadmap) |
| — | Next.js live dApp | LOW | NOT DONE (Stage 6) |
| — | Independent external audit | — | **NOT DONE** (required before real funds) |

---

## 9. Bottom line

**ACHIEVED (engineering + honesty):**
- A correct, guarded, tested **on-chain execution engine** (133 Rust / 183 Python
  tests, 997 golden vectors, 31-guard mutation table) with **verified Pyth**,
  PDA custody, pro-rata accounting, versioned honest quotes, expiry, breakers, and
  a per-window flow cap.
- A **keeper** that ran live on **devnet** (600 s, 29 updates) and a **full
  devnet money path** with published signatures.
- An **analytics + demo** stack, an **E7 adversary suite** with all attacks
  contained, an **aggregator pricing core + parity test**, and a complete
  **submission package** (one-command headline chart, results, demo video, deck).

**NOT ACHIEVED (the product thesis):**
- The claim that open active quoting **beats a passive pool** is supported only by
  **uncalibrated model output** (F-08), and in the **routed world ArbSwap wins ~0%
  of volume**.
- **Retail execution is worse** than passive (quiet half-spread ~8 vs ~2 bps).
- **Updates are not cheap** (17,962 CU vs the paper's 485–676).
- **E8** (real Solana quote/fill gaps) is only partial.
- No independent audit; no mainnet.

**Verdict:** BuilderPlan **7/7 gates PASSED**; MasterPlan product thesis
**NOT ACHIEVED**. The repo is an honest, reproducible *engine* and a *methodology*,
not yet a demonstrated *edge*.
