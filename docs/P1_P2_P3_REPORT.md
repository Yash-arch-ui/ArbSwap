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
- Pyth Receiver `PriceUpdateV2` Full verification, configured feed-ID matching,
  freshness validation, decoded Q64 price equality, and decoded confidence
  equality
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

P2 oracle verification:

- `update_quote` requires the Pyth Receiver `PriceUpdateV2` account, Full
  verification, the configured feed ID, freshness, decoded Q64 price equality,
  and decoded confidence equality.
- The public breaker trips only from stored quote expiry, never caller-supplied
  oracle fields.
- LiteSVM executes the built SBF program and records exact consumption for the
  money path:

  | Instruction | CU |
  |---|---|
  | `update_quote` | 12,802 |
  | `trip_breaker` | 7,051 |
  | `swap` | 33,676 |

  Every instruction fits the 200,000 CU transaction default. `swap` was
  201,119 CU before the Task 2 rewrite of `arb_math::wide::U256::div_rem`
  (256-round restoring shift-subtract → Knuth Algorithm D over 64-bit limbs)
  and `U256::isqrt` (bit-wise restoring → Newton's method seeded from the bit
  length), both bit-identical to the previous routines.
- A token-funded fixture (`tests/litesvm_lifecycle.rs`) drives deposit →
  `update_quote` → swap → expiry/breaker/reset → withdraw/crank/claim in one
  LiteSVM instance and asserts per-holder and global value conservation,
  rejection of Token-2022 accounts, and rejection of untrusted or stale Pyth
  accounts.
- Devnet deployment remains a separate gate.

## P3: Keeper

Implemented in `keeper/src/lib.rs` and `keeper/src/main.rs`:

- Integer Q64.64 oracle tick model
- Short/medium EWMA variance and jump detection
- Inventory skew, volatility/confidence/age spread, depth throttle, and ladder
  construction
- `should_update` threshold, age, and first-quote logic
- Adaptive priority-fee calculation with jump urgency
- `QuoteSender` abstraction and deterministic dry-run sender
- CSV replay mode, including direct P1 `timestamp_ms,price` CSV input:

```text
cargo run -p arbswap-keeper -- replay <slot,publish_time,price_q64,confidence_bps,base_reserve,quote_reserve.csv>
```

Verification:

- Keeper unit tests pass for deterministic EWMA, quote/update gating, and
  priority-fee urgency
- Independent Python quote-construction parity test passes for Rust keeper
  anchor/reservation/spread/depth/ladder outputs
- `cargo test --workspace` passes

P3 remaining deployment boundary:

- The sender is dry-run only; no private-key or live RPC transport was added.
- Replay consumes P1 price CSVs directly in Rust; Python remains the independent
  reference/reporting layer.
- Quote construction has an independent Python differential suite covering
  anchor, reservation, spread, depth, and ladder outputs.

## Verification Summary

| Area | Status | Evidence |
|---|---|---|
| P1 math and vectors | Complete | `pytest`, `cargo test -p arb-math` |
| P1 replay/report pipeline | Complete | `docs/P1_RESULTS.md` |
| P2 program compilation | Complete | `anchor build` |
| P2 native tests | Complete | `cargo test --workspace` |
| P2 security/expiry integration | Complete | LiteSVM SBF tests: expiry breaker, Pyth verification, Token-2022 rejection |
| P2 token-funded lifecycle | Complete | `tests/litesvm_lifecycle.rs`: deposit/quote/swap/breaker/withdraw + value conservation |
| P2 access control + adversarial suite | Complete | `tests/litesvm_security.rs` (program-admin gate, re-init), 19 lifecycle tests, 2 breaker tests |
| P2 attack-vector review | Complete | Every account constrained by PDA seed/address/owner/mint; checked arithmetic; no `remaining_accounts`/arbitrary CPI (ASSUMPTIONS A-20) |
| P2 CU measurements | Complete | `update_quote` 12,802 / `trip_breaker` 7,051 / `swap` 33,676 |
| P2 devnet gate | Pending | On-chain deployment required |
| P3 keeper core/replay | Complete | keeper unit tests and binary |
| P3 price source (Hermes parse, replay) | Complete | `parse_hermes`, `PriceSource`, `HermesSource` (injected transport) |
| P3 sender (retries, adaptive fee, tight CU) | Complete | `LiveSender` refresh+retry test; `adaptive_priority_fee`; `MAX_UPDATE_COMPUTE_UNITS` |
| P3 keeper bond + reward claim | Complete | `bond_keeper`/`slash_keeper`/`claim_keeper_reward` + tests (no-drain) |
| P3 simulator parity | Complete | `test_keeper_parity.py` anchor/reservation/depth vs `quote_math.compute_quote` |
| P3 keeper-outage safe expiry | Complete | `keeper_outage_lets_the_quote_expire` |
| P3 live sender/devnet parity gate | Pending | Funded devnet run (scripted in `scripts/devnet_deploy.sh`) |

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
