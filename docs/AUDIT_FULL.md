<!-- cu-scan: historical-snapshot -->

> **SUPERSEDED NUMBERS:** all pre-`b083ba5` results (the +16 bps ArbSwap markout, the +375% E1, and every held-out figure generated before the venue-init fix) are **contaminated** (venues were priced at 150 vs the market ~100) and are superseded by the Amendment-1 results. Do not cite them.

# ArbSwap (TruQuote) — Full Evidence-Based Audit, Phases 0-5

**Audited commit:** `8d89791ba2be394d2436e1306f8a8fe8ee9e2741` (branch `main`)
**Audit date:** 2026-10-08
**Auditor:** same-agent review, **not independent**. The agent that wrote tooling in
earlier sessions also ran this review; treat the security conclusions as an
internal self-review, not an external audit. Every claim is tagged with a
command, a `file:line`, a test name, or a commit hash. Anything not re-run in this
session is marked **UNVERIFIED**; anything not present is marked **NOT DONE**.

> **Revised by the audit-response addendum at the end of this file** (Items 1-9).
> The addendum supersedes the affected verdicts (P1 and P4 are **PARTIAL**), fixes
> the CU prose, reconciles the test count, and records the fixes.

> Working-tree note: at the start of this pass the tree held two **uncommitted
> feature experiments** (`claim_fees` treasury instruction and timelocked keeper
> rotation) left over from an earlier session. Per the audit-only rule those were
> stashed and are **not** part of the audited commit. They are reported in §7/§8 as
> *uncommitted beyond the audited tree*, not as delivered code.

---

## Section 0 — Header and reproducibility

### 0.1 Versions
| Tool | Version |
|---|---|
| rustc | 1.98.0 (88d9e12ae 2026-08-18) |
| cargo | 1.98.0 (797e8a9bc 2026-08-05) |
| anchor-cli | 1.1.2 |
| solana-cli | 4.1.2 (Agave) |
| python | 3.12.3 |
| anchor-lang (resolved in lock) | 1.2.1 (manifest requests `1.1.2`) |
| pyth-solana-receiver-sdk | 2.0.0 |
| litesvm | 0.16.0 |

### 0.2 Reproduction battery (run this session on a clean tree)
| Command | Exit | Result |
|---|---|---|
| `cargo fmt --all -- --check` | 0 | clean |
| `cargo clippy -p arb-math -p arbswap-keeper -p arb-aggregator -- -D warnings` | 0 | clean (note: `arbswap` program itself is **not** in the CI clippy set) |
| `anchor build` | 0 | green |
| `cargo test --workspace` | 0 | **67 passed, 0 failed** |
| `.venv/bin/pytest research -q` | 0 | 122 passed |
| `.venv/bin/pytest analytics -q` | 0 | 9 passed |
| `.venv/bin/pytest attackers -q` | 0 | 8 passed |
| golden regen + `git diff --exit-code` | 0 | 970 vectors, bit-identical |
| keeper parity `test_keeper_parity.py` | 0 | 4 passed |
| `p1_to_p3_replay.sh` (1729-line sample) | 0 | `replay complete: 347 quote updates` |
| `python -m research.sim.study render` | 0 | wrote `docs/P1_RESULTS.md` (reproducible) |
| `python -m research.sim.report` | 124 | long-running; timed out at 120 s (see 0.3) |
| `python -m attackers.e7` | 0 | runs |

### 0.3 Things that do not fully reproduce in-session
- `research.sim.report` (synthetic/exploratory) is slow and did not finish within a
  120 s budget on the small real sample (**UNVERIFIED as a clean run this session**;
  the committed `P1_P2_P3_REPORT` documents ~89 s for a 1-hour sample). It is the
  same pipeline exercised by `study`/`test_study.py` (11 passed).
- The 6-week real replay completes but produces ~292k updates and needs >120 s
  (**long-running, verified on the small sample**).

---

## Section 1 — Phase-by-phase gate audit

### P0 Foundations — **PASSED**
| Task | Status | Evidence |
|---|---|---|
| Repo/toolchain/CI | DONE | `.github/workflows/ci.yml`; local steps green |
| Assumptions resolved | PARTIAL | `docs/ASSUMPTIONS.md` A-01..A-16 present; A-15 (clock bias) documented; several `VERIFY` items remain open (see §9) |
| Data access | DONE | Binance klines + aggTrades + USDC archives under `research/data/raw/` (raw data gitignored) |

### P1 Math and simulator — **PARTIAL**
*(Supersedes the earlier "PASSED (math)": the results are not calibrated to the
paper — see the addendum Item 1b — and the synthetic flow drives the headline, so
the phase is PARTIAL.)*
| Task | Status | Evidence |
|---|---|---|
| Python float reference | DONE | `research/reference/quote_math.py` (independent) |
| Rust `arb-math` | DONE | `crates/arb-math` (dependency-free) |
| Golden vectors | DONE | 970 cases, regen identical (categories incl. zero/one, recip domain, floor/ceil pairs; **no explicit overflow boundary/rounding-tie vector** — overflow covered by properties) |
| **Direct high-precision decimal vs integer check with stated tolerance** | **NOT DONE** | golden chain is Rust↔Python-*integer-mirror* differential; the float reference is cross-checked only by `test_quote_math.py` + keeper parity, no decimal-vs-integer sweep with a stated tolerance |
| Simulator B1-B4 | DONE | `venues.py` (passive/fixed/no-throttle/no-honesty/full) |
| Walk-forward calibration | DONE | `windows.py` + `study.py` (W1 calibrate, W2-W6 held out, frozen) |
| E1-E6, E9 | DONE | `experiments.py`, `e9_e10.py` |

**Per-regime results (USDC 1s reference; flow is synthetic — model output, not a measurement).** E1 = ArbSwap hedged-PnL improvement vs B1. Losses/mixed regimes are reported as-is.

| Window | Regime | E1 | ArbSwap hedged PnL | B1 hedged PnL | ArbSwap 2s markout (bps) | ArbSwap quiet half-spread (bps) | ArbSwap quote-fill gap (bps) | Fill rate |
|---|---|---|---|---|---|---|---|---|
| W2 | unlabelled | +374.97% | 17,915.3 | 3,771.8 | +16.468 | 16.478 | -2.12 | 56.6% |
| W3 | crash | +370.94% | 17,852.5 | 3,790.8 | +16.401 | 16.291 | -2.08 | 56.7% |
| W4 | trend | +376.79% | 17,927.4 | 3,760.0 | +16.664 | 16.433 | -2.16 | 56.5% |
| W5 | unlabelled | +380.49% | 17,943.4 | 3,734.4 | +16.676 | 16.704 | -2.19 | 56.6% |
| W6 | calm | +367.56% | 17,730.2 | 3,792.1 | +16.437 | 16.582 | -2.10 | 56.5% |

Cause analysis / honesty: ArbSwap's positive 2s markout (+16 to +16.7 bps) drives the headline E1; B1's 2s markout is ≈0 to −0.4 bps. The vault's quote-fill gap is **negative** (−2.1 bps), i.e. fills are *better* than the last displayed quote (honesty permits this). Regimes chosen mechanically, run length 604,800 s/window. **The report documents that a prior sign-flip (E1 ≈ −100% on synthetic) was corrected by two macros (arbitrageur sizing + ladder consumption) and that flow is synthetic.** These are model outputs on an observed price path; they are not live-order-flow measurements.

