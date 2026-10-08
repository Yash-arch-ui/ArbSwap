# LEFTOVER TASKS — making the IDEA true (not just the code compile)

## 0. The intent (from MasterPlan §1-2, §7, §15; BuilderPlan §2-3, §15)

TruQuote is **"an AMM + propAMM hybrid"**: take the *open pooled capital* of an
AMM and the *active, volatility-aware quoting* of a propAMM, run it like a
professional desk (risk limits, breakers, audited accounting, bonded keepers),
with one promise: **"the price you are quoted is the price you get."**

What the project must SHOW (the win map / demo):
1. **LVR chart** — passive pools lose to arbitrage; TruQuote loses less.
2. **Reprice-first** — on a jump, the passive pool is picked off, TruQuote reprices.
3. **Markout curves** — passive negative, TruQuote positive.
4. **Quote-vs-fill ≈ 0** — honest execution.
5. **Crash** — depth throttle + breaker keep LPs safe.
6. **Working devnet loop + keeper + dashboard demo mode** (Definition of Done).

Success metrics (BuilderPlan §2.5): LVR lower than passive; 2s markout positive;
hedged return > passive; quote-vs-fill ≈ 0; quiet half-spread ≤ passive; CU/update
"under ~1,000 (verify)".

## 1. Reality check (what is true today)

| Intent element | Status | Why |
|---|---|---|
| Open pooled capital (AMM) | **CODE OK** | pro-rata vault, warm-up, epoch queue, LP-share accounting, tested |
| Active quoting (propAMM) | **CODE OK, VALUE UNPROVEN** | keeper computes a ladder; but the *advantage* over passive is not demonstrated |
| Honest execution | **CODE OK** | `min_out`/`min_version`; post-rejection gap ≤ 0 by construction |
| Bounded keeper / safe failure / fair accounting | **CODE OK** | Pyth verify, anchor↔oracle + level bounds, expiry, breaker, flow cap |
| LVR lower than passive (E1) | **NOT SHOWN** | results were contaminated (venue init bug); model not calibrated on both sides |
| Positive markout (E2) | **NOT SHOWN** | positive number is a synthetic model artifact; competing propAMM is unprofitable (contradicts paper) |
| Hedged return > passive (E3) | **NOT SHOWN** | same |
| Quote-vs-fill ≈ 0 (E8/Solmaz) | **PARTIAL** | on-chain yes; measured on real Solana pools: NOT DONE |
| Quiet half-spread ≤ passive | **NOT SHOWN** | ArbSwap ~5 bps vs B1 ~2.5 bps in the corrected slice |
| CU/update "cheap" | **FALSE** | 17,962 CU vs paper's 485-676; target <1,000 not met |
| Working devnet loop + keeper | **NOT DONE** | keeper sender is dry-run; no devnet deploy |
| Dashboard demo mode | **NOT DONE** | static HTML + mock Vite UI; no split-screen replay/attack buttons |
| E1-E10 one command | **PARTIAL** | study runs; E8 missing; not one command for all |

**Blunt version:** the program is a correct, guarded, tested *execution engine*
for a keeper's bounded ladder. But the **central claim — that open, active,
honest quoting beats a passive pool and is competitive with propAMMs — is not
demonstrated**, and there is no live loop or demo. The idea is not yet satisfied.

## 2. Why it isn't satisfying the idea (root causes)

1. **No credible benchmark.** Only B1 (passive) was calibrated to the paper; the
   competing propAMM in the model is *unprofitable* (negative markout), whereas
   real propAMMs are profitable (+0.37…+1.19 bps). So we cannot yet say anything
   about propAMM-competitiveness.
2. **No real-flow validation of ArbSwap.** Flow is synthetic; the real aggTrades
   layer exists but ArbSwap was never run/validated on it.
3. **The "active" advantage is assumed, not measured.** There is no experiment
   that isolates *active repricing* from *just having a spread* (the throttle
   ablation exists but the LVR budget is not enforced).
4. **No live path.** Keeper is dry-run; no devnet; no Pyth streaming; no
   aggregator route.
5. **No demo.** The thing judges see (split-screen replay, attack buttons) does
   not exist.

## 3. Leftover tasks and workflow code (ordered)

