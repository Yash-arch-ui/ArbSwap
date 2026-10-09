# PROGRESS.md — ArbSwap principal-engineer run

Working on **main** (per explicit instruction: no new branch, nothing pushed to
main). Tag `p2-claim-align-v1` created at baseline.

## Versions (baseline)

| Tool | Version |
|---|---|
| rustc / cargo | 1.98.0 |
| anchor-cli | 1.1.2 |
| solana-cli | 4.1.2 (Agave) |
| python | 3.12.3 |
| node | v24.10.0 |
| anchor-lang / anchor-spl | 1.2.1 |
| pyth-solana-receiver-sdk | 2.0.0 |
| litesvm | 0.16.0 |

Baseline commit: `cc41f53` (tag `p2-claim-align-v1`). Baseline gate: fmt + clippy
(incl. program) clean, **125 Rust tests**, `anchor build` OK, **164 Python tests**.

## Stage log

| Stage | Status | Commits | Tests | Open items |
|---|---|---|---|---|
| S0 baseline/hygiene | DONE | (this commit) | 125 Rust / 168 Py | — |
| S1 math correctness | DONE (no bug found) | (this commit) | 125 Rust / 169 Py | suspected div_rem bug NOT reproduced; 1M/op differential green |
| S2 CU reduction | PARTIAL | (this commit) | 125 Rust / 169 Py | update_quote 48,296 (<50k, target 40k not met); swap 61,482 (<=70k). Reciprocal-verify redesign deferred (payload change). |
| S3 breaker + keeper gaps | DONE | (this commit) | 129 Rust / 173 Py | simulator edge tracker; 0 honest trips (W2-W6, jumps, latency); defaults max_edge_loss_bps=50, max_anchor_dev_bps=25 |
| S4 guard coverage | DONE | (this commit) | 132 Rust / 172 Py | 31-guard mutation table (all caught); full-action state machine; proptest present |
| S5 phase-1 proof | PARTIAL | (this commit) | 132 Rust / 172 Py | pre-reg amendment 2; fresh routed table; HEADLINE.md = Option 2; METHODOLOGY.md; E8 NOT DONE; no fresh full-study re-run |
| S6 frontend | TODO | | | |
| S7 devnet | TODO (conditional) | | | |
| S8 submission | TODO | | | |

## STOPPED AT S2 (context nearly full)

Resumed state: S0 DONE, S1 DONE (no bug), S2 PARTIAL. Gate green: 128 Rust /
169 Python, anchor build OK, secrets clean, on `main` (3 commits ahead of
origin/main, not pushed).

Remaining: S3 (breaker trip-rate + keeper offline gaps), S4 (mutation of every
guard + fuzz/state-machine), S5 (Phase-1 value proof), S6 (frontend), S7
(devnet, conditional on `ARBSWAP_DEVNET_KEYPAIR`), S8 (submission package).

## Notes / deviations

- Rule 2 said "create branch dev"; the final instruction said "do everything on
  main only", so no branch was created and nothing is pushed to main.
- Banned wording must not appear anywhere; use "no known issues in self-review,
  independent audit pending".

## P2 (on-chain program) status — full audit vs the idea document

| Task (BuilderPlan §12 P2) | Status |
|---|---|
| T2.1 Anchor accounts/config/errors/events | DONE |
| T2.2 deposit / request_withdraw / claim_withdraw / crank_epoch (warm-up + queue) | DONE (LiteSVM) |
| T2.3 update_quote with all guards | DONE (LiteSVM; Pyth verified) |
| T2.4 swap via arb-math; fee split | DONE (LiteSVM) |
| T2.5 breakers / pause / timelocked set_params | DONE (LiteSVM) |
| T2.6 local validator + invariant tests | DONE (132 Rust tests) |
| T2.6 devnet deploy | DONE (CCR33..., admin claimed) |
| **P2 gate: full deposit->update->swap->withdraw loop ON DEVNET** | **DONE** — full lifecycle confirmed on devnet (commit `b099940`; signatures in docs/DEVNET.md) |

Resolved: `scripts/devnet/post_pyth.ts` uses the official
`@pythnetwork/hermes-client` + `@pythnetwork/pyth-solana-receiver` to post a
fully verified SOL/USD update; `arbswap-e2e loop` consumes the `PriceUpdateV2`
and runs the whole lifecycle. Gate PASSED.

## P6 (Story and submission) — DONE

Gate PASSED: `./scripts/headline.sh` reproduces the headline chart from the
README with no data and no API keys.

- T6.1 `simulation/sim/headline.py` + `scripts/headline.sh` +
  `simulation/sim/test_headline.py` → `docs/headline_chart.svg`
  (ArbSwap vol 0.0%/fill 1.6%/mkt +1.99; B1 fill 16.9%; PropAMM vol 99.6%).
- T6.2 `docs/RESULTS.md` (results with limits); `docs/METHODOLOGY.md` E8 → PARTIAL.
- T6.3 `docs/DEMO_SCRIPT.md`; `docs/demo_backup.html` (auto-play) +
  `docs/demo_backup.mp4` (36 s, 1280×720, h264); `simulation/analytics/backup.py`
  + `test_backup.py`; `scripts/record_demo.sh`.
- T6.4 `docs/PITCH_DECK.md` → `docs/pitch_deck.html` + `docs/pitch_deck.pdf`;
  `scripts/render_deck.sh`.
- Reconciled stale claims: `docs/CLAIMS.md` (devnet + live keeper + demo now
  SUPPORTED), README P2/P3 rows, `docs/DEVNET.md` superseding note.
- Gate: 133 Rust / 183 Python tests, fmt + clippy clean, `anchor build` OK.

## Closure pass (C1-C6) — on `main` per instruction

- C1 single source of truth: `scripts/export_artifacts.py` → `artifacts.json`;
  `render_docs.py`; `check_docs_consistency.py` (CI). CU corrected (51,296 /
  61,513). PASS.
- C2 pre-registered thesis (Amendment 3): `docs/THESIS.md` — **Option 1 not
  shown**; T-A.iii no-propAMM share 27.9%; calibration CLOSED-BY-DECISION.
- C3 NOT DONE (reciprocal-sqrt redesign is roadmap); CU re-measured.
- C4: prior art, A-08 CLOSED-BY-DECISION, HWM fee report, E8 proxy, A-24 admin
  rotation CLOSED-BY-DECISION, cargo-fuzz CLOSED-BY-DECISION, devnet keeper
  SKIPPED (no keypair).
- C5 frontend NOT DONE.
- C6 handoff `docs/AUDIT_PACKAGE.md`; regenerated
  `docs/AUDIT_ACHIEVED_VS_PLAN.md`; claims + banned-word scan CLEAN; fresh-clone
  reproduction PASS; tag `final-candidate-1`.
- Gate: 133 Rust / 189 Python, fmt+clippy clean, anchor build OK.

## Backend polish (B1-B10) — on `main`

- **B1 CU regression — PASS (cause named).** `update_quote` 48,296 → 51,296 was a
  **build-method artifact**, not a source regression: `cargo build-sbf`
  (661 KB, no `idl-build`) = 48,296; `anchor build` (744 KB, `idl-build`) =
  51,296. The program source in the measured path is byte-identical to `43002b3`
  (diff of `update_quote`/`Config`/`QuoteState`/fixture/`quote_update` empty).
  Fix: `scripts/measure_cu.sh` builds in a clean dedicated target dir and records
  the `.so` hash; canonical `update_quote` **48,079**, `swap` **59,162**.