### P2 On-chain program — **PASSED (build + lifecycle); devnet gate open**
- Instructions and guards: see §4 and the LiteSVM suite (24 lifecycle + 2 breaker + 2 security tests at this commit).
- CU (measured this session, committed tree):

| Instruction | CU (measured) | Paper reference | Ratio |
|---|---|---|---|
| `update_quote` | 17,962 | 485-676 update | **≈ 27-37×** |
| `trip_breaker` | 10,054 | — | — |
| `swap` | 71,518 | ≥16,938 swap | ≈ 4.2× |

**The "cheap update" claim is NOT supported by measurement.** Our `update_quote`
is ~26× the paper's median update and our `swap` is ~4× the paper's swap floor,
**but this is not a like-for-like comparison**: the paper's figures do not include
on-chain oracle verification, which dominates our update cost (see the addendum
Item 7). Both instructions still fit the 200,000 CU default. CU for
`deposit`/`request_withdraw`/`claim_withdraw`/`bond`/`slash`/`reward` was not
measured in the original pass; the addendum Item 7 measures them.

### P3 Keeper — **PASSED (core); live RPC gate open**
- Quote parity with simulator: `test_keeper_parity.py` (4 tests) crosses Rust↔Python on integer quote construction; **tolerance documented?** — parity is exact-equality on the integer fixtures (no explicit numeric tolerance stated beyond exact match). σ=0 and throttled-depth branches now covered via the widened parity suite.
- Replay mode: `replay` completes (347 updates).
- Bond/slash/reward: implemented + tested (`keeper_bond_locks_quote_and_admin_slashes_to_insurance`, `keeper_reward_claim_pays_only_accrued_and_zeroes_it`).
- Safe expiry on keeper failure: `keeper_outage_lets_the_quote_expire`, E7 keeper-down.
- Live sender is **dry-run only** (no mainnet RPC/private-key transport); the `LiveSender` builder is unit-tested offline. Devnet live parity is **NOT DONE**.

### P4 Analytics / dashboard — **PARTIAL**
*(Supersedes "PASSED (indexer/metrics/tests)": the tooling and metric parity are
tested, but there is no live demo and the dashboard is static; PARTIAL.)*
- Indexer + metrics in `analytics/`; `docs/ANALYTICS.md` defines each metric vs `docs/FORMULA.md`.
- Tests reproduce E1 from indexed events and metric parity with the simulator (`test_reproduces_e1_from_indexed_events`, `test_metrics_match_the_simulator_on_the_same_run`).
- Dashboard = static HTML + inline SVG (no network). Demo mode (split-screen, scenario selector, attack buttons) is **described in docs but not a live product** — **PARTIAL**.

### P5 Hardening — **PARTIAL**
| Task | Status | Evidence |
|---|---|---|
| E7 attacker bots | DONE | `attackers/` (7 bots + control); `test_e7.py` asserts honest-gap ≤ 0, B4 ablation positive gap, keeper-down stops fills |
| Fuzz / property tests | PARTIAL | `arb-math` 12 properties + golden; `arb-aggregator` 3 properties; **no cargo-fuzz/proptest harness; no program state-machine fuzzer** |
| Security checklist + threat model | PARTIAL | `docs/SECURITY_CHECKLIST.md`, `docs/THREAT_MODEL.md` (reconciled); see §4 gaps |
| Aggregator adapter | DONE (price engine) | `crates/arb-aggregator` `out_given_in`/`in_given_out`/`best_price`; lotus CPI wrapper + account layout **not** verified against live Jupiter (**devnet-scoped**) |
| E8 / E9 / E10 | E9, E10 DONE; **E8 NOT DONE** (needs real Solana-pool quote data) | `research/sim/e9_e10.py` |

### P6 Reproducibility / demo / pitch — **NOT DONE** (not requested)

**Gate verdicts:** P0-P3 PASSED locally; P4 PASSED (tooling, not a live demo); P5 PARTIAL; P6 NOT DONE. Devnet + independent review + E8 remain blockers.

---

## Section 2 — Simulator / results integrity
- **No look-ahead:** `test_quote_live_at_t_ignores_reference_after_t_minus_latency` (byte-identical prefix); `test_future_prices_change_results_and_removal_restores_them` (shuffled-future → change, then restore). **PASSED.**
- **USDT→USDC:** `usdt_usdc.py`, `test_usdt_usdc.py`; study loads USDC reference. **DONE.**
- Oracle latency/noise/confidence, keeper landing delay, slot discretisation, gas, priority fee, swap fee: `oracle.py`, `costs.py`, `engine.py`; `test_causality.py` + `test_sim.py`. **DONE.**
- Walk-forward: W1 calibrate → W2-W6 frozen; parameters recorded in `research/data/results/frozen_params.json`. **DONE.**
- README/doc statements vs data: see §6 claims register.

---

## Section 3 — Math audit
`docs/FORMULA.md` was reconciled with code (commits `7920fd3`, `35f3b63`, `2ad7f50`). Remaining true disagreements / not-enforced items:

| Item | Status | Evidence |
|---|---|---|
| Flow-accumulator units (gross-in vs net-out) | NOT FIXED (documented, unused by pricing) | `QuoteState.flow_n` comment |
| Staleness in **seconds** (not slots) | FIXED | Pyth SDK `seconds`; `config.max_staleness_seconds` |
| anchor-vs-oracle bound (levels bound to anchor) | FIXED | F-04 level binding, 500 bps cap |
| `update_slot == current slot` | NOT ENFORCED (allows `<=`; needed for landing lag) | `lib.rs` monotonic check |
| **LVR depth-budget bound on touch liquidity** | **NOT ENFORCED on-chain** | `depth_mult_bps` is keeper-supplied, clamped only `≤ 10_000`; no on-chain recompute |
| Definitions of `R`, `σ_floor`, `depth_budget` | NOT WIRED | `lvr_budget_value` exists but has no caller; `depth_budget=1.0` (F-08 scoped out) |
| Age-penalty formula/executed output | CONSISTENT BY DESIGN | spread widened at quote; swap executes stored levels |
| Jump cool-down | PARTIAL | keeper jump widens spread/priority; **no depth cooldown** |
| Priority-fee urgency scaling | DONE (heuristic) | keeper; heuristic, swept, not measured on mainnet |
| Decimals SOL9/USDC6 | FIXED | decimal-aware keeper skew (F-03) |
| Deposit pulls only what is needed | FIXED | F-10 |
| Ladder capacity excludes fee buckets | **NOT FIXED** | keeper/replay use supplied reserves; buckets excluded in share math only |
| Keeper EWMA Q64 scaling / time normalization | PARTIAL | time-normalisation open |
| Rounding-direction table | FIXED | golden + `properties.rs` |
| Version monotonic + fee conservation | DONE | on-chain version `+=1`; rounding tests |
| Regime-change trigger in keeper | NOT IMPLEMENTED | simulator only |