### Track A — PROVE THE VALUE (research; blocks the whole pitch)
- **A1 Calibrate BOTH sides.** Calibrate the competing propAMM to the paper
  (+0.37…+1.19 bps markout, ~0.26 bps retail half-spread) so the benchmark is
  credible; keep B1 calibrated (done). Acceptance: both venues within paper bands
  on W1; held-out reported.
- **A2 Real-flow validation.** Run every venue on real Binance aggTrades flow;
  report side by side with synthetic. Acceptance: ArbSwap markout/LVR on real
  flow, with CIs.
- **A3 Demonstrate E1/E2/E3 with the calibrated, real-flow model.** Show LVR
  reduction, positive markout, hedged return > passive — **and the losing
  regimes** (operating envelope). Acceptance: E1/E2/E3 tables incl. losses.
- **A4 LVR vs propAMM.** Measure LVR reduction versus the calibrated propAMM
  (not just passive). Acceptance: E1 vs propAMM.
- **A5 Honest-execution metric.** Quote-vs-fill on our venue AND on real Solana
  pools (E8) if data can be sourced. Acceptance: gap distribution.
- **A6 LVR depth rule.** Either enforce `V_active ≤ 8(R−gas)/σ²` on-chain (store
  realized σ in `QuoteState`) or model it faithfully; show the E5 ablation.
  Acceptance: throttle demonstrably cuts LVR in the model.

### Track B — MAKE IT REAL (on-chain + keeper + devnet)
- **B1 Live keeper.** Real Pyth client + RPC transport + keypair signing (the
  `LiveSender` exists; wire it). Acceptance: keeper posts quotes on devnet.
- **B2 Devnet deploy.** `scripts/devnet_deploy.sh` + full deposit→quote→swap→
  withdraw loop on devnet. Acceptance: deployed program id + a swap tx.
- **B3 (optional) Open keeper network.** `unbond_keeper` with cool-down so the
  "open keepers" claim is true. Acceptance: bond in/out test.

### Track C — DEMO (what judges actually see)
- **C1 Dashboard demo mode.** Split-screen passive-vs-ArbSwap replay, scenario
  selector (calm/trend/crash), attack buttons (freeze oracle, kill keeper, launch
  attacker bot). Acceptance: deterministic cached replay renders.
- **C2 One-command E1-E10** (add E8/E10 to `scripts/p1_all.sh`). Acceptance: one
  command reproduces every headline chart.
- **C3 3-minute video + live script + backup recording.**

### Track D — SUBMISSION
- **D1 README one-command reproduce**; **D2 methodology doc + deck**;
  **D3 deployed addresses**; **D4 E8 data source** (Solana DEX/indexer).

## 4. Recommended workflow (sequence)

1. A1 (credible propAMM benchmark) → A2 (real flow) → A3/A4 (value + losses).
   **Gate:** ArbSwap beats passive on hedged PnL in ≥3 regimes on real flow, with
   a calibrated propAMM shown for context. If it cannot, the honest pitch becomes
   "open + honest execution", not "better than propAMMs".
2. B1 → B2 (live keeper + devnet). **Gate:** a devnet swap executes at the quoted
   price.
3. A6 (depth rule) → A5 (E8 if data) → C2 (one-command E1-E10).
4. C1 (demo mode) → C3 (video).
5. D1-D3 (submission).

## 5. Open questions that decide the pitch

- Can ArbSwap's spread/depth policy actually beat a *profitable* propAMM in any
  regime, or only a passive pool? (A1/A3/A4)
- Is the CU target (<1,000/update) achievable, or must we drop the "cheap update"
  claim? (currently 17,962)
- Is E8 (real Solana-pool quote gaps) sourceable for the demo?

## 6. Acceptance for "idea fulfilled"

- Live devnet loop with a keeper (B1/B2).
- Calibrated passive **and** propAMM benchmarks on real flow; E1/E2/E3/E4/E5
  reproduced by one command, with losing regimes shown (A1-A6, C2).
- Dashboard demo mode with a deterministic cached replay and attack buttons (C1).
- Honest execution measured (on-chain + E8 if possible).
- Claims register updated so nothing unproven is headlined.
