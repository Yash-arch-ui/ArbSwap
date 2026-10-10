---
marp: true
paginate: true
theme: default
size: 16:9
---

# ArbSwap

**An open, oracle-anchored, two-sided market-making vault on Solana.**

One hard promise: **the price you are quoted is the price you get.**

<!-- Model output everywhere. No audit. No APY claim. -->

---

## The problem

- Passive AMMs hold capital but bleed to **adverse selection** (LVR) — they are
  slow to reprice against informed flow.
- **PropAMMs** quote tightly and win flow, but they are closed: you cannot pool
  capital into them, and their fill quality is opaque.

*Gap: an open vault that quotes actively — and provably bounds its own behavior.*

---

## The idea

Pooled capital **+** an off-chain keeper that reprices an on-chain ladder from a
verified oracle.

The keeper is untrusted: the program **bounds every quote** and enforces
`min_out`/`min_version`, so the price you are quoted is the price you get.

---

## How it works

- **Program** (`vault/program`, Anchor): custody, Pyth-verified `update_quote`,
  swaps via `arb-math`, withdrawals, breakers.
- **Keeper** (`vault/keeper`, Rust): oracle tick → `arb-math` → quote payload.
- **Math** (`vault/math`): Q64.64 fixed-point ladder, shared bit-exactly by
  program, keeper and simulator.
- **Aggregator** (`vault/aggregator`): Jupiter-style quote engine + parity test.

---

## Bounded and honest by construction

Every guard has a passing test and a **caught mutation** (31-guard table):

- anchor↔oracle band, level↔anchor band, min/max spread
- ladder capacity ≤ `utilization_max × available reserves`
- `update_slot` age cap; per-window one-sided flow cap
- quote expiry; `min_out`/`min_version` on every swap
- breaker is permissionless but **state-only**; `reset_breaker` admin-only

---

## Evidence — routed world (model output)

Real price path, synthetic flow, W1–W6 (`./scripts/headline.sh`):

| Venue | Volume share | Fill share | 2s markout (bps) |
|---|---|---|---|
| ArbSwap | 0.0% | 1.6% | +1.99 |
| B1 passive | 0.3% | 16.9% | −5.13 |
| PropAMM-like | 99.6% | 81.5% | −1.19 |

---

## The honest result

- ArbSwap **loses the routed volume share** to a tighter propAMM (~2 bps vs
  ~0.5–0.9 bps effective). We report this as prominently as any win.
- Its model markout is positive and better than the passive pool's — but on
  **synthetic flow**.
- Calibration gap (F-08): the passive benchmark is not yet the paper's benchmark.

**We do not claim to beat propAMMs on routed price.**

---

## Security posture

- **No known issues in self-review, independent audit pending.**
  This is a same-agent self-review, not an audit.
- Pyth-verified updates; PDA custody; every account bound to its vault.
- Keeper math parity (Rust ↔ Python) + 997 bit-exact golden vectors.
- Threat model and account-binding checklist in `docs/`.

---

## Limits (stated up front)

- Flow is synthetic; markout/spread/PnL are **model outputs**, not measurements.
- The propAMM-like venue is a model, not a measured competitor.
- E8 (real Solana pool quote/fill gap) is **partial**: a real routed quote is
  recorded, the full fill gap is not measured.
- Economic value on real order flow is **not yet demonstrated**.

---

## Roadmap

- Calibrate the passive benchmark to real adverse selection.
- Measure real-pool quote/fill gaps (E8) with execution data.
- Independent security review before any real funds.
- Jupiter listing requires a Jupiter-side `Swap` variant (documented).

---

# What we claim

An **open, transparent, honest, bounded** active-liquidity vault — with a
reproducible headline chart and a claims ledger where every line names its test
and its limits.

**Quote = fill. Bounded by construction. Honest about the rest.**