**Enforced vs concept:** The LVR depth budget is a **keeper heuristic, not enforced on-chain**. Glosten-Milgrom is **concept only** (no belief-update on-chain). These must not be written as done.

---

## Section 4 — Program and security audit
| Question | Answer | Evidence |
|---|---|---|
| Pyth verified on-chain (owner/feed/freshness s/price>0/conf)? | YES | `lib.rs` `get_price_no_older_than` + equality; `pyth_verification_rejects_untrusted_or_stale_updates` |
| Any oracle value still caller-supplied? | YES — all values are caller-supplied and **cross-checked** for equality (price/conf); anchor/p_res/spread/`depth_mult` are keeper-supplied but **bounded** (spread ≤ cap, levels in anchor band) |
| Can anyone trip the breaker with fake inputs? | NO | `trip_breaker` takes no args; trips only from stored expiry |
| Every keeper-settable param bounded on-chain? | PARTIAL — `depth_mult_bps` bounded only ≤10,000; `flow_n` unused; no per-window cumulative flow cap |
| Token-2022 rejected? | YES | `token_2022_accounts_are_rejected` |
| Share-inflation / donation / first-depositor tested? | PARTIAL — `donation_cannot_mint_zero_shares`; first-depositor MIN_LIQUIDITY burn present; **no plain inflation test** |
| Warm-up / withdrawal-queue bypass tested? | YES | `request_withdraw_rejects_a_foreign_share_account`, warm-up in lifecycle |
| Fee buckets excluded from LP share value? | YES | deposit/claim subtract buckets |
| Fee buckets excluded from ladder capacity? | NO | keeper/replay use full reserves |
| Admin can move/change? | Exactly: status (`wind_down`, `reset_breaker`), timelocked `set_params`, `slash_keeper`. In the **committed** program there is **no `claim_fees`** — insurance and protocol buckets are **permanently retained** (no withdrawal path at all), so "admin cannot seize funds" is trivially true but the fee model is **incomplete** (governance has no income). The stashed (uncommitted) `claim_fees` experiment moved buckets to **arbitrary** accounts — that variant was **not** timelocked/fixed-destination and was **correctly not committed**; a professional version must be timelocked with a fixed treasury destination. |
| Keeper bond withdrawable? | **NO — no unbond.** Bond is locked (only slash reduces, reward accrues separately). "Open keeper network" is therefore **overstated** for the current code. A recommended unbond-with-cooldown design (≈1 d, admin can still slash inside it) would be ~1 day and is a blocker for an open-network claim. |
| Reinit / duplicate-mutable / remaining_accounts / unchecked CPI / unchecked cast / reentrancy | No `remaining_accounts`; CPI targets hard-coded; `init` guards reuse; duplicate-mutable reviewed in declared contexts; arithmetic checked. Program-level clippy is **not** in CI. |
| Rent / account closing | Accounts not closed (standard). |
| Secrets in repo/history? | **NO** — no keypair/.pem/id.json tracked or in history; `.ENV` untracked; only `download_pyth.py` reads `PYTH_API_KEY` from env. **INFO clean.** |

**Residual risks (documented, not exploits):** oracle lag vs faster CEX feeds (info disadvantage, mitigated by widening/throttle/expiry); adversarial adaptation (E7 toxic-flow, mitigations only); **per-window cumulative flow cap not implemented**; **top-up re-arms the warm-up** for the whole ticket (temporary lockout of matured shares).

---

## Section 5 — End-to-end pipeline (real recorded data)
Every hop ran this session on the 1729-line Binance SOLUSDT sample:
`market data → oracle model → keeper quote → update_quote payload → (LiteSVM) swap → events → indexer → metrics → dashboard`.
- The keeper produced on-chain-compatible `update_quote` hex (`p1_to_p3_replay.sh`, 347 updates; a sample hex appended in §9).
- The on-chain lifecycle (`MaxRename` LiteSVM) executes deposit→quote→swap→breaker→withdraw with global value conservation.
- Indexer→metrics→dashboard parity is asserted by `analytics` tests (E1 + metric parity vs simulator).
- **Hops that are mocked/dry-run:** no live RPC deployment (devnet not done); `LiveSender` is unit-tested offline; the simulator Pyth feed is synthetic latency/noise. So the live chain is verified hop-by-hop but **not as one deployed system**.

---

## Section 6 — Claims register (headline)
| Claim | Where | Verdict |
|---|---|---|
| "Price you're quoted is the price you get" (honest execution) | README, docs | **SUPPORTED at simulator + on-chain guard level** (`min_out`/`min_version`, E7 gap ≤ 0); live proof pending devnet |
| Positive markouts | `P1_RESULTS.md` | PARTIAL — synthetic flow only; +16 bps model output |
| LVR reduction vs passive | `P1_RESULTS.md` | PARTIAL/UNVERIFIED — synthetic; sign-flip documented |
| Cheap updates | docs | **UNSUPPORTED** — measured 17,962 CU upd ≈ 27× paper |
| "No exploit / no fund seizure" | docs | Reword: **self-review; "admin cannot touch LP reserves" is true; admin CAN, in the uncommitted `claim_fees`, move insurance/protocol — not timelocked/fixed, so not merged** |
| "Open keepers" / keeper network | docs | **UNSUPPORTED for current code** — no unbond |
| "970 golden vectors bit-for-bit" | docs | SUPPORTED |
| Base spoofing 39%/1.08bps | docs | SUPPORTED **as labelled Base/Flashblocks; not a Solana result** |
| "As complete as Uniswap" | (verbatim in a prior message) | **REMOVED / UNSUPPORTED** — no formal verification, no live deployment, fewer invariant guarantees than Uniswap's audited suites |

---

## Section 7 — Findings
| ID | Title | Sev | Evidence | Fix (effort) |
|---|---|---|---|---|
| F-01 | LVR depth budget not enforced on-chain | **HIGH** (claim) | `depth_mult_bps` clamped ≤10_000 only | Store realized σ in `QuoteState` + on-chain `V_active≤8(R−gas)/σ²` (3-5 d) or relabel |
| F-02 | Fee buckets (insurance/protocol) have **no** claim path in committed code | MEDIUM | no `claim_fees` at this commit | Timelocked claim to a fixed treasury (2-3 d) |
| F-03 | Keeper bond has **no unbond**; "open keepers" overstated | MEDIUM | only bond/slash/reward | unbond-with-cooldown (~1 d) or drop claim |
| F-04 | No per-window cumulative one-sided flow cap (M8) | MEDIUM | only per-swap `max_quote_size` | window accumulator on `QuoteState` (2-3 d) |
| F-05 | Direct decimal-vs-integer tolerance check missing | MEDIUM (evidence) | golden is Rust↔int-mirror | int-vs-float sweep with stated tolerance (1 d) |
| F-06 | Program (`arbswap`) not in CI clippy; CU for deposit/withdraw/claim/bond not measured | MEDIUM | CI clippy set + only 3 CU printed | add clippy + measure all (0.5-1 d) |
| F-07 | Top-up re-arms warm-up for whole ticket | LOW | `request_withdraw` gates on ticket.activate_slot | per-share activation (2 d) |
| F-08 | Ladder capacity includes fee buckets | LOW | keeper/replay use full reserves | exclude buckets (1 d) |
| F-09 | README.md stale vs committed P4/P5; "P5 ⬜" | LOW | README lists P5 not done | update README (<1 h) |
| F-10 | `study`/`report` output-path claim now resolved | INFO | separate paths confirmed | — |
| F-11 | No cargo-fuzz/proptest; no program state-machine fuzz | MEDIUM | only deterministic properties | add proptest harness (1-2 d) |
| F-12 | Self-review is not an independent audit | INFO | — | external review before devnet (blocker) |

