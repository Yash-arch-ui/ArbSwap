# TARGETIDEATASKS.md

### From the repo as it is today → to the ArbSwap (TruQuote) that the MasterPlan and Build Plan actually promise

*Audit date: 2026-10-08. Sources of truth for the target: `MasterPlan.md` and
`BuilderPlan.md` (imported as `docs/BUILD_PLAN.md`). Evidence for reality:
the code, tests, and `docs/AUDIT_FULL.md` / `docs/SECURITY.md` / `docs/LEFTOVER_TASKS.md`.*

This document has four jobs:

1. **§1** state the idea/target precisely (what we promised to build and prove);
2. **§2** a **phase-by-phase audit** (P0–P6) of what is actually there;
3. **§3** an **idea-vs-reality matrix** (every promise, element by element);
4. **§4–§9** the concrete **task plan, gates, and acceptance criteria** to reach
   the pitched project.

> **One-line verdict:** the repo is a *correct, well-tested execution engine and
> research simulator* with **one missing thing: the proof**. The central pitch
> claim — *"open, active, honest quoting beats a passive pool and is competitive
> with propAMMs"* — is **not demonstrated**, there is **no live devnet loop**, and
> there is **no dashboard/demo**. Everything below is aimed at that gap.

---

## 1. The target idea (distilled from MasterPlan + Build Plan)

### 1.1 One-liner

> **ArbSwap/TruQuote is an AMM + propAMM hybrid:** the open pooled capital of an
> AMM + the active, volatility-aware quoting of a propAMM, run like a
> professional desk (risk limits, circuit breakers, audited accounting, bonded
> operators), with one hard promise to traders: **the price you are quoted is the
> price you get.**

### 1.2 The four testable promises (BuilderPlan §2.3)

| # | Promise | Meaning |
|---|---|---|
| PR-1 | Honest execution | executed output ≥ `min_out`; quote-vs-fill gap reported and ≈0 |
| PR-2 | Bounded keeper power | a keeper can never set a price outside on-chain bounds |
| PR-3 | Safe failure | if keeper/oracle fails, quotes expire and the vault stops filling |
| PR-4 | Fair accounting | pro-rata deposits/withdrawals, not gameable by timing |

### 1.3 What the project must *show* (Win map §15.2, Dashboard §9.2)

| Beat | Claim it proves |
|---|---|
| B-A | **LVR chart** — passive pools lose to arbitrage; ArbSwap loses less | PR-1 is economically worth something |
| B-B | **Reprice-first on a jump** — passive pool is picked off; ArbSwap reprices first | the "active" half is real |
| B-C | **Markout curves** — passive negative, ArbSwap positive | professional execution quality |
| B-D | **Quote-vs-fill ≈ 0** | honest execution (the differentiator vs propAMMs) |
| B-E | **Crash scenario** — depth throttle + breaker keep LPs safe | PR-2/PR-3 |
| B-F | **Working devnet loop + keeper + dashboard demo mode** | it is a product, not slides |

### 1.4 Success metrics (BuilderPlan §2.5) and Definition of Done (§15.1)

| Metric | Target |
|---|---|
| LVR vs passive pool | lower in most regimes |
| 2s markout | positive overall |
| Hedged return (fees − LVR) | higher than passive |
| Quote-vs-fill gap | ≈0 bps |
| Quiet-flow half-spread | ≤ passive pool |
| CU per update | "under ~1,000 (verify)" |

Done = devnet deployment with full loop + keeper running; all invariants and
golden vectors green; **E1–E10 produced by one command with limits stated**;
dashboard with demo mode; threat model + assumptions documented.

### 1.5 Non-goals for v1 (so we don't over-scope)

Multi-pair vaults, a token, cross-venue routing, single-sided deposits, an LVR
auction, on-chain hedging. These are roadmap only.

---

## 2. Phase-by-phase audit (P0 → P6)

Verdict legend: **DONE** · **PASS(local)** · **PARTIAL** · **NOT DONE**.

