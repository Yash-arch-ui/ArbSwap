# ArbSwap P1-P3 Delivery Report

Date: 2026-10-07

## Scope

This report covers the combined P1, P2, and P3 pass requested against:

- `MasterPlan.md`, including Section 14's reading order and study questions
- `BuilderPlan.md`, especially Sections 5-8 and the P1-P3 acceptance gates
- `docs/FORMULA.md`, `docs/ASSUMPTIONS.md`, and `docs/READING_NOTES.md`

The research notes contain the design consequences for markouts, LVR, dynamic
fees, directional fees, oracle risk, honest execution, Solana update economics,
reservation-price skew, and Glosten-Milgrom toxicity. Unverified claims remain
labelled as assumptions; Base spoofing numbers are not presented as Solana
measurements.

## P1: Research Core

Implemented and exercised:

- Python reference math, Q64.64 reference, ladder walk, shares, rounding rules
- 970 golden vectors with bit-exact Rust `arb-math` verification
- Passive, fixed-spread, no-throttle, no-honesty, and full ArbSwap venues
- Walk-forward calibration
- E1-E6 metrics, quote-versus-fill gap, rejection counts, and E9 sensitivity
- Binance 1-second downloader and timestamp-aware replay loader
- Pyth Benchmarks downloader with authenticated API-key handling
- Synthetic calm/trend/crash replay and a real Binance SOLUSDT sample replay

Command:

```text
python -m research.sim.report --real research/data/raw/binance_SOLUSDT_1s.csv
```

The generated results are in `docs/P1_RESULTS.md`. The results show the
expected pattern on the sampled real path: passive liquidity is materially
picked off while ArbSwap maintains positive markouts. Synthetic results remain
mixed and are not product claims.

## P2: On-Chain Program

Implemented in `programs/arbswap/src/lib.rs`:

- PDA-backed vault, config, quote state, deposit ticket, and withdrawal ticket
- SPL base/quote reserves and share mint controlled by the vault PDA
- Pro-rata two-token deposits with minimum-liquidity lock
- Warm-up enforcement before withdrawal requests
- Epoch advancement and queued pro-rata withdrawals
- Quote updates with keeper authorization, monotonic slots, stale-oracle,
  confidence, spread, anchor-step, ladder, and depth bounds
- Constant-product ladder swap using the shared `arb-math` walk
- Fee rounding through `arb-math`, plus insurance, keeper, and protocol bucket
  accounting excluded from LP reserve share value
- Version/min-output checks, capacity checks, expiry, and status checks
- Public breaker trip, admin reset, and admin wind-down
- Events and explicit error codes for the core lifecycle
- Large account contexts boxed to satisfy Solana's 4 KiB stack constraint

Verification:

- `anchor build` passes
- `cargo test --workspace` passes

P2 boundary still intentionally visible:

- Pyth account deserialization/CPI verification is not yet wired into
  `update_quote`; caller-supplied oracle fields are bounded on-chain. This is a
  security boundary, not a hidden assumption, and must be completed before
  devnet funds or production deployment.
- A local-validator/LiteSVM lifecycle test and devnet deployment are not claimed
  by this report.

## P3: Keeper

Implemented in `keeper/src/lib.rs` and `keeper/src/main.rs`:

- Integer Q64.64 oracle tick model
- Short/medium EWMA variance and jump detection
- Inventory skew, volatility/confidence/age spread, depth throttle, and ladder
  construction
- `should_update` threshold, age, and first-quote logic
- Adaptive priority-fee calculation with jump urgency
- `QuoteSender` abstraction and deterministic dry-run sender
- CSV replay mode:

```text
cargo run -p arbswap-keeper -- replay <slot,publish_time,price_q64,confidence_bps,base_reserve,quote_reserve.csv>
```

Verification:

- Keeper unit tests pass for deterministic EWMA, quote/update gating, and
  priority-fee urgency
- `cargo test --workspace` passes

P3 boundary still intentionally visible:

- The sender is dry-run only; no private-key or live RPC transport was added.
- Replay uses the shared Rust math crate but the quote-construction layer still
  needs a differential vector suite against the Python simulator before the P3
  devnet gate can be called passed.

## Verification Summary

| Area | Status | Evidence |
|---|---|---|
| P1 math and vectors | Complete | `pytest`, `cargo test -p arb-math` |
| P1 replay/report pipeline | Complete | `docs/P1_RESULTS.md` |
| P2 program compilation | Complete | `anchor build` |
| P2 native tests | Complete | `cargo test --workspace` |
| P2 local lifecycle/devnet gate | Pending | Pyth CPI + integration harness required |
| P3 keeper core/replay | Complete | keeper unit tests and binary |
| P3 live sender/devnet parity gate | Pending | RPC transport + differential replay required |

No mainnet deployment, private key handling, or financial-performance claim is
made.

## Diagram Alignment

The language architecture from `docs/LANGUAGE_ARCHITECTURE.md` is now wired as
an executable handoff:

1. Python P1 exports `slot,publish_time,price_q64,confidence_bps,base_reserve,quote_reserve`.
2. Rust P3 consumes that CSV, updates EWMA state, computes production integer
   quotes, applies update gating and priority fees.
3. Rust P3 emits the Anchor `global:update_quote` discriminator plus the exact
   Borsh field order expected by P2.
4. P2 validates the payload and executes custody/swap logic on-chain.

Run the handoff with `scripts/p1_to_p3_replay.sh`. The final live transport is
still intentionally dry-run until the deployment-specific PDA/account wiring
and Pyth CPI verification are reviewed.