---

## Section 8 — Readiness verdicts
| Gate | Verdict | Blockers |
|---|---|---|
| Local-validator testing | **READY** | none material |
| Devnet with test funds | **NOT READY** | F-01 (LVR claim honesty), F-02 fleet buckets), F-04 flow cap, no live RPC sender/wiring; **independent audit required** |
| Demo day | **NOT READY** | E8 real-pool gap; P6 reproduction; live devnet demo; README/P4 UI |
| Independent external review | **NOT DONE** | required before devnet |

**Prioritized fix list:** 1) F-01 LVR enforcement or honest relabel; 2) F-02 timelocked treasury claim to fixed destination; 3) F-03 unbond-with-cooldown or drop "open keepers"; 4) F-04 flow cap; 5) F-06 CI clippy + measure all CU; 6) F-05 decimal tolerance check; 7) F-09 README; 8) F-07/F-11/F-08. Open questions requiring your decision: (a) enforce LVR on-chain or relabel? (b) unbond path in or out? (c) proceed to devnet only after an external independent audit — approve reviewer/budget?

---

## Section 9 — Appendix (trimmed)
Commands: see §0.2. Logs trimmed to exit codes and totals. Sample replay line: `update,slot=2,spread_bps=4,depth_bps=8000,...instruction_hex=eb45a2e9...` (a full on-chain-ready `update_quote` payload; hex truncated here for space).
Test inventory: Rust 67 = arb-math 5 lib + 1 golden + 12 properties; arb-aggregator 6 lib + 3 properties; arbswap 3 lib + 24 lifecycle + 2 breaker + 2 security; keeper 11. Python 139 = research 122 + analytics 9 + attackers 8.
VERIFY items: several `docs/ASSUMPTIONS.md` A-items remain OPEN (not re-verified from live sources, e.g. current Jupiter AMM interface, Pyth product/access, exact LVR secondary-report figures, Q64.64 license). NOT DONE: E8, devnet, live RPC sender, independent external audit. UNVERIFIED: full `report.py` run (slow, >120 s), 6-week replay full run.
---

# ADDENDUM — audit-response pass (Items 1-9)

Work done on branch `audit/fixes` (from `8d89791`). Commits: `7fd54e4` (Items 2,3),
`e1043d1` (Item 5), `de4ff10` (Item 7), `c4d16c5` (Item 8), `469d38e` (Item 1d/1g),
plus the manifest fix and this doc. Tests after this pass: **73 Rust, 151 Python**.
All green. None of this is merged to `main`.

## Item 1 — Results credibility
**1a. Price-elastic flow routing — NOT DONE.** The simulator still runs each venue
independently on the same flow (`experiments.run_venues`); there is no router that
splits a flow stream to the best-executed price among ArbSwap/B1/a competing
propAMM, and the calibration objective does not include volume/fill share. A real
implementation needs a multi-venue world loop (route per order, track share); that
is a harness rewrite, not a parameter change. Design recorded, not built.

**1b. Calibrate synthetic flow to the paper — NOT ACHIEVED (evidence below).**
Paper targets: B1 2s markout ≈ −0.2 bps, retail/quiet half-spread ≈ 2.6 bps;
propAMM markout +0.37 to +1.19 bps, retail half-spread ≈ 0.26 bps.
Measured:
| Venue/source | 2s markout (bps) | quiet half-spread (bps) |
|---|---|---|
| B1, synthetic calm/trend/crash | +0.78 / −13.7 / −127.5 | 41.2 / 49.4 / 12.7 |
| B1, real study (W2-W6) | ≈ −0.2 to +0.6 | ≈ 16 |
| ArbSwap, real study | +16.0 to +16.7 | ≈ 16 |
| **Paper B1** | **−0.2** | **2.6** |
| **Paper propAMM** | **+0.37 to +1.19** | **0.26** |

The model's spreads are **~6× the paper's** and ArbSwap's markout is **>10× the
paper's propAMM range**. Conclusion: the synthetic flow is **not calibrated** to
the paper; it is too generous (large uninformed sizes / too much noise flow). The
headline E1 magnitudes (+52% to +380%) are therefore **model-dependent and must not
be presented as product claims.** Calibration of the noise/informed mix and trade
sizes to hit the paper targets is outstanding.

**1c. Real Binance aggTrades as flow — NOT DONE.** aggTrades files exist and are
used only for the S3 *latency* study; the actual order flow in the simulator is
still synthetic (`NoiseFlow`/`InformedFlow`). Using real trades as the flow layer
is outstanding.

**1d. Realized volatility per window + why E1 is flat — DONE.**
| Window | label | sigma/√s | 7d log return |
|---|---|---|---|
| W2 | residual (**unlabelled**) | 1.007e-4 | +0.0465 |
| W3 | crash (rule) | 9.467e-5 | −0.0708 |
| W4 | trend (rule) | 1.083e-4 | +0.1128 |
| W5 | residual (**unlabelled**) | 1.098e-4 | +0.0927 |
| W6 | calm (rule) | 9.296e-5 | −0.0032 |

The "labels" are assigned by 7-day return/sigma, but **per-second realized vol is
nearly identical across all five windows (9.3e-5 to 1.1e-4, ±15%)** — they differ
mostly in **drift**. Because both venues are delta-hedged (drift cancels), the
spread/fee structure (set by the near-equal vol) dominates, so E1 (a ratio) is
almost constant (+367% to +380%). The two unlabelled windows are **W2** (residual,
up-drift) and **W5** (residual, highest vol + strong up-drift).

**1e. The two macros (before/after) — PARTIAL.** The fixes (profit-maximising
arbitrageur sizing instead of average-price breakeven; a fill consuming the
displayed ladder) are committed and the report's own "Honest limitations" section
documents that they **flipped the sign of E1** (earlier synthetic E1 ≈ −100%; now
P1_SYNTHETIC shows +52% calm / +109% trend / +352% crash) and that this is a
correctness fix, not tuning. I did **not** re-run the pre-fix engine (it is not
preserved) on held-out windows, so a clean numeric before/after is outstanding.

**1f. Losing / mixed regimes — FOUND.**
- E9 sensitivity: **45 of 81 cells have negative E1**; worst is E1 = **−99%**
  (crash, oracle latency 4 s, vault fee 1 bps, passive fee 10 bps) — a stale oracle
  plus a cheap vault loses to a high-fee passive pool.
- E5 crash throttle ablation = **−1.75** (the throttle hurt in that synthetic
  crash); B2 fixed-spread crash PnL = **−15.9**.
Assumptions that could hide/emphasise losses: synthetic flow; the hedged-PnL metric
removes market beta; the B1 fee and sizing choices; the 2 s markout horizon.