### P0 — Foundations (repo, toolchain, assumptions, data)
**Verdict: DONE (small opening items remain).**

| Task | Status | Evidence |
|---|---|---|
| Repo + workspace + CI | DONE | `.github/workflows/ci.yml` runs fmt, clippy (incl. program), cargo test, pytest, golden-in-sync, anchor build |
| Assumptions resolved | PARTIAL | `docs/ASSUMPTIONS.md` A-01…A-21; still OPEN: A-07 (Pyth Core vs Lazer), A-08 (priority-fee introspection), A-09 (Jupiter license/interface) |
| Data access | DONE | Binance klines + aggTrades + USDC archives under `simulation/data/raw/` (gitignored); `docs/DATA_MANIFEST.md` |
| **Version control hygiene** | **BROKEN** | `.gitignore` ignores **all `*.md`** except a whitelist → `MasterPlan.md`, `BuilderPlan.md`, `docs/BUILD_PLAN.md`, `docs/ASSUMPTIONS.md`, `docs/AUDIT_FULL.md`, `docs/THREAT_MODEL.md`, `docs/READING_NOTES.md` are **untracked**; `docs/P1_PREREGISTRATION.md` and `docs/P1_RESULTS.md` are **tracked-but-deleted** in the working tree (`git status` shows ` D`) |

### P1 — Math + simulator + evaluation
**Verdict: PARTIAL — math is solid; the *value claim* is unproven.**

| Task | Status | Evidence |
|---|---|---|
| Python high-precision reference | DONE | `simulation/reference/` (`quote_math.py`, `fixed.py`, `ladder.py`) |
| Rust fixed-point math, bit-exact | DONE | `vault/math/`; 997 golden vectors; proptest properties |
| Simulator B1–B4 + metrics | DONE | `simulation/sim/venues.py`, `metrics.py`, `engine.py` |
| Walk-forward calibration | DONE (infra) | `simulation/sim/windows.py`, `study.py`; W1 frozen in `frozen_params.json` |
| Multi-venue router / fill share | DONE (infra) | `simulation/sim/router.py` |
| Real aggTrades flow layer | DONE (infra) | `simulation/sim/real_flow.py` |
| **E1 "beats passive" credible** | **NOT SHOWN** | README marks P1 **PARTIAL**; synthetic flow; B1 calibration target paper-labelled but held-out B1 diverges; E1 magnitudes are "model outputs, not results" |
| **E8 real Solana-pool quote gap** | **NOT DONE** | no Solana DEX/indexer data source wired |
| **Stress windows ≥2× vol** | **NOT DONE** | pre-registered acceptance (d) still PARTIAL (C1 = 1.75e-4 ≈ 1.26× existing) |
| **Competitive vs propAMM** | **NEGATIVE** | routed world: ArbSwap **0.0%** volume share vs a 0.3–1 bp propAMM (router tests) |
| E1–E10 one command | PARTIAL | `scripts/p1_all.sh` runs P1 study + synthetic report; not all experiments/E8 |

**Root cause (documented, `docs/AUDIT_FULL.md` F-08):** with real flow the model
converges to B1 2s markout ≈ **−7.9 bps** / quiet half-spread ≈ **13 bps**, vs the
paper's **−0.2 / 2.6** — a ~40× / ~5× research gap that the parameter knobs cannot
close. So the benchmark itself is not yet the paper's benchmark, and ArbSwap's
apparent positive markout (+16 bps earlier, +5.6 bps in `P1_RESULTS.md`) is a model
artifact, ~10× the paper's propAMM range.

### P2 — On-chain program
**Verdict: PASS (local, LiteSVM) — devnet gate OPEN.**

