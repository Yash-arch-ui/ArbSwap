# P4_P5_AUDIT.md — Phases 4 & 5: idea target vs codebase

Audit against the idea documents: **Build Plan §9 (Analytics/dashboard) and §12
P4/P5**, and **Master Plan §4 (modules M13/M15–M19) and §11 P4/P5**.

---

## P4 — Analytics, fees, dashboard

### The idea's P4 (Build Plan §12 P4, §9; Master Plan §11 P4)

| Task | Target |
|---|---|
| T4.1 | Indexer **and database** (subscribe to logs, store with slot/time, reconcile with state) |
| T4.2 | Metrics engine: markouts, quiet flow, hedged PnL, quote-vs-fill gap, **attribution** |
| T4.3 | Dashboard views (LP/trader/risk/comparison) **and demo mode** (§9.2: split-screen replay, scenario selector, attack buttons, deterministic cached) |
| T4.4 | Reproduce E1–E4 charts from indexed data |
| **Gate** | dashboard reproduces the simulator charts on replayed data |

### Reality

| Task | Status | Evidence |
|---|---|---|
| T4.1 Indexer | **DONE** | `events.py` (Anchor-log parser) + `indexer.py` (in-memory) + **`store.py` (SQLite database)** + **`live.py` (live cluster poller, proven on devnet: indexed 8 `QuoteUpdated` events)** |
| T4.2 Metrics engine | **DONE** | `metrics.py` — markout curve, quiet half-spread, gap stats, hedged PnL, LVR (`σ²/8·V·T`), attribution (fees − gas − adverse selection). Tests: `test_metrics_match_the_simulator_on_the_same_run`, `test_attribution_decomposes_hedged_pnl`, `test_microprice_weights_by_opposite_depth` |
| T4.2 Fees / insurance buffer | **DONE (program-side)** | on-chain fee buckets (insurance/keeper/protocol) + `propose/execute_fee_claim`; analytics reports the split |
| T4.3 Views | **PARTIAL** | `dashboard.py` renders LP / trader / risk / comparison tables + inline-SVG charts (`charts.py`); test `test_dashboard_renders_every_view_with_charts` |
| T4.3 **Demo mode** | **DONE** | `demo.py` — **self-contained interactive HTML** (120 KB): split-screen B1-vs-ArbSwap charts, scenario selector (calm/trend/crash), attack buttons (freeze oracle / kill keeper / attacker bot), embedded fixed-seed data, deterministic + offline (0 external refs). Tests in `test_phase4.py` |
| T4.3 Frontend dApp | **NOT DONE (Stage 6, not P4)** | `frontend/` has no source. The idea's P4 §9.2 deliverable is the dashboard + demo mode (now done as a self-contained HTML); a separate Next.js dApp is Stage 6 scope |
| T4.4 E1–E4 from indexed data | **DONE (E1 + parity)** | `test_reproduces_e1_from_indexed_events`, `test_e1_reduction_and_lvr_theory`; metric parity with the simulator |
| **Gate** | **PASS (as defined)** | E1 reproduced from indexed events + metric parity on the same run |

### Verdict — P4: DONE (dashboard + demo mode)

Indexer **with a SQLite database** and a **live cluster poller** (proven on
devnet), metrics, attribution, the E1 reproduction gate, the LP/trader/risk/
comparison views, and an **interactive offline demo mode** are all implemented
and tested. The only remaining item is a separate Next.js dApp, which is
**Stage 6**, not P4 scope.

---

## P5 — Hardening and adversarial testing

### The idea's P5 (Build Plan §12 P5, §11; Master Plan §11 P5)

| Task | Target |
|---|---|
| T5.1 | Attacker bots; run E7 |
| T5.2 | Fuzzing and property tests; fix findings |
| T5.3 | Security checklist pass; threat model finalized |
| T5.4 | Aggregator adapter (verify Jupiter AMM-interface requirements) |
| T5.5 | E8 (real Solana pool gaps), E9 sensitivity, E10 cost |
| **Gate** | every E7 attack fails or is contained and documented |

### Reality

| Task | Status | Evidence |
|---|---|---|
| T5.1 Attacker bots | **DONE** | `simulation/attackers/scenarios.py`: `stale_feed`, `bad_tick`, `sandwich`, `phantom_liquidity`, `keeper_down`, `toxic_flow`, `oracle_update_sandwich` (+ `keeper_alive` control); `tests/test_e7.py` |
| T5.2 Fuzzing / property tests | **PARTIAL** | `vault/math/tests/proptest.rs` (6 properties × 2000 cases) + `properties.rs` + the S1 differential harness; program state-machine test `state_machine_full_action_set_preserves_invariants`; **no `cargo-fuzz`** target |
| T5.3 Security checklist | **DONE** | `docs/SECURITY_CHECKLIST.md` — account-binding table, 31-guard mutation table, per-instruction checks, CU table |
| T5.3 Threat model | **DONE** | `docs/THREAT_MODEL.md` — every threat maps to a mitigation + a test (E7 / LiteSVM), incl. T6 loss bound and H3 edge breaker |
| T5.4 Aggregator adapter | **DONE (pricing + parity + verified)** | `vault/aggregator` quote engine + 3 property tests; LiteSVM parity test `aggregator_quote_matches_onchain_swap` (test-kit pattern); interface verified + recorded (ASSUMPTIONS A-23). Full listing needs a Jupiter-side `Swap` variant (closed enum) |
| T5.5 E8 real Solana gaps | **PARTIAL** | real Jupiter-routed SOL/USDC quote via the live propAMM BisonFi (110.2525, impact ~0.0005%); full quote-vs-fill gap needs execution data — **not measured**, no competitor claim |
| T5.5 E9 sensitivity / E10 cost | **DONE** | `simulation/sim/e9_e10.py` (passive fee × vault fee × latency; CU per update/swap) |
| T5.5 Keeper bonds/slashing | **DONE** | on-chain `bond_keeper`/`slash_keeper`/`claim_keeper_reward`/`unbond_keeper` + tests |
| T5.5 Governance/timelock | **DONE** | `set_params`/`apply_params` timelock + tests |
| **Gate** | **PASS** | every E7 attack contained/documented (`tests/test_e7.py` + `THREAT_MODEL.md`) |

### Verdict — P5: PASS (gate)

The adversarial gate is met: 7 E7 bots + a control, all contained and mapped to
mitigations/tests; the security checklist and threat model are finalized.
Remaining gaps: **`cargo-fuzz`**, **E8 real-pool data**, and a **verified live
Jupiter aggregator parity test**.

---

## Summary

| Phase | Verdict | Done | Missing |
|---|---|---|---|
| **P4** | **DONE** | indexer + SQLite DB + live poller, metrics, attribution, E1 gate, views, **interactive demo mode** | Next.js dApp (Stage 6) |
| **P5** | **PASS (gate)** | 7 E7 bots + control, threat model, security checklist, aggregator pricing + parity, E9/E10, bonds/slashing, timelock, E8 partial (real quote) | `cargo-fuzz` (proptest substitute), E8 fill data, Jupiter `Swap` variant |

**Blunt version.** P5's *adversarial* gate is genuinely met and well documented.
P4's *analytics* are real (metrics/attribution/parity), but its **product half —
the demo mode and the frontend — is not built**, which is the same gap the earlier
`TARGETIDEATASKS.md` and `LEFTOVER_TASKS.md` flagged. A judge would see a static
table, not a split-screen replay with attack buttons.