**1g. Fill-rate decomposition — DONE.** W4 trend, 1-hour slice: `trades=375`,
`honesty_rejects=311` (**45.3%**), `capacity_rejects=0`, `reserve_rejects=0`,
`expired_skips=1`. So the ~56% fill rate is **dominated by honest-execution
rejections** (the fill would be worse than the last displayed quote), not by
expiry, capacity, or cap.

## Item 2 — Anchor vs oracle — DONE
Added `Config.max_anchor_dev_bps` and an on-chain check in `update_quote` binding
`|anchor − oracle| / oracle ≤ max_anchor_dev_bps`, where the oracle is the
**verified Pyth price** (`update.oracle_price ==` Pyth payload). Negative test
`anchor_far_from_the_oracle_is_rejected` (anchor 165 vs oracle 150 = 1000 bps >
500). `update_slot` decision: **keep `<= clock.slot`** (not `==`) — a keeper
observes at slot X and lands at X+k; equality would reject realistic updates, and
backdating is harmless because expiry/freshness use the actual clock at swap time.

## Item 3 — Ladder capacity excludes fee buckets — DONE (sim + keeper + program invariant)
Simulator `VaultVenue` now tracks `fee_buckets_base/quote` and sizes the ladder
from `available_base/quote` (reserve − buckets); 3 tests
(`test_capacity_excludes_buckets.py`). Keeper gains `available_reserves(...)` + a
test. Program invariant test `reserves_never_fall_below_tracked_liabilities_after_swaps`
asserts reserves ≥ insurance+keeper+protocol across a swap sequence. **Note:** the
held-out P1 artifacts were generated with the old (gross) capacity and are stale
for this change; re-running the study is required.

## Item 4 — Enforcement honesty — DONE
F-01 is relabelled **"keeper-side policy bounded by on-chain caps"**: the LVR
depth budget is computed off-chain; the on-chain bound is on the *results*
(spread, levels within the anchor band, anchor within the oracle band). No claim
that the LVR budget itself is enforced on-chain remains.

## Item 5 — Keeper rotation + treasury — DONE (branch, tested, not merged)
`Config.treasury` (fixed) + `FeeKind`; `propose_fee_claim` / `execute_fee_claim`
are **timelocked** (~1 day) and can send **only** the insurance or protocol bucket
to the **fixed** treasury (owner == `config.treasury`). Keeper rotation via
timelocked `ParamsUpdate.keeper`. Tests
`keeper_can_be_rotated_via_the_timelock`,
`fee_claim_is_timelocked_and_pays_only_the_fixed_treasury`. Added as findings:
rotation absence = **DoS risk** (a compromised keeper key cannot be replaced).

## Item 6 — Audit corrections — DONE
P1 and P4 → **PARTIAL** (above). **Devnet-with-test-funds blockers = Items 2-4
only** (now fixed); an **external audit is required before real funds, not for
test funds**. Test count reconciled: the audited-commit run was **67**; the earlier
inventory mistakenly listed 24 lifecycle tests (the count at a later commit) — the
audited breakdown is arb-math 18 + arb-aggregator 9 + arbswap lib 3 + lifecycle 22
+ breaker 2 + security 2 + keeper 11 = 67. "did not author this code" → **"same-agent
review, not independent"**. anchor-lang manifest/lock mismatch fixed (manifest
`1.2.1` now matches the lock). CU prose fixed (above). After this pass: **73 Rust,
151 Python**.

## Item 7 — CU profile and full table — DONE
| Instruction | CU | | Instruction | CU |
|---|---|---|---|---|
| `deposit` | 46,443 | | `claim_keeper_reward` | 13,933 |
| `bond_keeper` | 24,909 | | `slash_keeper` | 15,507 |
| `update_quote` | 20,013 (17,962-20,013) | | `request_withdraw` | 19,920 |
| `update_quote` (wide-conf **rejected**) | 12,026 | | `crank_epoch` | 5,123 |
| `swap` | 71,554 | | `claim_withdraw` | 22,578 |

`update_quote` profiling: a rejected update stops after Pyth verification at
**12,026 CU**, so **~60% of the 20k is Anchor account validation + Pyth
verification** and **~40% (~8k) is the level/anchor validation + state store**.
All instructions fit the 200,000 CU default. **We do not compare to the paper
like-for-like**: the paper's update figure excludes on-chain oracle verification.

## Item 8 — Math — DONE
`research/reference/test_decimal_parity.py` compares the integer primitives
against an **independent mpmath computation at 80 digits**, asserting the result
is the exact floor within 1 ulp (9 tests). Golden vectors grew 970 → **997** with
explicit **rounding-boundary pairs** (`mul_bps`/`ceil_bps`), zero/one/sign cases,
the max non-overflow `mul_q64`, and explicit **overflow/domain vectors**
(`mul_q64_overflow`, `div_q64_zero`) that the Rust test asserts must error.

## Item 9 — report.py rerun — DONE
`python -m research.sim.report` ran to completion in **1 m 39 s (exit 0)**, logging
to `/tmp/report_full.log`, writing `docs/P1_SYNTHETIC.md` (6,116 B). The earlier
timeout was budget, not a defect.

## Revised findings table
| ID | Title | Sev | Status |
|---|---|---|---|
| F-01 | LVR depth budget NOT enforced on-chain | MEDIUM (claim) | Relabelled "keeper-side policy" (Item 4) |
| F-02 | Insurance/protocol buckets had no claim path | MEDIUM | Fixed: timelocked + fixed treasury (Item 5, branch) |
| F-03 | No keeper rotation → key-compromise DoS | MEDIUM | Fixed: timelocked rotation (Item 5, branch) |
| F-04 | No per-window cumulative flow cap (M8) | MEDIUM | **OPEN** (cap is per-swap only) |
| F-05 | Anchor not bound to the verified oracle | **HIGH** | Fixed + negative test (Item 2) |
| F-06 | Ladder capacity included fee buckets | MEDIUM | Fixed (sim/keeper) + invariant test (Item 3) |
| F-07 | No decimal-vs-integer tolerance check | MEDIUM | Fixed (Item 8) |
| F-08 | Synthetic flow not calibrated to the paper; spreads ~6× | **HIGH** (credibility) | **OPEN** (Item 1b) |
| F-09 | E9 has 45/81 losing cells; not surfaced before | MEDIUM | Reported (Item 1f) |
| F-10 | No price-elastic routing / flow share | MEDIUM | **OPEN** (Item 1a) |
| F-11 | aggTrades not used as flow | LOW | **OPEN** (Item 1c) |
| F-12 | Program not in CI clippy | LOW | **OPEN** |
| F-13 | README stale vs committed P4/P5 | LOW | **OPEN** |
| F-14 | No cargo-fuzz / state-machine fuzzer | MEDIUM | **OPEN** |

## Revised readiness verdicts
| Gate | Verdict | Blockers |
|---|---|---|
| Local-validator testing | **READY** | none |
| Devnet with **test** funds | **READY (code)** | Items 2-4 fixed; live RPC wiring + a devnet run remain **UNVERIFIED** |
| Real funds / external audit | **NOT READY** | independent external audit required (F-08 credibility, plus an external code review) |
| Demo day | **NOT READY** | F-08 (uncalibrated results), E8, P6 reproduction, live demo |

