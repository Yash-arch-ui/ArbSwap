# ArbSwap

**An open, professionally managed market-making vault on Solana** — AMM pooled
capital + propAMM-style active quoting, with one hard promise: **the price you
are quoted is the price you get.**

Formerly "TruQuote" (working name); all spec documents use the old name.

## Status

| Phase | Scope | Status |
|---|---|---|
| P0 | Repo, toolchain, assumptions | ✅ |
| P1 | Python reference, vectors, simulator, replay/report pipeline | ⚠️ **PARTIAL** — contamination fixed + B1 calibrated (markout −0.02 / half-spread 2.41); stress windows not yet ≥2×; all pre-fix numbers superseded |
| P2 | Anchor accounts, custody, Pyth guards, swaps, withdrawals, breakers | ✅ PASS — full deposit→update→swap→withdraw lifecycle on devnet (`docs/DEVNET.md`) |
| P3 | Rust keeper core, replay, update gating, payload encoder | ✅ PASS — live keeper on devnet, 600 s / 29 updates / 0 failures (`docs/P3_AUDIT.md` §6) |
| P4 | Analytics, fees, dashboard | ✅ PASS (SQLite indexer + live poller; metrics/attribution; interactive offline demo mode) |
| P5 | Attacker bots, fuzzing, aggregator adapter | ✅ PASS (gate: every E7 attack contained/documented; aggregator parity; docs/P5_REPORT.md). Roadmap: cargo-fuzz, E8 fill data |
| P6 | Reproducibility, demo, docs | ✅ PASS (gate: `./scripts/headline.sh` reproduces the headline chart from this README with no data/keys; demo backup MP4 + deck PDF in `docs/`) |

## Reproduce the headline chart (one command)

```bash
./scripts/headline.sh
```

Writes `docs/headline_chart.svg` (the routed-venue comparison: volume share,
fill share, 2s markout over the pre-registered W1–W6 slices) and
`simulation/data/results/headline.json`. It uses the gitignored raw archives
when present and a deterministic synthetic price path otherwise, so it runs with
**no data and no API keys**. Flow is synthetic, so every number is a **model
output**, not a product result — see `docs/HEADLINE.md` and `docs/RESULTS.md`.

## Submission artifacts (P6)

| Artifact | Path | Render |
|---|---|---|
| Headline chart | `docs/headline_chart.svg` | `./scripts/headline.sh` |
| Results with limits | `docs/RESULTS.md` | — |
| Methodology | `docs/METHODOLOGY.md` | — |
| Demo (interactive) | `simulation/analytics/out/demo.html` | `python -m simulation.analytics demo` |
| Demo backup (auto-play) | `docs/demo_backup.html` | `./scripts/record_demo.sh` |
| Demo backup (video) | `docs/demo_backup.mp4` | `./scripts/record_demo.sh` (needs a browser + ffmpeg) |
| Demo script | `docs/DEMO_SCRIPT.md` | — |
| Pitch deck (source) | `docs/PITCH_DECK.md` | — |
| Pitch deck (HTML/PDF) | `docs/pitch_deck.html`, `docs/pitch_deck.pdf` | `./scripts/render_deck.sh` |

## Claims register (only what a test proves)

The full ledger is `docs/CLAIMS.md` (claim → status → test/commit → limits).
Banned wording everywhere: "exploit-free", "audited", "safe", "cheap", "beats
propAMMs", "as complete as Uniswap", any APY/return projection.

Security posture: **no known issues in self-review, independent audit pending.**
This is a same-agent self-review, not an audit.

We claim (each backed by a named LiteSVM test in `vault/program/tests/`):
- Verified on-chain Pyth guards, PDA custody, pro-rata accounting, honest
  execution (`min_out`/`min_version`) and quote expiry.
- Bounded keeper: anchor↔oracle band, level↔anchor band, min/max spread, ladder
  capacity ≤ `utilization_max × available reserves`, `update_slot` age cap, and a
  per-window cumulative one-sided flow cap.
- Every account is bound to its vault (PDA seeds / address / mint-owner);
  cross-vault substitution is rejected (`docs/SECURITY_CHECKLIST.md`).
- Circuit breaker is permissionless but **state-only** (not griefable with a
  stale foreign oracle account); `reset_breaker` is admin-only.
- Two-phase keeper `unbond_keeper` with cooldown; slash during the cooldown.
- Keeper math parity (Rust ↔ Python) and 997 bit-exact golden vectors.

We do **not** claim:
- Calibrated profitability. The simulator's passive pool is not yet calibrated to
  the paper's adverse selection; headline E1 magnitudes are **model outputs, not
  results**.
- Live execution quality. Devnet lifecycle + a 600 s live keeper were run
  (`docs/DEVNET.md`, `docs/P3_AUDIT.md`), but **the deployed program may differ
  from HEAD**: F7 (re-deploy + 30-minute keeper) was **SKIPPED** because
  `ARBSWAP_DEVNET_KEYPAIR` was unset. Last devnet evidence: commit `7184cb3`
  (P2 lifecycle) and `36a3c79` (live keeper), dated 2026-10-07; deployed program
  id `CCR33kX4Q9iucvgN4kRga2txmtu32vxy3bXpKyxPdBQx`.
- An independent audit. Same-agent self-review only; external review is required
  before real funds.
- "Exploit-free", "audited", or "as complete as Uniswap".

