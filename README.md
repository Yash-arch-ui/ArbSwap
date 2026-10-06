# ArbSwap

**An open, professionally managed market-making vault on Solana** — AMM pooled
capital + propAMM-style active quoting, with one hard promise: **the price you
are quoted is the price you get.**

Formerly "TruQuote" (working name); all spec documents use the old name.

## Status: P0 — foundations

| Phase | Scope | Status |
|---|---|---|
| P0 | Repo, toolchain, assumptions | ✅ this commit |
| P1 | Python reference math, golden vectors, `arb-math`, simulator (E1–E4) | ⬜ |
| P2 | Anchor program: accounts, guards, swap, vault loop; devnet | ⬜ |
| P3 | Keeper: Pyth client, quote calc, sender, replay parity | ⬜ |
| P4 | Analytics, fees, dashboard | ⬜ |
| P5 | Attacker bots, fuzzing, aggregator adapter | ⬜ |
| P6 | Reproducibility, demo, docs | ⬜ |

Program ID (localnet/devnet): `E8ptkpV626P2neR8v4Q9UCFHoD6AMAH2aTRsEQiNDN3U`

## Layout

```
programs/arbswap/    Anchor program (guards, custody, swap engine)
crates/arb-math/     Pure fixed-point math — shared bit-exactly by program, keeper, simulator
keeper/              Rust keeper: Pyth -> quote -> cheap bounds-checked update
research/            Python reference math (source of truth), simulator, data scripts only
analytics/           Indexer + metrics (markouts, LVR, quote-vs-fill gap)
app/                 Next.js dashboard (LP / trader / risk / demo views)
attackers/           Adversarial bots (E7)
tests/               Integration tests + golden vectors
docs/                BUILD_PLAN.md (the spec), ASSUMPTIONS.md, THREAT_MODEL.md
```

## Setup and verification

Toolchain used at setup: solana-cli 4.1.2, anchor 1.1.2, rust 1.98.0
(pinned in `rust-toolchain.toml`), node 24, python 3.12.

```bash
# Rust: math + keeper + program
cargo test --workspace

# Anchor build (program; requires the Solana SBF toolchain)
anchor build

# Python reference
python3 -m venv .venv && source .venv/bin/activate
pip install -r research/requirements.txt
pytest research -q

# Dashboard deps
cd app && yarn install
```

## Ground rules (Build Plan §0)

Math lives in one place and is tested against the Python reference; no floats
on-chain; rounding always favors the vault; security over speed; never claim a
result that has not been measured; report losing regimes.

## Documents

- `docs/BUILD_PLAN.md` — the full specification (imported, verbatim).
- `docs/ASSUMPTIONS.md` — what is verified vs assumed (read before coding).
- `docs/THREAT_MODEL.md` — threats, mitigations, tests.
