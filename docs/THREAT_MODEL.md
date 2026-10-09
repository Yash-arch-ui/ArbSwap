# THREAT_MODEL.md (Phase 5)

Seed from Build Plan §11 (every threat needs a mitigation **and** a test).
Trust model: trusted = Solana runtime, Pyth program/feed (with checks), program
code; semi-trusted = keepers (bounded on-chain, bonded when configured);
untrusted = traders, LPs, other programs, RPC nodes. Admin = timelocked params +
pause-only kill switch (no fund seizure).

Tests named "on-chain" are LiteSVM tests in `vault/program/tests`;
"E7" scenarios are `attackers/` driver over the verified simulator (T5.1).
The E7 driver is `simulation/attackers/e7.py`.

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

## T6 — Compromised-keeper worst-case loss bound

Let `u = utilization_max_bps`, `d = max_anchor_dev_bps`, `w = max_window_flow_bps`
(all in bps), `A_b`/`A_q` the available base/quote reserves (net of the fee
buckets) and `P` the oracle price. A keeper can never quote outside these
on-chain bounds, so the *worst case* is bounded by state the program controls:

```text
per update : loss_update <= (u/1e4) * (d/1e4) * V,   V = A_b*P + A_q
per window : one-sided base flow <= (w/1e4) * A_b
             loss_window <= (d/1e4) * P * min(flow, (w/1e4)*A_b)
per swap   : input <= max_quote_size   (size cap)
```

**Default numbers** (`u = 5_000`, `d = 100`, `w = 10_000`):
`loss_update <= 0.5% of V`; `loss_window <= 1% of the base-reserve value`.

**Measured** (`malicious_keeper_at_max_deviation_every_slot`, LiteSVM): vault
`A_b = 1e6`, `A_q = 1.5e8`, fee 1 bp, `u = 5_000`, `d = 100`, `w = 1_000`.
Per-update bound **1,500,000** quote; per-window bound **150,000** quote;
**measured loss 56,177** (one slot lands, the second is stopped by the flow
cap). The bound holds with margin.

**Recommendation on `max_anchor_dev_bps`.** The spec's original 500 bps is 100×
the spread floor (2–50 bps) and would allow a worst-case per-update loss of
`0.5 × 5% = 2.5% of V`; the audit already reduced the recommended default to
100 bps. A tighter **50 bps** is defensible: it bounds `loss_update` to 0.25% of
V while still covering oracle latency (a 2 s move at σ ≈ 1e-4/√s is ~1.4 bps)
and ordinary update gaps. **Effect on the honest keeper replay: none** —
`arbswap_keeper::compute_quote` sets `anchor_sqrt_price = sqrt_q64(oracle_price)`
exactly, so `|anchor − oracle| = 0` by construction for every honest quote; the
bound only constrains a misbehaving keeper. (No production default constant is
changed here; `max_anchor_dev_bps` is client-supplied and recorded in
`docs/ASSUMPTIONS.md` A-19.)

## H3 — Automatic realized-loss (edge) breaker

Every `swap` measures the vault's realized execution edge against the **stored,
verified** oracle price from the latest `update_quote`:

```text
edge = amount_in − out·oracle      (BuyBase: the vault sells base)
edge = amount_in·oracle − out      (SellBase: the vault buys base)
```

in quote atoms (positive = the vault traded better than the oracle mid). The
signed edge accumulates in `QuoteState.realized_edge` over a **clock-rolled**
window of `edge_window_slots`. If
`realized_edge < −max_edge_loss_bps · available_value / 1e4`, the vault is
auto-paused (same state as the manual breaker; admin reset only). Re-quoting does
**not** reset the tracker (the window rolls on the slot clock), and
deposits/withdrawals never touch it.

**Bound with the breaker:** realized adverse selection is capped at
`max_edge_loss_bps` of the available value **per window**, on top of the T6
per-update bound — i.e. per-hour worst case ≈ `(3600·4 / edge_window_slots) ·
max_edge_loss_bps` of value. Both parameters are config-bounded and timelocked.

**Evidence:** `honest_flow_does_not_trip_the_edge_breaker` (20 honest slots, no
trip); `malicious_keeper_edge_loss_trips_within_the_window` (keeper at max
deviation trips at slot index 3; `realized_edge = −168,531` vs bound `150,000`);
`deposits_and_withdrawals_do_not_move_the_edge_tracker`.

**Open / provisional:** the window-level honest trip-rate table on the P1
calm/trend/crash/stress replays is **not** produced — the simulator does not yet
model the on-chain edge tracker, so the default `max_edge_loss_bps` is
provisional (set to a loose 500 bps / 5% in tests). A legitimate loss to informed
flow also reduces the edge, so this default must be set from the window replay
before it is tightened.

Solana-specific checklist (Build Plan §11): signer checks on every authority;
owner/address checks on every account incl. the Pyth account (correct program +
feed id); canonical PDA bumps; token accounts verified for mint/owner/program;
reject Token-2022 transfer-changing extensions; no reinitialization; closed
accounts zeroed; duplicate-mutable audit; hard-coded CPI program ids; checked
arithmetic; no unchecked `remaining_accounts`; indexer reconciles events with
state; admin cannot seize funds; keeper bounds enforced on-chain.