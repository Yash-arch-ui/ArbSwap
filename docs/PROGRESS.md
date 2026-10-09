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
| S1 math correctness | TODO | | | |
| S2 CU reduction | TODO | | | |
| S3 breaker + keeper gaps | TODO | | | |
| S4 guard coverage | TODO | | | |
| S5 phase-1 proof | TODO | | | |
| S6 frontend | TODO | | | |
| S7 devnet | TODO (conditional) | | | |
| S8 submission | TODO | | | |

## Notes / deviations

- Rule 2 said "create branch dev"; the final instruction said "do everything on
  main only", so no branch was created and nothing is pushed to main.
- Banned wording must not appear anywhere; use "no known issues in self-review,
  independent audit pending".