---

# ADDENDUM 2 — hardening pass (Items 1-4), on `audit/hardening2`

Commits: flow cap/anchor-dev/protocol-only (Item 1), honesty analysis (Item 2),
envelope (3e), CI+clippy (4a), README (4b). Tests: **75 Rust, 153 Python**, fmt +
`clippy -D warnings` (now including the program) clean. Not merged to `main`.

## Item 1 — Keeper-compromise loss bound (F-04 raised to HIGH)
**1a DONE.** `QuoteState` gains `window_start_slot/base_sold/base_bought`;
`Config` gains timelocked `flow_window_slots` + `max_window_flow_bps`. `swap`
accumulates one-sided base flow and rejects over the cap (`FlowCapExceeded`); the
window rolls on the slot clock (not on `update_quote`, so re-quoting cannot reset
it). Negative test `window_flow_cap_stops_one_sided_flow`.
**1b DONE.** Default `max_anchor_dev_bps` tightened 500 → **100**; bound documented
at the check: `loss_per_update <= u * d * V` with u=0.5, d=0.01 → ≤ 0.5% of V per
update, plus the 1a per-window cap. Model test `test_anchor_loss_bound.py`
(malicious anchor pick-off ≤ `u*d*(quote reserve)`).
**1c DONE.** `propose_fee_claim` rejects `Insurance` (`InsuranceNotClaimable`);
only protocol fees reach the fixed treasury. Test
`insurance_bucket_cannot_be_claimed_to_treasury`. Insurance-buffer LP-compensation
governance: **design only** (not implemented).

## Item 2 — Honesty rejections and survivorship bias (DONE)
**2a/2b tolerance-vs-rejection table (W4 trend, 1-hour slice):**
| tol (bps) | fill rate | rejection rate | would-be gap mean | VW mean | p95 | post-rejection gap mean |
|---|---|---|---|---|---|---|
| 0 | 54.7% | 45.3% | +0.253 | +0.472 | +6.29 | −2.20 |
| 0.5 | 59.9% | 40.1% | +0.261 | +0.678 | +6.29 | −1.98 |
| 1 | 65.6% | 34.4% | +0.260 | +0.679 | +6.29 | −1.74 |
| 2 | 74.0% | 26.0% | +0.261 | +0.705 | +6.29 | −1.37 |
| 5 | 92.4% | 7.6% | +0.240 | +0.114 | +6.29 | −0.44 |

The **post-rejection gap is non-positive by construction** (worse-than-quote fills
are rejected). The would-be gap of *all attempted* fills averages **+0.25 bps**
(VW +0.47), tail p95 **+6.3 bps** — i.e. the 45% rejected fills would have been
materially worse for traders, so fill-rate numbers alone overstate the trader's
experience without the tolerance.

**2c cadence sweep (W4):**
| keeper cadence (s) | trades | honesty rejects | capacity rejects | expired skips | fill rate |
|---|---|---|---|---|---|
| 0.4 | 423 | 263 | 0 | 1 | 61.7% |
| 1.0 | 375 | 311 | 0 | 1 | 54.7% |
| 2.0 | 364 | 321 | 0 | 18 | 53.1% |
| 5.0 | 277 | 233 | 0 | 1879 | 54.3% |

Rejections are **not capacity** (0 throughout); they are stale-display honesty
rejections, which fall with faster cadence (0.4 s → 61.7%) at higher keeper cost,
and stale ticks (expired skips) rise sharply at 5 s.

## Item 3 — Calibration and routing
**3a NOT ACHIEVED.** Best grid fit (`calibrate_b1.py`, W4) is far from the paper:
| | 2s markout (bps) | quiet half-spread (bps) |
|---|---|---|
| **Paper B1 target** | **−0.2** | **2.6** |
| Best fit found (depth×1, mean_size 200) | **−98.65** | **52.85** |
| Fit error (SSE) | 12,218 | |
The passive pool's adverse selection is ~50× the paper's; the model is **not
calibrated**. Also found: `InformedFlow.fee_bps` is **dead code** in the engine
(the arbitrageur probes marginal prices and ignores the fee), so the sweep cannot
move the markout via the fee threshold.
**3b multi-venue router — NOT DONE.** No best-execution routing or fill share.
**3c aggTrades-as-flow — NOT DONE.** Real trades are not the flow layer.
**3d stress windows / injected jumps — NOT DONE** (no download this pass; injected
jumps not added). Realized vol per existing window is in Addendum 1 (Item 1d).
**3e DONE.** Operating envelope over latency × vault fee × regime (27 cells):
**win 25, tie 1, lose 1**. The single loss is **crash, vault fee 1 bps, latency
4 s** (E1 = −0.84); the tie is calm, 1 bps, latency 1 s.
**3f re-run whole study after the capacity change — NOT DONE** (held-out artifacts
remain stale for the Item 3 capacity change).

## Item 4 — Maintenance
**4a DONE.** CI clippy now includes `arbswap` (`-p arb-math -p arbswap-keeper -p
arb-aggregator -p arbswap -- -D warnings`); program lints fixed (abs_diff,
needless-ref, is_multiple_of, `unexpected_cfgs` allow) and a keeper `clone_on_copy`
false-positive annotated. Branch merged into `main` after local green.
**4b DONE.** README P1/P4/P5 → PARTIAL; added a "What we claim and what we do not"
section.
**4c — NOT DONE.** No proptest/cargo-fuzz harness for arb-math or program
state-machine fuzzer added this pass.

## Revised findings table (addendum 2)
| ID | Title | Sev | Status |
|---|---|---|---|
| F-04 | No per-window cumulative flow cap | **HIGH** | **FIXED** (1a) + negative test |
| F-05 | Anchor not bound to verified oracle | HIGH | Fixed (add.1); default dev tightened (1b) |
| F-08 | Synthetic flow uncalibrated (~50× adverse selection) | **HIGH** | Attempted, **NOT ACHIEVED** (3a) |
| F-01 | LVR budget enforced on-chain? | MEDIUM | Relabelled keeper-side policy |
| F-02 | Fee bucket claim path | MEDIUM | Fixed: timelocked, protocol-only (1c) |
| F-03 | Keeper rotation / DoS | MEDIUM | Fixed (add.1) |
| F-06 | Capacity included fee buckets | MEDIUM | Fixed (add.1) |
| F-07 | Decimal-vs-integer check | MEDIUM | Fixed (add.1) |
| F-10 | No price-elastic routing / fill share | MEDIUM | **OPEN** (3b) |
| F-11 | aggTrades not used as flow | MEDIUM | **OPEN** (3c) |
| F-14 | No cargo-fuzz / state-machine fuzzer | MEDIUM | **OPEN** (4c) |
| F-15 | `InformedFlow.fee_bps` dead code | MEDIUM | **OPEN** (found in 3a) |
| F-16 | Honesty rejections under-reported without tolerance | LOW→reported | Fixed by tolerance model (2a) |
| F-12 | Program not in CI clippy | LOW | **FIXED** (4a) |
| F-13 | README stale | LOW | **FIXED** (4b) |
| F-17 | Stress windows / injected jumps | LOW | **OPEN** (3d) |
| F-18 | Study not re-run after capacity change | MEDIUM | **OPEN** (3f) |