| Task | Status | Evidence |
|---|---|---|
| Accounts, config, errors, events, timelock | DONE | `vault/program/src/lib.rs` |
| Deposit / withdraw queue / epoch | DONE | `deposit`, `request_withdraw`, `crank_epoch`, `claim_withdraw` |
| `update_quote` with all guards | DONE | Pyth `PriceUpdateV2` (owner, feed id, freshness, price, conf), anchor↔oracle cap, level↔anchor binding, flow cap |
| `swap` via `arb-math`, fee split | DONE | `swap`; fee buckets; expiry/version/size/pause |
| Breakers, pause, timelocked `set_params` | DONE | `trip_breaker`, `reset_breaker`, `wind_down`, `set_params`/`apply_params` |
| Keeper bond / reward / slash | DONE | `bond_keeper`, `claim_keeper_reward`, `slash_keeper` |
| Fee claim to fixed treasury (timelocked) | DONE | `propose_fee_claim`/`execute_fee_claim` (protocol only) |
| Local tests | DONE | 30 lifecycle + 2 breaker + 2 security + 3 lib = 37 program tests |
| **Devnet deployment** | **NOT DONE** | `scripts/devnet_deploy.sh` exists, never run |
| **`unbond_keeper`** | **MISSING** | bond is locked → "open keeper network" is **overstated** |
| **LVR depth budget on-chain** | **NOT ENFORCED** | relabelled as "keeper-side policy bounded by caps" |
| **CU vs paper** | **UNSUPPORTED** | `update_quote` ≈ 17,962–20,013 CU vs paper 485–676; but not like-for-like (paper excludes on-chain oracle verification) |

### P3 — Keeper
**Verdict: PASS (core) — live RPC gate OPEN.**

| Task | Status | Evidence |
|---|---|---|
| Pyth Hermes client + `PriceSource` | DONE | `vault/keeper/src/lib.rs`, `main.rs` |
| Quote calculator via `arb-math` | DONE | keeper reuses the shared math |
| Adaptive priority fee, tight CU limit | DONE | `adaptive_priority_fee`, `MAX_UPDATE_COMPUTE_UNITS` |
| Replay mode (deterministic) | DONE | `keeper replay <csv>`; parity with `quote_math` |
| Bond + reward flow | DONE | on-chain + keeper |
| **Live loop against a real cluster** | **NOT DONE** | `LiveSender`/`live` code exists, never submitted with a funded devnet key |
| **Keeper σ time-normalisation** | PARTIAL | EWMA not time-normalised vs reference |

### P4 — Analytics + dashboard
**Verdict: PARTIAL — metrics are real; the product (UI/demo) is not.**

| Task | Status | Evidence |
|---|---|---|
| Indexer + event model | DONE | `simulation/analytics/` (`events.py`, `indexer.py`) |
| Metrics (markout, LVR, gap, attribution) | DONE | `metrics.py`; parity with simulator |
| Charts + static dashboard | DONE (static) | `simulation/analytics/out/dashboard.html` (deterministic replay) |
| **Dashboard demo mode (split-screen, scenarios, attack buttons)** | **NOT DONE** | only a static HTML table; no interactive UI |
| **Frontend dApp** | **NOT DONE** | `frontend/` contains only `package.json`, `tsconfig.json`, `yarn.lock` — **no source**; README points at `app/` which does not exist |
| Live indexed data view | NOT DONE | no devnet indexer run |

### P5 — Hardening + adversarial
**Verdict: PASS (gate: E7 contained) — several items open.**

| Task | Status | Evidence |
|---|---|---|
| E7 attacker bots | DONE | `simulation/attackers/e7.py`, `scenarios.py` |
| Property / fuzz tests | DONE (partial) | `vault/math/tests/proptest.rs`, program state-machine test; no `cargo-fuzz` binary |
| Threat model + security checklist | PARTIAL | `docs/THREAT_MODEL.md`; `docs/SECURITY_CHECKLIST.md` referenced but **missing** |
| Keeper rotation + timelocked fee claim | DONE | on-chain tests |
| Aggregator adapter | PARTIAL | `vault/aggregator/` price engine + properties; **no verified live Jupiter CPI parity** |
| **E8 real-pool quote gap** | **NOT DONE** | needs a Solana DEX/indexer source |
| **Independent external audit** | **NOT DONE** | same-agent self-review only |

