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
| 5 | Bonded keepers / open participation | **PARTIAL** | `bond_keeper` + `unbond_keeper_cooldown_and_release`, `unbond_partial_and_full_release`, `slash_during_unbond_reduces_the_release`, `unbond_keeper_rejects_a_bond_from_another_vault` (`9817b21`) | the MVP still allowlists `config.keeper`; the bond is quote-token only |
| 6 | Two-sided quoting (bid + ask) | **SUPPORTED** | `keeper_two_sided_quote_executes_both_directions`, `two_sided_ladder_is_mirrored_at_zero_skew` (`fdc97c7`); Python parity ask+bid (`test_keeper_parity.py`) | the keeper emits both sides; on-chain stores both |
| 7 | Automatic realized-loss breaker | **SUPPORTED (on-chain + simulator)** | on-chain: `malicious_keeper_edge_loss_trips_within_the_window`, `honest_flow_does_not_trip_the_edge_breaker`, `deposits_and_withdrawals_do_not_move_the_edge_tracker` (`32f870c`); simulator trip-rate: `python -m simulation.sim.edge_breaker` (0 honest trips across W2–W6, 50/100/300 bps jumps, 0.2/1.0/4.0 s latency) | measures edge vs the **stored** oracle (spread ≥ 0), so it catches keeper mis-anchoring, **not** oracle-lag LVR; realized loss at a trip ≤ threshold + largest single-swap edge |
| 8 | Update/swap compute units (honest) | **SUPPORTED (measurement)** | `measure_instruction_compute_units`; `docs/SECURITY_CHECKLIST.md` §3 | `update_quote` ≈68k, `swap` ≈75k. **Not cheap.** The ≤40k target is not met (h2, `f1fbb8a`, waiting for approval) |
| 9 | Minimum half-spread = 2 bps | **SUPPORTED** | `a_zero_spread_quote_is_rejected` (`30e3b27`) | **by design not competitive with sub-bp propAMMs**; ArbSwap does not claim to win on raw price |
| 10 | LVR reduction / positive markout (the P1 value claim) | **SIMULATION ONLY — UNPROVEN** | `docs/P1_RESULTS.md` (model output; calibration gap F-08) | not a product result; not to be headlined |
| 11 | Devnet deployment / live keeper | **NOT CLAIMED** | — | no devnet deploy, no live RPC transport (P3 live is NOT DONE) |
| 12 | Independent audit | **NOT CLAIMED** | same-agent self-review | external audit required before real funds |
| 13 | Frontend dashboard / demo mode | **NOT CLAIMED** | — | not built |

## Commands

```bash
cargo test --workspace        # 125 Rust tests
.venv/bin/pytest simulation -q # 164 Python tests
anchor build                  # SBF program
```