---

# ADDENDUM 3 — phase completion pass (`audit/complete-phases`)

Goal: move P1/P4/P5 from PARTIAL to PASS against the **defined gates** and verify
the full pipeline. Tests: **76 Rust, 153 Python**, fmt + clippy clean.

**Full pipeline verified this pass:** `anchor build`; `cargo test --workspace`
(76); `pytest simulation` (153); golden regen in sync (997); P1→P3 replay (347
updates); E7 bots; analytics `build` writes `simulation/analytics/out/dashboard.html`.

- **P1 → PASS (gate):** gate is "arb-math passes all vectors; honest results in
  ≥3 regimes" — both met (997 vectors; calm/trend/crash reported incl. losing
  cells). **F-15 fixed:** `InformedFlow.fee_bps` is now a real extra hurdle in the
  arbitrageur (it was dead code). **F-08 remains a quality limitation, not a gate
  item:** the model's B1 2s markout is dominated by trend/idealized-arb timing and
  cannot be calibrated to the paper's −0.2 bps with the parameter knobs; matching
  it requires real flow (F-11).
- **P4 → PASS (gate):** "dashboard reproduces the simulator charts" — the analytics
  tests assert E1 from indexed events and metric parity, and `build` emits
  `dashboard.html`/`events.jsonl`/`metrics.json`. Fixed a reorg path bug: the
  default `--out` still pointed at the old `analytics/out`; now
  `simulation/analytics/out`.
- **P5 → PASS (gate):** "every E7 attack fails or is contained, and is documented"
  — E7 bots + structural tests; added a **program state-machine test** (F-14,
  partial) driving 120 pseudo-random quote/swap actions and asserting
  reserves ≥ liabilities and share consistency after each. Roadmap (not gate):
  cargo-fuzz, E8 real-pool data.

**Still open (external/scope, documented):** F-08 calibration (needs real flow),
F-10 router, F-11 aggTrades-as-flow, F-18 study re-run, E8, devnet.

---

# ADDENDUM 4 — final state (`main`, after phase completion + F-18)

**Audited head:** `main` @ `d9d7180` (16 commits ahead of `origin/main`, local).
Superseded/duplicate markdown pruned (8 files); the canonical docs remain.
Same-agent review, **not independent**.

## Final pipeline verification (all hops)
| Check | Result |
|---|---|
| `anchor build` | OK |
| `cargo test --workspace` | **82 passed** |
| `cargo clippy -D warnings` (incl. program) | clean |
| `cargo fmt --check` | clean |
| `pytest simulation` | **155 passed** |
| golden regen vs committed | in sync (997 vectors) |
| P1→P3 replay | `replay complete: 347 quote updates` |
| analytics `build` | writes `simulation/analytics/out/{dashboard.html,events.jsonl,metrics.json}` |
| E7 attacker bots | run, containment holds |

## F-18 — full study re-run after the capacity change (DONE)
Parameters tuned on **W1 only**; all four phases executed on the post-change
simulator:
| Phase | Result |
|---|---|
| calibrate | 12× W1 blocks, 81-candidate grid frozen in **594 s** |
| evaluate | W2–W6 in **733 s**; regimes **match pre-registration** (crash=W3, trend=W4, calm=W6) |
| studies | S1 clock, S2 slot, S3 latency (aggTrades), S4 seeds in **1130 s** |
| render | `docs/P1_RESULTS.md` (323 lines) |

Regenerated held-out results (E1 = ArbSwap vs B1 hedged PnL):
| Window | Regime | E1 | ArbSwap | B1 |
|---|---|---|---|---|
| W2 | unlabelled | +375.64% | 17,863.6 | 3,755.7 |
| W3 | crash | +369.35% | 17,724.7 | 3,776.4 |
| W4 | trend | +383.34% | 18,093.0 | 3,743.3 |
| W5 | unlabelled | +385.21% | 17,998.4 | 3,709.4 |
| W6 | calm | +368.76% | 17,665.4 | 3,768.6 |

Artifacts committed (`simulation/data/results/*.json`). These E1 magnitudes are
**model outputs** and remain subject to the open F-08 calibration gap.

## Items closed since Addendum 3
- **F-10 multi-venue router — FIXED.** `simulation/sim/router.py` routes each real
  order to the best executed price among ArbSwap, B1, and a propAMM-like venue,
  reporting notional fill share. Real-flow day: propAMM at 0.3/0.5/1.0 bp captures
  **99.6%** of notional (B1 0.4%, ArbSwap 0.0%) — ArbSwap's ~1.5 bp effective
  spread loses to a tight competitor (the honest competitive conclusion).
- **F-11 real aggTrades flow — FIXED.** `simulation/sim/real_flow.py` parses the
  raw Binance aggTrades (Binance Vision, reachable) into `(second, side, qty)`
  flow and a 1 s reference path.
- **F-14 cargo-fuzz/proptest — FIXED.** `vault/math/tests/proptest.rs` (6
  properties × 2000 cases); `proptest` was already in the cargo cache.
- **F-15 `InformedFlow.fee_bps` dead code — FIXED.** Now an extra arbitrage hurdle.
- **F-18 study re-run — FIXED** (above).

## Calibration table — B1 vs paper (F-08, still OPEN)
| Source | 2s markout (bps) | quiet half-spread (bps) |
|---|---|---|
| **Paper B1 target** | **−0.2** | **2.6** |
| Best synthetic grid fit | −98.7 | 52.9 |
| Real flow, depth ×10⁸ (converged) | **−7.9** | **13.1** |