### P6 — Story + reproducibility + submission
**Verdict: NOT DONE.**

- No devnet deployment addresses / tx signatures.
- No 3-minute demo video, no live script, no backup recording.
- No pitch deck.
- One-command reproduce is partial: raw data is gitignored and download scripts
  exist, but the "headline chart" reproduction is not verified end-to-end by a
  stranger.
- README references missing docs (`docs/ANALYTICS.md`, `docs/ARCHITECTURE.md`,
  `docs/SECURITY_CHECKLIST.md`, `docs/P5_REPORT.md`, `app/`) → stale.

---

## 3. Idea-vs-reality matrix (the core audit)

| Idea element (source) | Promised | Reality in repo | Gap |
|---|---|---|---|
| Open pooled capital (AMM) | anyone deposits, pro-rata shares, warm-up, epoch queue | **Implemented + tested** (`vault/program`) | none material |
| Active quoting (propAMM half) | reprice without a trade, one cheap write | **Implemented** (keeper writes ladder; program stores it) | "cheap" not measured true (~18–20k CU) |
| Honest execution | quoted price = executed price | **Implemented** (`min_out`, `min_version`, stored levels, gap metric) | live proof pending; E8 missing |
| Profitable LVR vs passive | LVR lower, hedged return higher | **Not demonstrated credibly** | calibration gap (F-08); synthetic flow |
| Positive 2s markout | positive overall | **Not demonstrated credibly** | model artifact (~10× paper's propAMM) |
| Competitive with propAMMs | implied | **Loses**: 0.0% routed volume share vs 0.3–1 bp propAMM | either fix venue/model or change the claim |
| Bounded keeper power | on-chain bounds | **Implemented** (anchor↔oracle, level↔anchor, per-swap + per-window flow caps) | LVR budget not enforced |
| Safe failure | quotes expire on keeper/oracle failure | **Implemented + tested** | live proof pending |
| Fair accounting | pro-rata, timing-safe | **Implemented + tested**; no unbond for keepers | virtual-share offset unproven |
| Circuit breakers | trip on stale/wide/high-vol | **Implemented** (stale/expiry); volatility flag on-chain partial | vol/conf on-chain trip limited |
| Bonded open keepers | anyone bonds, rewards, slash | **Bond/slash/reward done; no unbond** | "open" overstated |
| Depth throttle from LVR | `V_active ≤ 8(R−gas)/σ²` | **Not enforced on-chain**; σ-target×confidence only | define `R`, `g_gas` or relabel (done) |
| Keeper network | multiple bonded keepers | allowlist MVP, `min_bond` gate | no unbond, no multi-keeper test |
| Analytics + dashboard | LP/trader/risk/comparison + demo mode | **Static HTML tables only** | no interactive app |
| Live devnet loop | deploy + keeper running | **Code ready, never run** | no devnet addresses |
| E1–E10, one command | every headline chart | E1–E7, E9, E10 partial; E8 missing | E8, one command |
| Reproducibility | stranger reproduces headline chart | partial; docs missing; specs untracked | P6 |
| Security | threat model + audit | thorough self-review | no independent audit |

**Blunt conclusion.** ArbSwap today is a *research + execution-engine prototype*.
It has not yet earned the words in its own README: "beats a passive AMM",
"positive markouts", "open keepers", "cheap updates", or "dashboard". It **has**
earned: correct shared math, a guarded on-chain engine, honest-execution
mechanics, and rigorous self-auditing.

---

## 4. The fork in the road (decide this first)

The single most important finding is that when made credible, **ArbSwap's
~1.5 bp effective spread loses to a 0.3–1 bp propAMM** (`simulation/sim/router.py`,
documented in `docs/AUDIT_FULL.md` Addendum 5 T2). So before spending more, pick
the pitch honestly:

| Option | Pitch | Requirement |
|---|---|---|
| **Option 1 — "Better than passive"** | open vault that loses less LVR than a passive pool | close the calibration gap and show a real edge vs passive in ≥3 regimes on real flow; still lose to propAMMs on raw price and say so |
| **Option 2 — "Open + honest" (recommended fallback)** | the *only* open, transparent, honest-quoting venue; match passive on price and win on execution quality | honest-execution metrics (gap ≈0, fill integrity) + openness + bonded keepers as the differentiator |
| **Option 3 — "Beat propAMMs"** | open and cheaper than closed desks | needs a genuine pricing/inventory edge; not currently evidenced and likely out of scope for v1 |

**Decision needed from the human** (see §9). Do not headline Option 3 unless §A1–A5
actually produce it.

---

## 5. Target task plan

Effort is a rough estimate for one focused engineer. IDs are stable for tracking.

### Track A — Prove the value (research; **blocks the entire pitch**)

| ID | Task | Acceptance | Est. |
|---|---|---|---|
| **A1** | Close/measure the calibration gap: align venue + flow definitions with the paper; report B1 markout ≈ −0.2 and quiet half-spread ≈ 2.6 held-out, or state the irreducible residual | calibration report + fit error; B1 within or the gap explicitly bounded | 3–5 d |
| **A2** | Make **real aggTrades flow** the primary flow layer for all venues (synthetic kept as a sensitivity only) | every held-out row carries real-flow markout/LVR/PnL with CIs | 2–3 d |
| **A3** | Stress windows ≥2× realized vol + injected jumps; labelling by measured vol | pre-registered acceptance (d) MET; stress table present | 2–3 d |
| **A4** | Reconcile E1 with the router: publish absolute hedged PnL + bootstrap CIs + volume/fill share, **including losing and zero-share cells** | operating envelope rebuilt with ≥5 values/axis; losses shown | 2–3 d |
| **A5** | Choose Option 1/2/3 from §4 on the evidence; update the **claims register** and README accordingly | one honest headline claim backed by one reproducible chart | 1 d |
| **A6** | E8: source real Solana pool quote/fill data; measure quote-vs-fill gap on our venue and 2–3 real venues | gap distribution + methodology | 3–5 d (data-dependent) |
| **A7** | One-command **E1–E10** (wire E8/E10 into `scripts/p1_all.sh`; freeze all artifacts) | single command reproduces every headline chart | 1–2 d |

**Track A gate:** a defensible, reproducible headline chart exists (or the claim
is honestly downgraded). Nothing in Track C/D should be built on an unproven claim.

### Track B — Make it real (on-chain + keeper + devnet)

| ID | Task | Acceptance | Est. |
|---|---|---|---|
| **B1** | Wire the live keeper: funded devnet key, real RPC `sendTransaction`, in-band Pyth update (Core) or sponsored feed, retries/backoff | `keeper live` posts quotes on devnet; logs show landed txs | 3–5 d |
| **B2** | Devnet deploy via `scripts/devnet_deploy.sh`; claim program admin; run full loop `deposit → update_quote → swap → request_withdraw → crank_epoch → claim_withdraw` | deployed program id + swap signature committed to docs | 2–3 d |
| **B3** | Measure **live** CU for `update_quote`/`swap`; report our instruction CU **separately** from Pyth verification; own the honest number | CU table with method; claims updated | 1–2 d |
| **B4** | Differential test: live keeper output == replay == simulator for the same tick | parity test green | 1–2 d |
| **B5** | `unbond_keeper` with cooldown (admin can still slash during cooldown) so "open keepers" is true | bond-in/out test; claim enabled | 1–2 d |

### Track C — Demo + dashboard (what judges see)

| ID | Task | Acceptance | Est. |
|---|---|---|---|
| **C1** | Build the real frontend in `frontend/` (Next.js): LP view, trader view, risk view, comparison view | `yarn build` + `yarn dev` run; views render from analytics output | 4–6 d |
| **C2** | **Demo mode:** deterministic cached split-screen passive-vs-ArbSwap replay, scenario selector (calm/trend/crash), attack buttons (freeze oracle, kill keeper, launch attacker bot) | replay renders offline; attacks visibly contained | 3–5 d |
| **C3** | Wire dashboard to indexed events + (optional) live devnet read-only view | live/replay toggle; no dependency on live markets for demo | 2–3 d |
| **C4** | 3-minute video + 5-minute live script + backup recording | recorded; stored outside git | 1–2 d |

### Track D — Submission + reproducibility

| ID | Task | Acceptance | Est. |
|---|---|---|---|
| **D1** | README one-command reproduce of the headline chart (incl. data download) | a stranger reproduces the chart from a clean clone | 1–2 d |
| **D2** | Methodology doc (limits, losing regimes, sources) + 10-slide pitch deck | docs merged, deck ready | 2–3 d |
| **D3** | Publish deployed addresses + tx signatures | in README + docs | 0.5 d |
| **D4** | **Fix `.gitignore`**: whitelist `TARGETIDEATASKS.md`, `MasterPlan.md`, `BuilderPlan.md`, `docs/BUILD_PLAN.md`, `docs/ASSUMPTIONS.md`, `docs/AUDIT_FULL.md`, `docs/THREAT_MODEL.md`; restore/commit `docs/P1_PREREGISTRATION.md` + `docs/P1_RESULTS.md` | `git status` clean; `git ls-files` shows all spec/audit docs | 0.5 d |
| **D5** | Fix stale doc references (`docs/ANALYTICS.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY_CHECKLIST.md`, `docs/P5_REPORT.md`, `app/` → `frontend/`) | no dangling links | 0.5 d |

### Track E — Hardening / carry-over findings

| ID | Task | Acceptance | Est. |
|---|---|---|---|
| **E1** | LVR budget: either enforce on-chain (store realized σ in `QuoteState`, check `V_active ≤ 8(R−gas)/σ²`) **or** keep the honest relabel and remove the language everywhere | claim and code agree | 3–5 d / 0.5 d |
| **E2** | Fix flow-accumulator units or drop it (`flow_n` is stored but never read) | code/docs consistent | 1 d |
| **E3** | Ratify the ladder offset convention in `docs/FORMULA.md` §15.1 | decision recorded | 0.5 d |
| **E4** | Keeper EWMA time-normalisation to match the reference | parity test with non-1s ticks | 1–2 d |
| **E5** | Aggregator: LiteSVM CPI parity against the Jupiter AMM interface; check license | parity test or documented blocker | 2–3 d |
| **E6** | `cargo-fuzz` for the program state machine (beyond proptest) | fuzz target runs in CI | 1–2 d |
| **E7** | Insurance-buffer governance (how fees reach LPs) | design + test | 2–3 d |
| **E8** | **Independent external audit** before real funds | report or documented deferral | external |

---

## 6. Sequenced milestones (go/no-go gates)

```
M0 (today)        Repo builds, tests green, self-audit done. Claim unproven. No demo.
        │
M1  PITCH-CRITICAL MINIMUM
        A1–A5  (credible benchmark + honest headline)
        B1–B2  (live devnet loop)
        C1–C2  (real dashboard + demo mode)
        D1–D4  (one-command reproduce + docs versioned)
        Gate: a devnet swap executes at the quoted price AND a deterministic
              cached demo replays AND the headline chart reproduces from a clean clone.
        │
M2  FULL PITCH
        A6 (E8) + B3–B5 + C3–C4 + D5 + E1–E5
        Gate: honest execution measured on-chain and on real venues; claims register current.
        │
M3  STRETCH / ONLY IF EVIDENCED
        Option 3 (beat propAMMs) via A1/A4, or independent audit (E8) for real funds.
```

**Recommended order of work (dependency-correct):**
`A1 → A2 → A3 → A4 → A5` (do not build demo before the claim is honest) →
`B1 → B2 → B3 → B4` → `C1 → C2 → C3 → C4` → `A6/A7, D1–D5, E1–E7`.

---

## 7. Claims register — what may be said, and when

| Claim | Today | After M1 | After M2 |
|---|---|---|---|
| "The price you're quoted is the price you get" | code + sim only | devnet-proven | + E8 real venues |
| "Beats a passive AMM on hedged PnL" | **unsupported** (model artifact) | shown on real flow, ≥3 regimes, with losses, **or downgraded** | confirmed |
| "Positive markouts" | **unsupported** | shown vs calibrated B1 | confirmed |
| "Competitive with propAMMs" | **contradicted** (0% routed share) | **do not claim** unless evidenced | optional |
| "Open keepers" | **overstated** (no unbond) | true (B5) | true |
| "Cheap updates" | **unsupported** (~18–20k CU) | honest number + like-for-like framing | — |
| "No exploit / admin cannot seize funds" | self-review only | self-review | + external audit (real funds) |
| "Dashboard / demo mode" | **not built** | built (C1/C2) | — |
| "Replicable results" | partial | one command (D1) | — |

---

## 8. Definition of done (checklist to close the idea)

- [ ] A credible, pre-registered, walk-forward benchmark on **real flow**, with
      losing regimes and CIs, and a **calibrated passive + propAMM** comparison.
- [ ] The headline claim chosen honestly (Option 1 or 2), reproducible by one command.
- [ ] Devnet deployment, full money-path loop, and a **live keeper** posting quotes;
      a swap executes at the quoted price.
- [ ] `unbond_keeper` implemented so "open keepers" is true.
- [ ] Real dashboard (LP/trader/risk/comparison) **and demo mode** with cached
      split-screen replay + attack buttons.
- [ ] 3-minute video + live script + backup.
- [ ] `.gitignore` fixed; specs/audit/plan/PRD tracked; `P1_PREREGISTRATION.md`
      and `P1_RESULTS.md` restored; dangling doc links fixed.
- [ ] Claims register matches the evidence (nothing unproven is headlined).
- [ ] (Before real funds) independent external audit.

---

## 9. Open decisions needed from the human

1. **Which pitch?** Option 1 (beat passive), Option 2 (open + honest, recommended
   fallback), or chase Option 3. This determines how much of Track A is
   worth doing.
2. **LVR budget** (`E1`): enforce on-chain (needs `R`, `g_gas`) or keep the honest
   relabel everywhere?
3. **Unbond** (`B5`): include the open keeper network now, or drop the "open
   keepers" claim for v1?
4. **E8 data source** (`A6`): is a Solana DEX/indexer dataset sourceable for
   quote-vs-fill measurement? If not, the honesty claim is construction-only.
5. **External audit** (`E8 hardening`): approve reviewer/budget before any real
   funds?
6. **Demo build** (`C1`): build the Next.js app in `frontend/` (confirm the path;
   README currently says `app/`).

---

## 10. Ten-line executive summary

- **The idea:** open pooled capital + active, volatility-aware, honest quoting,
  proven to beat a passive AMM.
- **Reality:** the on-chain engine and shared math are correct and well tested;
  the *proof*, *live loop*, and *demo* are missing.
- **The blocker:** the flagship value claim is a model artifact (calibration gap)
  and, when routed credibly, ArbSwap loses to a tight propAMM.
- **The fix:** Track A (prove the value honestly) → Track B (deploy + live keeper)
  → Track C (real dashboard + demo) → Track D (reproducibility/claims).
- **First action:** decide the pitch (Option 1 vs 2), then start `A1`.
- **Minimum shippable pitch (M1):** A1–A5 + B1–B2 + C1–C2 + D1–D4.
- **Do not** headline "beats propAMMs", "cheap updates", or "open keepers" until
  the evidence or the code catches up.
- **Repo hygiene is part of the pitch:** the specs and audit are gitignored and
  two P1 docs are deleted in the working tree — fix before submission.
- **Effort to M1:** roughly 3–5 focused weeks for one engineer.
- **Definition of success:** a stranger can clone, run one command, and reproduce
  a defensible headline chart, with a live devnet loop and a working demo.
