# Analytics and dashboard (P4)

Phase 4 implements Build Plan §9: an event indexer, an independent metrics
engine, and a static dashboard. The code lives in `analytics/`; the tests are
`analytics/tests/test_analytics.py`, wired into CI.

## 1. Indexer (§9.1)

The program emits events with `#[event]` (Build Plan §6.5). Each is logged as
`Program data: <base64>` = 8-byte Anchor discriminator
`sha256("event:" + Name)[:8]` followed by the Borsh payload.
`analytics/events.py` decodes them into typed records:

| Event (Rust struct) | Fields |
|---|---|
| `QuoteUpdated` | slot, version, anchor_sqrt_price, depth_mult_bps |
| `SwapEvent` | slot, version, side, amount_in, amount_out, fee |
| `DepositEvent` / `WithdrawRequested` / `WithdrawClaimed` | slot, shares, amounts |
| `BreakerTripped` / `BreakerReset` | slot |
| `ParamsProposed` / `ParamsApplied` | slot (+ activate_slot) |
| `ProgramInitialized` / `KeeperBonded` / `KeeperSlashed` / `RewardClaimed` | admin/keeper, amounts |

Two fields the metrics need are **not** on chain — the mid at fill and the
output the previous slot's quote implied. `analytics/indexer.py` reconciles them
(§9.1 "reconcile with account state periodically"): a live indexer reads
`QuoteState` at the swap slot; the simulator bridge supplies them directly.

## 2. Metrics engine (§8.3) with sources

`analytics/metrics.py` implements each metric from the specification,
independently of the simulator, so the integration tests are a genuine
cross-check.

| Metric | Formula | Source |
|---|---|---|
| Microprice | `(bid·q_ask + ask·q_bid)/(q_bid+q_ask)` | Solmaz et al., App. A.3 |
| Markout(τ) | `1e4·d·(m(t+τ)−p_exec)/p_exec`, `d=+1` if the venue bought base | Build Plan §8.3 |
| Quiet flow | fill with `|m(t+1s)−m(t−5s)|/m < 1 bps` | Build Plan §8.3 |
| Retail half-spread | notional-weighted `1e4·|p_exec−m(t)|/m(t)` on quiet fills | Build Plan §8.3 |
| Hedged PnL | `Σ_t [V_{t+1}−V_t − B_t·(P_{t+1}−P_t)]` | LVR decomposition (Milionis et al.) |
| LVR (theory) | `(σ²/8)·V·T` for constant product | Milionis et al., Example 3 |
| Quote-vs-fill gap | `1e4·(out_quoted−out_executed)/out_quoted`; mean, VW mean, identical share, p95 | 0x propAMM report (Base; not a Solana result until E8) |
| Attribution | `hedged = fees − gas − adverse_selection` | LVR decomposition |
| CU/update, CU/swap | from the program (SECURITY_CHECKLIST) | Build Plan §8.3 |

Hedged PnL is the microstructural alpha measure: it removes the vault's
directional base exposure, so raw LP PnL / impermanent loss is never headlined.

## 3. Dashboard (§9.2)

`analytics/dashboard.py` renders one self-contained HTML file with:

- **LP view** — hedged PnL and attribution (fees, gas, adverse selection);
- **trader view** — quiet-flow half-spread and the quote-versus-fill gap;
- **risk view** — quote version, breaker trips, last slot, keeper slashes;
- **comparison view** — the E2 markout curve and an E3 hedged-PnL bar chart,
  plus E1;
- **demo mode** — deterministic replay notes (scenario selector, attack flags).

Charts are inline SVG (`analytics/charts.py`), so the page needs no network and
is safe to cache for a demo.

## 4. Reproducing E1–E4

`python -m analytics build --scenario crash` runs ArbSwap and the passive
benchmark (B1) on the same price path, indexes the resulting events, and emits
the metrics and dashboard. The integration test
`test_reproduces_e1_from_indexed_events` asserts that E1 computed from the event
pipeline equals the simulator's own E1 on the same run, and
`test_metrics_match_the_simulator_on_the_same_run` checks markout(2s), quiet
half-spread, gap and hedged PnL against `research.sim.experiments.report`.

## 5. Limits

- The simulator bridge sets `fee = 0` on `SwapEvent` (the simulator does not
  record per-trade fees), so the attribution's fee column is a modelling input,
  not a measured one; a live indexer reads the fee from the swap instruction.
- E8 (real Solana-pool quote gaps) is not computed — the gap metric is reported
  for the replayed venue only, per the Build Plan's warning that the 0x figures
  are Base/Flashblocks.
