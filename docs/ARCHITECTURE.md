# ARCHITECTURE.md

ArbSwap component map, data flow, instruction surface and trust boundaries.
Reconciled with the code in the p2 pass (2026-10-08). Where the diagram and the
code differ, see "Code vs picture" below.

## System diagram

```
   Pyth price + confidence + publish time        CEX reference (research/backtest)
              |                                          |
              v                                          v
   +----------------------+   quote params    +---------------------------------+
   | Keeper(s) (Rust)     | ----------------> | ArbSwap Program (Anchor)        |
   |  - vol estimator     |  1 write          |  Vault | QuoteState | Config    |
   |  - quote calculator  |  per update       |  DepositTicket | WithdrawTicket  |
   |  - adaptive priority |                   |  KeeperBond | PendingConfig/Claim
   |    fee               |                   |  Swap | Deposit | Withdraw      |
   +----------+-----------+                   +----------------+----------------+
              ^                                                |
              |  reserves, events                              | events/logs
              +------------------------------------------------+
                                      |
                       +--------------v---------------+
                       | Indexer + Analytics service  |
                       | markouts, LVR, quote-vs-fill |
                       | attribution, retail metric   |
                       +--------------+---------------+
                                      |
                          +-----------v-----------+
                          | Dashboard (web)       |
                          | LP | Trader | Risk    |
                          | Passive vs ArbSwap    |
                          +-----------------------+
```

## Components (code)

| Component | Path | Responsibility |
|---|---|---|
| On-chain program | `vault/program/src/lib.rs` | custody, shares, quote state, swap, guards, breakers, timelock, keeper bond |
| Shared math | `vault/math/` | pure fixed-point ladder walk, capacities, fees, share math (no Solana deps) |
| Keeper | `vault/keeper/` | Pyth/Hermes parse, quote calc, replay, live tx builder |
| Aggregator adapter | `vault/aggregator/` | `out_given_in`/`in_given_out`/`best_price` (Jupiter-style) |
| Reference math | `simulation/reference/` | high-precision Python reference + golden vectors |
| Simulator | `simulation/sim/` | event-driven replay, baselines B1–B4, router, studies |
| Analytics | `simulation/analytics/` | indexer, metrics (markout/LVR/gap), static dashboard |
| Attackers | `simulation/attackers/` | E7 adversarial bots |
| Frontend | `frontend/` | dashboard app (package skeleton only; no source yet) |

## End-to-end flow

1. Keeper reads a Pyth Hermes tick (`price`, `conf`, `publish_time`).
2. Keeper updates volatility, computes `P_res`, spread, depth, and the ask-side
   ladder via `arb-math` (`vault/keeper/src/lib.rs::compute_quote`).
3. Keeper sends `update_quote` (ComputeBudget + in-band Pyth account + the
   instruction) with an adaptive priority fee.
4. Program verifies the Pyth account (owner, feed id, freshness, price/conf
   equality), checks the anchor↔oracle band, level↔anchor band, reservation
   band, spread bounds, the `update_slot` age, and the ladder capacity vs
   available reserves; then stores the new `QuoteState`, bumps `version`, resets
   the flow window on the slot clock, and emits `QuoteUpdated`.
5. A trader/aggregator reads `QuoteState`, simulates, and sends
   `swap(side, amount_in, min_out, min_version)`.
6. Program checks status, version, expiry, size cap and the per-window
   one-sided flow cap, walks the ladder with `arb-math`, enforces `min_out`,
   transfers tokens, buckets the fee, and emits `SwapEvent`.
7. The indexer parses events; the metrics engine computes markouts, LVR,
   quote-versus-fill gap and attribution; the static dashboard renders them.
8. Deposits mint pro-rata shares after a warm-up; withdrawals queue by epoch and
   settle pro-rata.

## Trust boundaries

- **Trusted:** Solana runtime; Pyth program/feed (with on-chain checks); the
  program code.
- **Semi-trusted:** keepers — bounded on-chain (spread, anchor band, level band,
  capacity vs reserves, per-window flow cap, bond), never trusted for pricing.
- **Untrusted:** traders, LPs, other programs, RPC nodes.
- **Admin:** timelocked parameter changes; pause/wind-down kill switch; cannot
  seize LP reserves (fee claims are timelocked and pay only the fixed treasury).

## Code vs picture

| Diagram / spec says | Code reality (p2 pass) |
|---|---|
| "one cheap write reprices the book" | true, but our `update_quote` costs ~63k CU (Pyth verification + capacity maths dominate), not <1k |
| keeper quotes a two-sided ladder | the keeper emits **ask-side levels only**; the program maps `SellBase` onto the same levels (documented divergence) |
| LVR depth budget `V ≤ 8(R−gas)/σ²` enforced | **not enforced on-chain**; the throttle is a keeper-side policy bounded by on-chain caps (spread/anchor/capacity). Budget language dropped from claims |
| `flow_n` netting accumulator | **removed** (was dead state); the per-window one-sided flow cap is the live control |
| `depth_mult_bps` depth control | indexer hint only; on-chain depth = level `liquidity` + `utilization_max_bps` capacity bound |
| dashboard demo mode (split-screen, attacks) | **not built**; only a static generated HTML (`simulation/analytics/out/dashboard.html`) |
| open bonded keeper network | bond/slash/reward + two-phase `unbond_keeper` exist; the MVP still allowlists `config.keeper` |
| live devnet loop | code present, never deployed |