Program ID (localnet/devnet): `CCR33kX4Q9iucvgN4kRga2txmtu32vxy3bXpKyxPdBQx`

## Layout

```
vault/
  program/       Anchor program (guards, custody, swap engine)
  math/          Pure fixed-point math — shared bit-exactly by program, keeper, simulator
  keeper/        Rust keeper: oracle tick -> arb-math -> update payload
  aggregator/    Jupiter-style AMM quote/swap adapter
simulation/
  reference/     Python high-precision reference math (source of truth)
  sim/           Event-driven simulator, baselines, metrics, study
  analytics/     Indexer + metrics (markouts, LVR, quote-vs-fill gap)
  attackers/     Adversarial bots (E7)
  data/          Download scripts only (raw data gitignored)
frontend/        Vite/React dApp (LP / trader / risk / demo views)
tests/           Integration tests + golden vectors
docs/            BUILD_PLAN.md (the spec), ASSUMPTIONS.md, THREAT_MODEL.md, SECURITY.md
scripts/         Reproduce the P1->P3 replay, devnet deploy
```

Anchor requires the program under `programs/<name>`; `Anchor.toml` points Anchor
at the real source via `[workspace] members = ["vault/program"]`.

## Setup and verification

Toolchain used at setup: solana-cli 4.1.2, anchor 1.1.2, rust 1.98.0
(pinned in `rust-toolchain.toml`), node 24, python 3.12.

Current suite: **148 Rust / 193 Python** tests (single source of truth:
`simulation/data/results/artifacts.json`).

```bash
# Rust: math + keeper + program
cargo test --workspace

# Anchor build (program; requires the Solana SBF toolchain)
anchor build

# Python reference
python3 -m venv .venv && source .venv/bin/activate
pip install -r simulation/requirements.txt
pytest simulation -q

# P1 -> P3 -> P2-compatible replay handoff
./scripts/p1_to_p3_replay.sh simulation/data/raw/binance_SOLUSDT_1s.csv

# Dashboard deps (frontend app skeleton; no source yet)
cd frontend && yarn install
```

## Reproducing the P1 held-out study

`docs/P1_RESULTS.md` is generated by the pre-registered study runner. The
windows, clock, calibration grid/blocks, metrics and studies are fixed in
`simulation/sim/windows.py` *before* any run; the phases below each write an
artifact under `simulation/data/results/`, so a crash never costs a finished
phase.

```bash
# Raw inputs (gitignored): two 6-week 1-second archives, plus 3 aggTrades days
python -m simulation.data.download_vision --kind klines --symbol SOLUSDT \
    --start 2026-08-24 --days 42 --out simulation/data/raw/binance_SOLUSDT_1s_6w.csv
python -m simulation.data.download_vision --kind klines --symbol USDCUSDT \
    --start 2026-08-24 --days 42 --out simulation/data/raw/binance_USDCUSDT_1s_6w.csv
for d in 2026-09-10 2026-09-17 2026-10-01; do
  python -m simulation.data.download_vision --kind aggtrades --symbol SOLUSDT \
      --dates "$d" --bin-ms 100 \
      --out "simulation/data/raw/binance_SOLUSDT_aggtrades_100ms_${d}.csv"
done

# W1 calibration -> W2-W6 held-out -> studies S1-S5 -> docs/P1_RESULTS.md
python -m simulation.sim.study calibrate
python -m simulation.sim.study evaluate
python -m simulation.sim.study studies
python -m simulation.sim.study render
```

`python -m simulation.sim.report` is a separate *synthetic/exploratory* generator
and writes `docs/P1_SYNTHETIC.md`, so it can never overwrite the pre-registered
`docs/P1_RESULTS.md`.

## Ground rules (Build Plan §0)

Python is an independent high-precision reference and generates golden vectors;
Rust `arb-math` is the production integer path used by the on-chain ladder and
keeper. No floats are used on-chain; rounding favors the vault; security is over
speed; never claim an unmeasured result; report losing regimes.

## Documents

- `docs/ARCHITECTURE.md` — component map, data flow, instruction surface, trust boundaries.
- `simulation/analytics/README.md` — P4 indexer, metrics, and dashboard.
- `docs/BUILD_PLAN.md` — the full specification (imported, verbatim).
- `docs/ASSUMPTIONS.md` — what is verified vs assumed (read before coding).
- `docs/FORMULA.md` — the math source map and open decisions.
- `docs/AUDIT_FULL.md` — full evidence-based audit (phases 0-5 + addenda) and findings.
- `docs/SECURITY.md` — tracked headline audit summary and known gaps.
- `docs/THREAT_MODEL.md` — threats, mitigations, tests.
- `docs/SECURITY_CHECKLIST.md` — account-binding table, per-instruction checks, CU table.
- `docs/CLAIMS.md` — claims ledger (status, evidence, limits).
- `docs/RESULTS.md` — results with limits (model output vs on-chain SUPPORTED).
- `docs/HEADLINE.md` — the single claim the evidence supports.
- `docs/DEMO_SCRIPT.md` — 3-minute demo script, live-demo script, backup plan.
- `docs/PITCH_DECK.md` — pitch deck source (rendered to HTML/PDF).
- `docs/P5_REPORT.md`, `docs/P6_AUDIT.md` — phase evidence and gate verdicts.
- `docs/AUDIT_ACHIEVED_VS_PLAN.md` — achieved vs not achieved vs MasterPlan + BuilderPlan, phase by phase, with data.
