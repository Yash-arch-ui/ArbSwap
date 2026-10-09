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
| S4 guard coverage | TODO | | | |
| S5 phase-1 proof | TODO | | | |
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
