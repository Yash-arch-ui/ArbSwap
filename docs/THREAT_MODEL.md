# THREAT_MODEL.md (Phase 5)

Seed from Build Plan §11 (every threat needs a mitigation **and** a test).
Trust model: trusted = Solana runtime, Pyth program/feed (with checks), program
code; semi-trusted = keepers (bounded on-chain, bonded when configured);
untrusted = traders, LPs, other programs, RPC nodes. Admin = timelocked params +
pause-only kill switch (no fund seizure).

Tests named "on-chain" are LiteSVM tests in `programs/arbswap/tests`;
"E7" scenarios are `attackers/` driver over the verified simulator (T5.1).
`docs/P5_REPORT.md` records the run.

| Threat | How it hurts | Mitigation | Test |
|---|---|---|---|
| Stale or lagging oracle | Arbitrageurs pick off old quote | Staleness/confidence widening, breaker, quote expiry; Pyth freshness verified on-chain | E7 stale-feed + on-chain `pyth_verification_rejects_untrusted_or_stale_updates` |
| Oracle manipulation / bad print | Wrong anchor | Confidence bound, `max_anchor_step`, anchored-level binding (F-04), 500 bps outer cap | E7 bad-tick + on-chain `level_far_from_the_anchor_is_rejected`, `reservation_outside_the_inventory_band_is_rejected` |
| Breaker griefing via a stale foreign oracle | Anyone pauses the vault by supplying an old-but-valid price update | `trip_breaker` is **state-only**: no caller oracle; trips on stored expiry or stored staleness (`max_staleness × 2`) only | `no_trip_with_a_stale_foreign_account`, `trip_breaker_on_expiry`, `trip_breaker_on_stored_staleness` |
| Phantom ladder depth | Keeper quotes more depth than the vault holds | `update_quote` bounds `Σ capacity ≤ utilization_max × available reserves` (p2-T3) | `a_ladder_deeper_than_the_reserves_is_rejected`, `buckets_are_excluded_from_available_reserves` |
| Faster CEX feed than ours | Informational disadvantage | Directional add-on, depth throttle, spread floor | E9 latency sweep; E7 oracle-update sandwich |
| Sandwiching vault swaps | Trader or vault loses | `min_out`, `min_version`, size caps | E7 sandwich + on-chain `swap_enforces_slippage_version_and_size` |
| Keeper compromise / downtime | Bad or no updates | On-chain bounds, expiry stops fills, keeper bond/slash, multiple keepers | E7 keeper-down + on-chain `keeper_outage_lets_the_quote_expire`, `update_quote_requires_a_keeper_bond` |
| Share inflation / donation | Steals from later depositors | Pro-rata shares, MIN_LIQUIDITY burn, zero-share mint guard, rounding favors vault | on-chain `donation_cannot_mint_zero_shares`; arb-math property tests |
| Deposit/withdraw timing games | Phantom depth, run before volatility | Warm-up, epoch queue, reusable tickets | on-chain `second_deposit_reuses_the_ticket...`, E7 phantom-liquidity |
| Account/PDA confusion, missing checks | Funds drained | Anchor constraints, owner/signer/seed/mint checks, no unchecked CPI/remaining_accounts | on-chain `litesvm_security.rs`, lifecycle value-conservation |
| Arithmetic overflow / rounding leakage | Value leakage | Checked math, vault-favouring rounding | golden vectors (970), arb-math + arb-aggregator property/fuzz tests (T5.2) |
| Griefing (update/swap spam) | CU/DoS, wear | Update rate limits, reward only valid updates, `max_quote_size` | keeper `should_update` gating; E10 cost bound |
| Governance abuse | Param rug | Timelock (`set_params`→`apply_params`), config bounds, pause-only kill switch | on-chain `params_change_is_timelocked`, `admin_only_controls...` |
| Toxic flow adapts to public rules | Rules gamed | Minimal rules, spread floor, throttle, expiry | E7 adaptive toxic flow |
| Censoring proposer/builder | Updates suppressed → stale fills | Expiry stops fills, breakers, multiple keepers | E7 keeper-down; E7 stale-feed |
| Sandwich around oracle updates | Picks off quotes at update boundaries | Versioned quotes, `min_out`, size caps | E7 oracle-update sandwich |
| Routing through an aggregator | Worse-than-quoted fills reach traders | `out_given_in`/`in_given_out` enforce `min_out`; fees deterministic | `arb-aggregator` unit + property tests (T5.4) |
| Bond abuse (keeper) | Keeper posts no real stake | `min_bond` enforced in `update_quote`; slash to insurance | on-chain `keeper_bond_locks_quote_and_admin_slashes_to_insurance`, `claim_keeper_reward...` |

Solana-specific checklist (Build Plan §11): signer checks on every authority;
owner/address checks on every account incl. the Pyth account (correct program +
feed id); canonical PDA bumps; token accounts verified for mint/owner/program;
reject Token-2022 transfer-changing extensions; no reinitialization; closed
accounts zeroed; duplicate-mutable audit; hard-coded CPI program ids; checked
arithmetic; no unchecked `remaining_accounts`; indexer reconciles events with
state; admin cannot seize funds; keeper bounds enforced on-chain.