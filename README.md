# ArbSwap

### An on-chain, professionally managed market-making vault for Solana.

AMM-pooled capital + propAMM-style active quoting, with one defining property:
**the price you are quoted is the price you get.**

ArbSwap combines a pooled liquidity vault (LP capital, pro-rata shares, epoch
withdrawals) with an active, on-chain quoting engine that continuously reprices a
six-level ladder around a verified Pyth reference price. Every quote is committed
on-chain with a version and an expiry; every swap either fills at least the
quoted minimum or reverts. There is no hidden spread captured between the quote
and the fill.

> Formerly "TruQuote". Program id (Devnet): `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm`

---

## Table of contents

1. [The core idea](#the-core-idea)
2. [Live Devnet deployment](#live-devnet-deployment)
3. [System architecture](#system-architecture)
4. [The full pipeline](#the-full-pipeline)
5. [Pricing engine](#pricing-engine)
6. [On-chain program](#on-chain-program)
7. [Keeper](#keeper)
8. [Frontend](#frontend)
9. [Aggregator adapter](#aggregator-adapter)
10. [Research & simulation pipeline](#research--simulation-pipeline)
11. [Analytics pipeline](#analytics-pipeline)
12. [Claims](#claims)
13. [Security model](#security-model)
14. [Testing, CU, and verification](#testing-cu-and-verification)
15. [Repository layout](#repository-layout)
16. [Getting started](#getting-started)
17. [Documentation index](#documentation-index)

---

## The core idea

Traditional AMMs quote a constant-product curve and expose LPs to adverse
selection: the price moves and the pool is picked off at the stale curve. CEXs
quote actively but you never trade against the order book itself. ArbSwap takes a
third path:

- **Pooled capital, active quotes.** LPs deposit a base/quote pair; the vault
  mints pro-rata shares. A permissionless keeper prices a six-level ladder around
  the verified Pyth oracle with a dynamic spread that widens with volatility,
  inventory imbalance, oracle confidence and staleness.
- **Honest execution by construction.** The ladder is committed on-chain as
  `QuoteState` with a `version` and an `expiry_slot`. A swap passes
  `min_out` and `min_version`; the program walks the ladder with exact integer
  math and reverts with `SlippageExceeded` rather than fill worse. The quote you
  see is the quote you fill.
- **Bounded, never-trusted keepers.** The keeper can move prices only inside
  on-chain bands: anchor↔oracle deviation, per-level offset bounds, min/max
  spread, the spread step, ladder capacity against available reserves, update-slot
  age, and a per-window one-sided flow cap. The program — not the keeper — is the
  source of truth.
- **Fail to a stop, never to a bad price.** If the keeper stops, the quote expires
  and swaps revert (`QuoteExpired`). A permissionless, state-only circuit breaker
  can pause quoting.

---

## Live Devnet deployment

A fully wired WSOL/USDC vault is deployed and running on Devnet:

| Item | Address |
|---|---|
| Program | `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` |
| Vault (PDA) | `8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt` |
| Config (PDA) | `ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT` |
| QuoteState (PDA) | `5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG` |
| WSOL reserve | `8vfr2KmMmXYUTjRg5cAiSYD6EhN1d8pjJnmFC95E2vfm` |
| USDC reserve | `G8q1WMKT8fnGQh85kCB8Aihf6F7tctXJDKbA6gn1jPeS` |
| WSOL mint | `So11111111111111111111111111111111111111112` |
| Circle Devnet USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Pyth SOL/USD feed id | `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` |

Deployed parameters (read live from `Config`): `expiry_slots = 120`,
`max_staleness_seconds = 2`, `max_conf_bps = 10`, `fee_bps = 1`,
`min_spread_bps = 2`, `max_update_slot_age = 25`, `utilization_max_bps = 5000`.

---

## System architecture

```
   Pyth Hermes (price, confidence, publish_time)         CEX reference (research/replay only)
                 │                                                       │
                 ▼                                                       ▼
    ┌───────────────────────────┐                          ┌──────────────────────────────┐
    │ Keeper(s)  (Rust + TS)    │  stage_quote / commit    │ Simulation & reference math  │
    │  • volatility EWMA        │ ───────────────────────▶ │  • high-precision Python ref │
    │  • reservation + spread   │                          │  • 997 golden vectors        │
    │  • 6-level ladder         │                          │  • event-driven replay       │
    │  • adaptive priority fee  │                          └──────────────┬───────────────┘
    │  • VAA-rent reclamation   │                                         │ bit-exact parity
    └─────────────┬─────────────┘                                         ▼
                  │ one write per update                      ┌──────────────────────────────┐
                  ▼                                           │ arb-math (Rust, Q64.64)      │
    ┌─────────────────────────────────────────────┐          │ shared by program/keeper/agg │
    │ ArbSwap Program (Anchor)                    │◀─────────└──────────────────────────────┘
    │  Vault │ Config │ QuoteState │ PendingQuote  │
    │  DepositTicket │ WithdrawTicket │ KeeperBond │
    │  swap │ deposit │ withdraw │ update_quote    │
    └───────────────┬─────────────────────────────┘
                    │ events / logs
                    ▼
    ┌───────────────────────────┐        ┌───────────────────────────┐
    │ Indexer + Analytics       │──────▶ │ Frontend (app/)           │
    │  markouts · LVR · gap     │        │  Overview · Swap · Vault  │
    │  attribution · retention  │        │  Risk · Analytics · Sim   │
    └───────────────────────────┘        └───────────────────────────┘
```

**Components**

| Component | Path | Responsibility |
|---|---|---|
| On-chain program | `vault/program/src/lib.rs` | Custody, shares, quote state, swap, guards, breakers, timelock, keeper bond |
| Shared integer math | `vault/math/src/` | Fixed-point ladder walk, capacities, fees, share math (no Solana deps) |
| Keeper core | `vault/keeper/src/` | Pyth/Hermes parse, quote computation, payload encoder, offline pre-validation |
| Keeper driver | `scripts/devnet/keeper_live.ts` | Live staged-quote pipeline, multi-endpoint broadcast, VAA-rent reclamation |
| Aggregator adapter | `vault/aggregator/src/` | Jupiter-style `out_given_in` / `in_given_out` / `best_price` |
| Reference math | `simulation/reference/` | High-precision Python reference + golden-vector generator |
| Simulator | `simulation/sim/` | Event-driven replay, baselines B1–B4, studies S1–S5 |
| Analytics | `simulation/analytics/` | Indexer, metric engine, static dashboard |
| Attackers | `simulation/attackers/` | E7 adversarial bots + on-chain account attacks |
| Frontend | `app/` | Vite + React dApp (read live on-chain state, build/sign swaps) |

**Trust boundaries**

- **Trusted:** the Solana runtime, the Pyth program/feed (with on-chain checks),
  and the program code.
- **Semi-trusted:** keepers — bounded on-chain, never trusted for pricing.
- **Untrusted:** traders, LPs, other programs, RPC nodes.
- **Admin:** timelocked parameter changes and a pause/wind-down kill switch; the
  admin cannot seize LP reserves.

---

## The full pipeline

### 1. Quote lifecycle — two-phase stage → commit

The keeper never writes an unverified price. Each cycle runs on a single shared
blockhash:

```
Hermes update ─┐
current slot ──┼─ concurrently ──▶ Rust engine `quote-json` ──▶ QuoteUpdate body
blockhash ─────┘
        │
        ├─ Tx A  stage_quote(update, nonce)      writes only the pending_quote PDA
        │
        ├─ Tx V  Wormhole VAA post                create + init/write/verify EncodedVaa
        │
        └─ Tx B  updatePriceFeed + commit_quote   Pyth push + commit in ONE transaction
```

- **Tx A (`stage_quote`)** records intent in a per-keeper `pending_quote` PDA and
  leaves the live `QuoteState` untouched.
- **Tx V** posts the Pyth accumulator VAA to a Wormhole `EncodedVaa` account.
- **Tx B** writes the Pyth push-oracle feed and commits the quote **atomically**,
  so the oracle value the program verifies is exactly the value committed.
- `commit_quote` re-validates every bound (below), bumps `QuoteState.version`, and
  sets `expiry_slot = slot + expiry_slots`.

This split is deliberate: a quote-only rejection can never roll back a valid
oracle write, and the two-phase nonce prevents replay and stale-pending commits.

### 2. Swap

```
trader ── read QuoteState ──▶ simulate ──▶ swap(side, amount_in, min_out, min_version)
   program checks: status Active · version ≥ min_version · slot < expiry_slot ·
   amount ≤ max_quote_size · fee = ceil(amount_in·fee_bps/10⁴) · ladder walk ·
   out ≥ min_out · per-window flow cap · transfer · split fee · emit SwapEvent
```

`BuyBase` lifts the ask levels; `SellBase` hits the bid levels (the same ladder is
used for both sides). If the ladder cannot absorb the whole input it reverts with
`CapacityExceeded`; if the output would be below `min_out` it reverts with
`SlippageExceeded`. Any failed check reverts the entire transaction.

### 3. LP lifecycle

- `deposit(base, quote, min_shares)` mints pro-rata shares. The first deposit
  mints `floor(sqrt(base·quote)) − MIN_LIQUIDITY`; later deposits mint
  `min(base·S/B, quote·S/Q)`. Shares activate after a warm-up.
- `request_withdraw(shares)` queues a ticket for the next epoch; `crank_epoch`
  advances the epoch after `epoch_slots`; `claim_withdraw` pays
  `shares·B/S` and `shares·Q/S` pro-rata.

### 4. After a swap

The indexer parses `SwapEvent`; the metric engine computes markouts, LVR,
quote-versus-fill gap and fee/gas attribution. On its next tick the keeper sees
the new reserves, inventory skew shifts `P_res`, and it republishes the ladder.

---

## Pricing engine

The quote is a self-contained, token-unit, expiring object.

- **Inventory skew.** `q = (B·P − Q)/(B·P + Q) ∈ [−1, 1]`.
- **Reservation price.** `P_res = P·(1 − g·q)` — the vault leans against its own
  inventory.
- **Dynamic half-spread.**
  `s = clamp(s_floor + a1·σ + a2·|q| + a3·(c/P) + a4·max(0, age−grace) + a5·jump, s_min, s_max)`,
  with a directional add-on on the moving side.
- **Anchor.** A band-bound anchor (`anchor_sqrt_price`) with a bounded per-update
  step (`max_anchor_step_bps`).
- **Six-level ladder.** Levels are `{sqrt_lo, sqrt_hi, liquidity}` in Q64.64 with
  offsets `[2, 5, 10, 20, 40, 80]` bps and weights summing to 10,000. Per-level
  capacity is a share of `depth_mult · utilization_max · reserves`.

**Ladder walk.** `arb_math::walk_ladder` fills constant-product segments across
levels with exact integer arithmetic (`base_capacity = floor(L·Δ/(lo·hi))`,
`quote_capacity = floor(L·Δ/2¹²⁸)`), returning the unabsorbed remainder.
`buyBase` computes `delta = floor(q_in·2¹²⁸/L)`, `P' = sqrt_lo + delta`,
`out = floor(floor(L·delta/lo)/p)`; `sellBase` computes
`P' = ceil(hi·L/(L + x·hi))`, `out = floor(L·(hi − P')/2¹²⁸)`. Fees are
`ceil(amount_in·fee_bps/10⁴)`.

**Fixed-point discipline.** All prices are Q64.64; there are no floats on-chain.
`isqrt` uses a 192-bit radicand; capacity estimates use an inverse-square-root
round-up so the estimate never understates the exact capacity. Rounding always
favors the vault (payouts down, receipts up).

**Cross-language parity.** The Python reference is an independent high-precision
implementation that generates **997 bit-exact golden vectors**
(`vault/math/tests/golden_vectors.txt`), checked against the Rust `arb-math` by
`golden.rs`. The keeper's offline pre-validation mirrors every `Config` bound so
no transaction is ever spent on a knowable rejection.

---

## On-chain program

Single Anchor program; ladder size 6; admin timelock 216,000 slots.

**State accounts (PDA seeds)**

| Account | Seeds | Purpose |
|---|---|---|
| `ProgramConfig` | `[b"program"]` | deploy admin |
| `Vault` | `[b"vault", base_mint, quote_mint]` | mints, reserves, share mint/lock, total shares, fee buckets, epoch, status |
| `Config` | `[b"config", vault]` | keeper, treasury, Pyth feed id, fee split, all safety bounds, min bond |
| `QuoteState` | `[b"quote", vault]` | version, update/expiry slot, anchor/reservation, spread, ask/bid levels, oracle price/conf/publish, flow window, edge tracker, keeper author |
| `PendingQuote` | `[b"pending_quote", vault, keeper]` | staged update, nonce, stage slot, state snapshot |
| `PendingConfig` | `[b"pending", vault]` | timelocked parameter change |
| `PendingClaim` | `[b"claim", vault]` | timelocked fee claim |
| `DepositTicket` | `[b"dep", vault, user]` | shares, activate slot |
| `WithdrawTicket` | `[b"wd", vault, user]` | shares, epoch |
| `KeeperBond` | `[b"keeper", vault, keeper]` | bond, slashed, unbond cooldown |
| `KeeperReward` | `[b"reward", vault, keeper]` | per-keeper base/quote accrual |
| `VolatilityState` | `[b"vol", vault]` | EWMA short/medium, jump state, sigma params |
| `PendingVolatilityParams` | `[b"vol_pending", vault]` | timelocked volatility params |

**Instruction surface**

| Category | Instructions |
|---|---|
| Init | `initialize_program`, `initialize_vault`, `initialize_volatility` |
| LP lifecycle | `deposit`, `request_withdraw`, `crank_epoch`, `claim_withdraw` |
| Quote lifecycle | `update_quote`, `stage_quote`, `commit_quote`, `migrate_quote_state` |
| Swap | `swap` |
| Risk / breaker | `trip_breaker`, `reset_breaker`, `wind_down` |
| Admin / timelock | `set_params`, `apply_params`, `propose_admin`, `accept_admin`, `cancel_admin`, `propose_fee_claim`, `execute_fee_claim` |
| Keeper bond / rewards | `bond_keeper`, `unbond_keeper`, `slash_keeper`, `claim_keeper_reward` |
| Volatility | `propose_volatility_params`, `apply_volatility_params`, `observe_volatility` |

**Events** include `VaultInitialized`, `QuoteStateMigrated`, `DepositEvent`,
`WithdrawRequested`, `WithdrawClaimed`, `QuoteUpdated`, `QuoteStaged`,
`QuoteCommitted`, `SwapEvent`, `BreakerTripped`, `EdgeBreakerTripped`,
`BreakerReset`, `ParamsProposed`, `ParamsApplied`, `KeeperBonded`, `KeeperSlashed`,
`KeeperUnbonded`, `RewardClaimed`, `FeeClaimProposed`, `FeeClaimed`, and the
volatility/admin events.

**Error codes** (contiguous 6000–6051) include `InvalidOracle` (6015),
`AnchorTooFarFromOracle` (6020), `FlowCapExceeded` (6021), `UtilizationExceeded`
(6022), `QuoteExpired` (6030), `VersionTooOld` (6031), `SlippageExceeded` (6032),
`CapacityExceeded` (6033), `UpdateSlotTooOld` (6037), `StalePendingQuote` (6039),
`StagedStateChanged` (6040), `UnattributedQuote` (6042).

---

## Keeper

The keeper is a Rust quote engine plus a TypeScript live driver.

- **Volatility estimator.** A time-normalised EWMA (`λⁿ` decay, `r²/n`
  innovation) shared with the program, plus jump detection.
- **Adaptive priority fee.** Scales with σ and doubles on a jump, clipped to a
  floor/cap.
- **Reliability.**
  - Bounded timeouts (12 s) and a per-endpoint token-bucket poll budget.
  - First-landed multi-endpoint broadcast of identical signed bytes; duplicates
    collapse to one signature.
  - **Ambiguous outcomes are inspected, never blindly resubmitted** (`UNOBSERVED`
    state → read `getSignatureStatuses` → back off).
  - Success is only ever *confirmed + `QuoteState.version` strictly advanced +
    quote still live* — never inferred from a process return.
  - Updates already too old are skipped instead of paying a doomed fee.
  - A catch-all keeps the keeper alive across transient RPC/Pyth-SDK errors.
- **VAA-rent reclamation.** Every Pyth push creates a Wormhole `EncodedVaa`
  account (~0.00236728 SOL rent). A failed `push+commit` orphans it. The driver
  reclaims keeper-owned orphans using the Pyth SDK
  (`findOwnedEncodedVaaAccounts` → `closeEncodedVaa`), with a grace window
  exceeding the maximum transaction lifetime so an in-flight or ambiguous push can
  never race the close, plus batching and a per-pass cap.

---

## Frontend

Vite + React 19 + TypeScript, wallet-adapter (Phantom / Solflare), Anchor and
web3.js. Six routes, all driven by live on-chain state or the published artifact
bundle — no mock data:

| Page | Source of truth |
|---|---|
| **Overview** | live `ProtocolContext` (TVL, vault, quote, params, risk) + model metrics from the published bundle |
| **Swap** | live `QuoteState` ladder + reserves; wallet balances; integer ladder math |
| **Vault** | live vault/shares/tickets; deposit/withdraw/claim builders |
| **Risk** | live breaker/params + volatility PDA read |
| **Analytics** | published `/artifacts/*.json` + optional indexed on-chain export |
| **Simulator** | deterministic offline streams (no network/wallet/tx) |

**Live quote feed.** `QuoteState` is polled at the `processed` commitment (the
commitment the program uses) and freshness is recomputed against the live slot on
every tick, so a quote flips to `Expired` the moment its window passes and a new
version appears within about a slot. A failed refresh can never leave an old quote
labelled executable.

**Swap transaction lifecycle.** `build → simulate → preview → confirm → sign →
wait confirmed`: the app re-reads a fresh quote at submit time, rebuilds and
re-simulates the transaction, shows an explicit preview (input, expected output,
minimum output, fee, slippage, quote version/expiry, wallet, network), and only
then asks the connected wallet to sign. A stale quote discards the prepared
transaction instead of submitting it. Success is shown only after confirmed
on-chain status. Integer math (no floats) drives `min_out` enforcement.

**Fail-closed gating.** Swaps require a verified Devnet genesis hash, an
initialized vault, an untripped breaker, sufficient balance/depth, and a
genuinely `Fresh` on-chain quote. Distinct states (`Fresh` / `Aging` / `Expired` /
`Unavailable`, plus loading / stale / transport-error / invalid) are surfaced with
actionable messages, and `explainSwapError` decodes the deployed program errors.

---

## Aggregator adapter

A Jupiter-style read surface over the same on-chain ladder:

- `out_given_in` — exact output for an input, ceil-priced;
- `in_given_out` — bounded binary search for the input that reaches a target;
- `best_price` — the touch level.

It reuses the exact `arb-math` ladder the swap instruction executes, so quotes
are bit-identical to execution, with deterministic fees and `SlippageExceeded` on
shortfall. Properties tested: monotonicity in input, no value created by
round-trip rounding, and `in_given_out` reaching its target.

---

## Research & simulation pipeline

- **Independent reference.** A hand-written high-precision Python implementation
  is the source of truth for the math; the on-chain path is integer-only.
- **Golden vectors.** The reference generates **997 bit-exact golden vectors**;
  Rust `arb-math` is checked against them.
- **Event-driven simulator.** Three explicit clocks (source / step / slot), fully
  deterministic for a given seed and price path.
- **Baselines.** B1 passive constant-product (fee tiers), B2 fixed spread, B3 no
  depth throttle, B4 no honesty, plus a propAMM-like venue for context.
- **Pre-registered study.** W1 is the calibration window; W2–W6 are held-out and
  all five are reported. Studies S1–S5 cover clock sensitivity, slot length,
  oracle latency, seed sensitivity and regime mix. Only the baseline flow model
  and passive pool are tuned to the paper's targets; ArbSwap parameters are tuned
  on W1 and frozen.
- **Adversarial suite (E7).** Seven bots plus a control: stale feed, bad tick /
  vol spike, sandwich / pick-off, phantom liquidity, keeper down (and a
  keeper-alive control), adaptive toxic flow, and sandwich around an oracle
  update. Account/authority attacks (stale/wrong feed, anchored-level,
  donation/share-inflation, bond/slash, warm-up) run on-chain in LiteSVM.

---

## Analytics pipeline

Events are indexed in slot order into SQLite (with reconciliation of omitted
fields), then an independent metric engine computes markouts, quiet half-spread,
quote-versus-fill gap, hedged PnL, LVR (`σ²/8·V·T`) and attribution fees minus gas
minus adverse selection. A single self-contained HTML dashboard renders LP,
trader, risk and comparison views with deterministic offline replay.

---

## Claims

ArbSwap is built around an explicit set of properties. Each is implemented and
exercised by the test suite and simulation described above and in
`docs/CLAIMS.md`.

**Execution honesty**
- Every swap enforces `out ≥ min_out` on-chain against the committed ladder; a
  shortfall reverts rather than filling worse.
- `min_version` prevents filling against a superseded quote.
- The fee is a deterministic `ceil(amount_in·fee_bps/10⁴)`; there is no
  quote-versus-fill spread captured by the protocol.
- The vault returns the unabsorbed remainder as `CapacityExceeded` instead of a
  partial fill presented as complete.

**Bounded keeper**
- The anchor stays within a bounded deviation of the verified oracle and steps by
  at most `max_anchor_step_bps` per update.
- Every ladder level sits inside a bounded band of the reservation price
  (outermost offset ≤ 500 bps).
- The half-spread stays within `[min_spread_bps, max_spread_bps]` and moves by at
  most `max_spread_step_bps` per update.
- Ladder capacity never exceeds `utilization_max_bps` of the fee-net available
  reserves.
- `update_slot` is strictly monotonic and within `max_update_slot_age`.
- A per-window one-sided flow cap limits cumulative directional volume.

**Custody & accounting**
- Reserves are held in program-controlled PDAs; every reserve/mint account is
  address-bound to its vault, so cross-vault substitution is rejected.
- Shares are pro-rata and integer-exact; the first deposit mints a locked
  minimum-liquidity position.
- Withdrawals settle by epoch, pro-rata, honoring available liquidity.

**Oracle integrity**
- The program verifies the Pyth feed id, price positivity, freshness
  (`max_staleness_seconds`) and confidence (`max_conf_bps`) on-chain.
- The token-unit oracle price is derived on-chain from the verified Pyth value and
  the vault's own bound mints, and the keeper must submit the identical value.
- `price.publish_time` must equal the submitted value.

**Risk controls**
- The circuit breaker can pause quoting on a stale/wide oracle or a realized-loss
  (edge) condition; the edge breaker is state-only and reset is admin-only.
- A bonded, permissionless keeper network with a two-phase `unbond_keeper`
  cooldown and slashing during the cooldown.
- A volatility guard clamps the spread floor and depth cap and fails closed when
  enforcement is active but its state is unusable.

**Parameter & fee governance**
- Admin rotation and parameter changes are timelocked; fee claims pay the fixed
  treasury under a timelock and cannot touch LP principal.

**Math & parity**
- Shared integer math across program, keeper and aggregator; no floats on-chain;
  rounding favors the vault.
- Keeper math parity between Rust and the Python reference, anchored by the 997
  golden vectors.
- A 31-guard mutation table in which every guard has a corresponding caught
  mutation.

**Compute**
- Per-instruction compute units are measured and published as the single source
  of truth (`artifacts/public/cu.json`); see the table below.

---

## Security model

- **On-chain guards are the boundary.** Keepers, LPs, traders, aggregators, RPC
  nodes and other programs are all untrusted; the program validates every account
  binding and every bound on each instruction.
- **Fails to a stop.** A stale oracle, expired quote, tripped breaker, or an
  unbound account causes a revert or a pause — never a degraded fill.
- **Least privilege.** The admin has only timelocked actions and a pause/wind-down
  switch, and cannot seize LP reserves.
- **Reproducible evidence.** Guards are exercised by the LiteSVM lifecycle,
  oracle-scaling, breaker, recovery and security suites; a mutation table maps
  each guard to a mutation the tests catch.

External independent review of the deployed program remains a prerequisite before
any use with real funds.

---

## Testing, CU, and verification

Current suite: **282 Rust / 233 Python** tests (single source of truth:
`simulation/data/results/artifacts.json`), plus the frontend (Vite/Vitest) suite,
keeper TypeScript tests, and the browser E2E.

Measured compute units (canonical source `artifacts/public/cu.json`):

| Instruction | Compute units |
|---|---|
| `swap` | 63,579 |
| `update_quote` | 47,836 |
| `deposit` | 43,657 |
| `bond_keeper` | 26,130 |
| `claim_withdraw` | 23,730 |
| `request_withdraw` | 18,160 |
| `slash_keeper` | 16,901 |
| `claim_keeper_reward` | 14,267 |
| `accept_admin` | 9,365 |
| `propose_admin` | 8,064 |
| `cancel_admin` | 7,555 |
| `crank_epoch` | 5,164 |

Reproduce:

```bash
# Rust: math + keeper + program
cargo fmt --all -- --check
cargo clippy -p arb-math -p arbswap-keeper -p arb-aggregator -p arbswap -- -D warnings
cargo test --workspace

# Python reference + simulator + analytics + attackers
pytest simulation -q

# Frontend
cd app && npm run lint && npm run build && npm test

# Docs/bundle/secret gates
python scripts/check_docs_consistency.py
python scripts/check_bundle_freshness.py
python scripts/banned_words.py
python scripts/secrets_scan.py
```

---

## Repository layout

```
vault/
  program/        Anchor program (guards, custody, swap engine, breakers, timelock)
  math/           Pure fixed-point math shared bit-exactly by program, keeper and aggregator
  keeper/         Rust keeper: oracle tick -> arb-math -> staged quote payload
  aggregator/     Jupiter-style quote/swap adapter
  e2e/            End-to-end harness
simulation/
  reference/      High-precision Python reference math + golden-vector generator
  sim/            Event-driven simulator, baselines, studies
  analytics/      Indexer + metric engine + static dashboard
  attackers/      Adversarial bots (E7)
  data/           Download scripts only (raw data gitignored)
app/              Vite + React dApp (Overview / Swap / Vault / Risk / Analytics / Simulator)
scripts/          Devnet scripts (keeper, deploy, measurement) + doc/bundle/secret gates
docs/             Spec, architecture, formula, security, claims, results
tests/            Integration tests + golden vectors
```

---

## Getting started

**Frontend (reads the live Devnet vault):**

```bash
cd app
npm install
npm run dev        # http://localhost:5173
```

Connect Phantom or Solflare on Devnet. The Overview, Swap, Vault, Risk and
Analytics pages render live on-chain state; the Simulator runs offline.

**Keeper (keeps the book fresh):**

```bash
cd scripts/devnet
set -a; . ../../.env; set +a            # PYTH_API_KEY / RPC / keypair path
export ARBSWAP_RPC_FALLBACKS=https://api.devnet.solana.com
scripts/devnet/demo_up.sh 7200          # supervised, single-instance
```

**Deposit / withdraw / swap** are built by the frontend against the deployed
program; the same instructions are available to scripts under `scripts/devnet/`.

---

## Documentation index

- `docs/ARCHITECTURE.md` — component map, data flow, trust boundaries.
- `docs/PIPELINE.md` — the end-to-end quote/swap/deposit/withdraw pipeline.
- `docs/FORMULA.md`, `MATH.md` — the pricing math source map.
- `docs/ASSUMPTIONS.md` — verified vs assumed.
- `docs/CLAIMS.md` — the claims ledger with evidence and limits.
- `docs/RESULTS.md`, `docs/P1_RESULTS.md` — results and methodology.
- `docs/SECURITY.md`, `docs/SECURITY_CHECKLIST.md` — guards, account-binding, CU and mutation tables.
- `docs/DEVNET.md` — the Devnet lifecycle and keeper runs.
- `docs/DEMO_RUNBOOK.md`, `docs/DEMO_SCRIPT.md` — demo steps.

---

*ArbSwap is Devnet-only. It has not undergone an independent external audit.
The deployed program enforces a strict two-second Pyth freshness rule at commit;
the demo quote window is 120 slots. Use test funds only.*