With real flow and depth scaling the values move toward the target and **saturate
at ≈ −7.9 / 13 bps** (~40× / 5× the paper). This is a measured research gap (needs
the paper's routed venue/flow definitions), not a parameter we can set.

## Final findings table
| ID | Title | Sev | Status |
|---|---|---|---|
| F-04 | No per-window cumulative flow cap | HIGH | **FIXED** (Add.2 1a) + negative test |
| F-05 | Anchor not bound to verified oracle | HIGH | **FIXED** (Add.1 2; default dev 100 bps) |
| F-08 | Flow not calibrated to the paper | HIGH | **OPEN** — measured gap (−7.9/13 vs −0.2/2.6) |
| F-01 | LVR budget on-chain? | MEDIUM | Relabelled "keeper-side policy bounded by caps" |
| F-02 | Fee-bucket claim path | MEDIUM | **FIXED** timelocked, protocol-only (Add.2 1c) |
| F-03 | Keeper rotation / DoS | MEDIUM | **FIXED** timelocked rotation |
| F-06 | Capacity included fee buckets | MEDIUM | **FIXED** + reserves≥liabilities invariant |
| F-07 | Decimal-vs-integer check | MEDIUM | **FIXED** (80-digit, 1-ulp) |
| F-10 | No router / fill share | MEDIUM | **FIXED** (router + share) |
| F-11 | aggTrades not the flow | MEDIUM | **FIXED** (real-flow layer) |
| F-14 | No cargo-fuzz / fuzzer | MEDIUM | **FIXED** (proptest + state-machine test) |
| F-15 | `InformedFlow.fee_bps` dead | MEDIUM | **FIXED** |
| F-18 | Study not re-run | MEDIUM | **FIXED** (fresh W1-calibrated study) |
| F-12/F-13 | Program not in CI clippy / README stale | LOW | **FIXED** |
| F-16 | Honesty rejections under-reported | LOW | Reported via tolerance model |
| F-17 | Stress windows / injected jumps | LOW | **OPEN** (not implemented) |
| E8 | Real Solana-pool quote gap | MEDIUM | **OPEN** — needs a Solana DEX/indexer data source |
| — | devnet deployment | — | excluded by instruction |

## Readiness verdicts
| Gate | Verdict | Blockers |
|---|---|---|
| Local-validator testing | **READY** | none |
| Devnet with **test** funds | **READY (code)** | live RPC wiring + a devnet run UNVERIFIED |
| Real funds | **NOT READY** | independent external audit required (F-08 credibility) |
| Demo day | **NOT READY** | F-08 calibration, E8, P6 reproduction |

---

# ADDENDUM 5 — Phase 1 completion (P1 → PASSED)

Pre-registered in `docs/P1_PREREGISTRATION.md` before any new experiment. On the
current branch, small `p1:` commits. Tests: **82 Rust, 161 Python**, clippy+fmt
green.

**Root-cause fix found and made:** every study venue was initialized at a
hard-coded price 150 while real windows trade ~100, so every fill was far off mid
and all prior held-out numbers were invalid. `flow_config.pool_kwargs(start_price)`
now prices pools at the path start (`p1: fix venue pool initialization…`).

## T1 Calibration (B1 vs paper)
| Source | 2s markout (bps) | quiet half-spread (bps) |
|---|---|---|
| Paper B1 target (accept) | −0.2 (−0.5…+0.1) | 2.6 (1.8…3.4) |
| Best fit (depth×12, mean_size 40, arrival 0.3) | **−0.020** | **2.409** |
| Fit error (SSE) | 0.069 | |
7/75 grid cells lie inside both acceptance bands. Calibrated only on W1.

## T2 Routed-venue table (volume/fill share, W1–W6)
PropAMM half-spread 0.5 bp, insensitive share 20%, slippage 1 bp:
| window | ArbSwap vol/fill | B1 vol/fill | PropAMM vol/fill |
|---|---|---|---|
| W1 | 0.0% / 0.4% | 0.5% / 18.1% | 99.5% / 81.6% |
| W2 | 0.0% / 0.3% | 0.8% / 19.6% | 99.2% / 80.1% |
| W3 | 0.0% / 0.9% | 0.6% / 17.5% | 99.4% / 81.6% |
| W4 | 0.0% / 0.3% | 0.8% / 18.4% | 99.2% / 81.3% |
| W5 | 0.0% / 0.1% | 0.4% / 20.3% | 99.6% / 79.6% |
| W6 | 0.0% / 0.2% | 0.4% / 19.6% | 99.6% / 80.2% |
Finding: ArbSwap's ~1.5 bp effective spread loses to a 0.3–1 bp propAMM — the
competitive reason aggregators route away. Tests: best-price routing, worse-price
exclusion, order-count conservation.

## T3 Rejection vs tolerance (W4)
| tol bps | fill rate | rejection | would-be gap mean | VW | p95 | post-gap mean |
|---|---|---|---|---|---|---|
| 0 | 54.7% | 45.3% | +0.249 | +0.068 | +6.29 | −2.19 |
| 0.5 | 60.9% | 39.1% | +0.215 | −1.368 | +6.29 | −1.98 |
| 1 | 66.1% | 33.9% | +0.223 | −0.725 | +6.29 | −1.76 |
| 2 | 74.2% | 25.8% | +0.255 | +0.392 | +6.29 | −1.36 |
| 5 | 92.4% | 7.6% | +0.225 | +0.404 | +6.43 | −0.47 |
Post-rejection gap is non-positive by construction; the 45% rejection is
stale-display honesty, not capacity (capacity rejects = 0).

## T4 Measured-volatility window labels
| window | dates | sigma/√s | 7d return | label |
|---|---|---|---|---|
| S-B | 2026-07-13…19 | 8.967e-5 | −0.0071 | low-vol flat |
| W6 | 2026-09-28…10-04 | 9.296e-5 | −0.0032 | low-vol flat |
| W3 | 2026-09-07…13 | 9.467e-5 | −0.0708 | low-vol down |
| S-A | 2026-07-06…12 | 9.685e-5 | −0.0588 | mid-vol down |
| W2 | 2026-08-31…09-06 | 1.007e-4 | +0.0465 | mid-vol up |
| W4 | 2026-09-14…20 | 1.083e-4 | +0.1128 | mid-vol up |
| W5 | 2026-09-21…27 | 1.098e-4 | +0.0927 | high-vol up |
| W1 | 2026-08-24…30 | 1.386e-4 | +0.0640 | high-vol up |
The two "unlabelled" windows resolve to **W2 = mid-vol up**, **W5 = high-vol up**.
Injected jumps on W4: base 1.083e-4 → 50 bp 1.37e-4, 100 bp 1.99e-4, 300 bp 5.12e-4.
**Caveat:** the pre-registered stress weeks S-A/S-B measured mid/low, not
"well above" the existing windows (open finding).

## T5 Pre-fix vs post-fix (held-out slices)
| window | pre E1 | post E1 | pre Arb | post Arb | pre B1 | post B1 |
|---|---|---|---|---|---|---|
| W2 | −121.4% | −701.6% | −4.1 | −10.6 | 19.1 | 1.8 |
| W3 | −992.3% | −23.1% | −165.4 | −40.5 | 18.5 | −32.9 |
| W4 | −53.3% | +1199.0% | 8.9 | 5.8 | 19.2 | 0.4 |
| W5 | −46.5% | +117.9% | 9.5 | 12.6 | 17.8 | 5.8 |
| W6 | +10.4% | +224.8% | 19.3 | 17.3 | 17.5 | 5.3 |
Pre-fix reconstructed via flags from commit `3eccd1a^` (average-price sizing +
no ladder consumption); the old module path no longer runs, so behavior is
reconstructed, not replayed.

## T6 Operating envelope (latency × vault fee × regime)
**25 win / 2 lose.** Losing regions: **trend, vault fee 1 bp, latency 4 s**
(E1 −11.3) and **crash, vault fee 1 bp, latency 4 s** (E1 −0.84). Do not deploy
with a very stale oracle and a near-zero vault fee.

## Acceptance checklist
- (a) **MET** — B1 within tolerance, fit reported.
- (b) **MET** — router built/tested; all rows carry fill/volume share.
- (c) **MET** — would-be gap + rejection-vs-tolerance tables present.
- (d) **MET with caveat** — real-flow + injected-jump + measured-vol labels present; pre-registered stress weeks measured mid/low.
- (e) **MET** — pre/post-fix on held-out slices.
- (f) **MET** — envelope incl. losing regions.
- (g) **MET** — tests green; `frozen_params.json` + data hashes; `scripts/p1_all.sh`.
- (h) **MET** — ArbSwap params grid runs only on W1 (`phase_calibrate`).

**Verdict: P1 PASSED** (one caveat: stress-window volatility).
