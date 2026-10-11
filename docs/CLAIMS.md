# CLAIMS.md — claims ledger

Every pitch claim, its status, the evidence, and its limits. Status values:

- **SUPPORTED** — backed by a named, passing test (or a pasted measurement).
- **SIMULATION ONLY** — a model output, not a product result.
- **NOT CLAIMED** — not demonstrated; do not put it in a pitch or README.

Operative security wording: **no known issues in self-review, independent audit
pending.** This is a same-agent review, not an audit.

**Banned wording everywhere** (README, docs, deck, comments): "exploit-free",
"audited", "safe", "cheap", "beats propAMMs", "as complete as Uniswap", and any
APY or return projection.

| # | Claim | Status | Evidence (test / command / commit) | Limits |
|---|---|---|---|---|
| 1 | Honest execution: executed output ≥ quoted | **SUPPORTED** | `swap_enforces_slippage_version_and_size`, `keeper_two_sided_quote_executes_both_directions`, `expired_quote_always_rejects_swap` (`fdc97c7`) | on-chain `min_out`/`min_version`; no live devnet proof |
| 2 | Bounded keeper (anchor/spread/capacity/flow/slot age) | **SUPPORTED** | `anchor_far_from_the_oracle_is_rejected`, `level_far_from_the_anchor_is_rejected`, `a_ladder_deeper_than_the_reserves_is_rejected`, `a_zero_spread_quote_is_rejected`, `window_flow_cap_stops_one_sided_flow`, `an_old_update_slot_is_rejected`; mutation table `docs/SECURITY_CHECKLIST.md` §2c | bounds only; not a profitability claim |
| 3 | Safe failure on keeper/oracle failure | **SUPPORTED** | `trip_breaker_on_expiry`, `trip_breaker_on_stored_staleness`, `no_trip_with_a_stale_foreign_account`, `rejected_wide_confidence_leaves_the_old_quote_to_expire`, `keeper_outage_lets_the_quote_expire` | breaker is state-only; admin reset only |
| 4 | Fair pro-rata accounting | **SUPPORTED** | `first_depositor_inflation_loses_at_most_rounding`, `sell_then_buy_same_size_never_creates_value`, `lifecycle_deposit_quote_swap_breaker_withdraw_preserves_value`, `account_spaces_match_serialized_sizes` | no ERC-4626 virtual-share offset; `MIN_LIQUIDITY` is a mitigation, not a proof |
| 5 | Bonded keepers (bond / unbond / slash) | **SUPPORTED** | `bond_keeper` + `unbond_keeper_cooldown_and_release`, `unbond_partial_and_full_release`, `slash_during_unbond_reduces_the_release`, `unbond_keeper_rejects_a_bond_from_another_vault` (`9817b21`) | the bond is quote-token only |
| 5b | Open bonded keeper network (permissionless when `min_bond > 0`) | **SUPPORTED (LiteSVM)** | `permissionless_bonded_keeper_may_quote_when_min_bond_is_set`, `update_quote_requires_a_keeper_bond`, `bond_keeper`/`unbond_keeper`/`slash_keeper`; mutation S4.4 | quoting is permissionless **once bonded**; the `min_bond == 0` MVP path stays allowlisted; no reward auction/competition schedule yet |
| 6 | Two-sided quoting (bid + ask) | **SUPPORTED** | `keeper_two_sided_quote_executes_both_directions`, `two_sided_ladder_is_mirrored_at_zero_skew` (`fdc97c7`); Python parity ask+bid (`test_keeper_parity.py`) | the keeper emits both sides; on-chain stores both |
| 7 | Automatic realized-loss breaker | **SUPPORTED (on-chain + simulator)** | on-chain: `malicious_keeper_edge_loss_trips_within_the_window`, `honest_flow_does_not_trip_the_edge_breaker`, `deposits_and_withdrawals_do_not_move_the_edge_tracker` (`32f870c`); simulator trip-rate: `python -m simulation.sim.edge_breaker` (0 honest trips across W2–W6, 50/100/300 bps jumps, 0.2/1.0/4.0 s latency) | **detects keeper mis-anchoring against the stored oracle; does NOT detect oracle-lag losses.** The zero honest trip count follows **partly by construction** (the honest keeper quotes around the same stored oracle, so every fill earns the spread, edge ≥ 0). Realized loss at a trip ≤ threshold + largest single-swap edge |
| 8 | Update/swap compute units (honest) | **SUPPORTED (measurement)** | `measure_instruction_compute_units`; `artifacts/public/cu.json`; `docs/SECURITY_CHECKLIST.md` §3 | `update_quote` **38,563**, `swap` **59,327** CU (LiteSVM, `cargo build-sbf`). The ≤40k target is not met. Updates are **not** low-cost vs the paper's 485–676 (not like-for-like: the paper excludes on-chain oracle verification) |
| 16 | Single-source-of-truth numbers | **SUPPORTED** | `scripts/export_artifacts.py` → `simulation/data/results/artifacts.json`; `scripts/check_docs_consistency.py` (CI) | docs regenerate from the bundle; provenance + superseded table in `docs/RESULTS.md` |
| 17 | "Beats passive pools" (Option 1) | **NOT CLAIMED** | `docs/THESIS.md` (pre-registered Amendment 3): T-A not shown | T-A.i real-flow CI not run; T-A.ii quiet half-spread worse than B1; no-propAMM niche share 27.9% only |
| 18 | Competitiveness vs tight propAMMs | **NOT CLAIMED** | `docs/THESIS.md` T-B: ArbSwap 0.0–0.7% routed share vs a propAMM-like 0.3–2.0 bps | the propAMM-like venue is a model, not a measured competitor |
| 9 | Minimum half-spread = 2 bps | **SUPPORTED** | `a_zero_spread_quote_is_rejected` (`30e3b27`) | **by design not competitive with sub-bp propAMMs**; ArbSwap does not claim to win on raw price |
| 10 | LVR reduction / positive markout (the P1 value claim) | **SIMULATION ONLY — UNPROVEN; headline is Option 2** | `docs/P1_RESULTS.md` (model output; calibration gap F-08); routed world (`python -m simulation.sim.router`) gives ArbSwap ~0% volume share vs a propAMM; `docs/HEADLINE.md` | not a product result; not to be headlined; Option 1 not shown, Option 3 never claimed |
| 11 | Devnet deployment + full money path | **SUPPORTED (devnet only)** | deploy + full lifecycle signatures in `docs/DEVNET.md` (deposit→update_quote→swap both sides→request/crank/claim); `docs/DEVNET.md` | devnet only, not mainnet; no real funds; IDL metadata write failed (client-convenience only) |
| 12 | Live keeper on devnet | **SUPPORTED (devnet only)** | `docs/DEVNET.md` §6 — live keeper ran 600 s, 29 `update_quote`, 0 failures; `docs/DEVNET.md` | low cadence, single allowlisted keeper; not a mainnet run |
| 13 | Independent audit | **NOT CLAIMED** | same-agent self-review | external audit required before real funds |
| 14 | Interactive demo mode / dashboard | **SUPPORTED (offline model output)** | `simulation/analytics/demo.py` + `test_phase4.py`; backup `docs/demo_backup.html` + `test_backup.py` | fixed-seed simulator replay, not live data; the separate `frontend/` dApp is NOT built |
| 15 | Headline chart reproducible from README | **SUPPORTED** | `simulation/sim/test_headline.py`; `./scripts/headline.sh` → `docs/headline_chart.svg` | model output; synthetic price-path fallback when raw data is absent |
| 16 | Keeper offline pre-validation (never sends a knowably-invalid quote) | **SUPPORTED (offline)** | `arbswap_keeper::prevalidate_quote`; 12 tests in `vault/keeper/src/lib.rs` (spread/anchor/inventory/capacity/slot/conf + failure injection) | offline only; live-devnet injection SKIPPED (no keypair) |
| 17 | Timelocked admin rotation | **SUPPORTED (LiteSVM)** | `propose_admin`/`accept_admin`/`cancel_admin`; `admin_rotation_*` tests; mutation S4.2 | successor must sign; Squads multisig is wallet-level (external) |
| 18 | F5 high-volatility real windows | **PASS (honest: T-A.i not met)** | `simulation/sim/real_flow_study.py`; 2026-02-06 (3.79×σ_ref) and 2026-01-31 (2.44×σ_ref) | model output; T-A.i CI above zero on 0/5 days |
| 19 | F4 retail spread diagnosis | **SUPPORTED (model output)** | `simulation/sim/diagnose.py` → `diagnosis.json`; dominant term volatility (~42%) | model output; router flaw fixed + regression |
| 20 | F4(d) coefficient re-choice | **CLOSED-BY-DECISION (mechanical)** | `simulation/sim/rechoice.py`; no candidate satisfies PnL≥0 ∧ quiet HS≤B1 → frozen params retained | decision rule applied; Option 1 unchanged |

## Commands

```bash
cargo test --workspace        # 157 Rust tests
.venv/bin/pytest simulation -q # 205 Python tests
anchor build                  # SBF program
./scripts/headline.sh         # headline chart (no data/keys)
```
