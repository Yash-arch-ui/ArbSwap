# S2-31 Report Card — Keeper Liveness & Epoch Check (Devnet)

Maintained alongside the task. Status: **IN PROGRESS**. One commit per task; gate
before push. Devnet only; no swaps/asset movement; no protocol rule changes.

## Prechecks

| # | Check | Result |
|---|---|---|
| P0 | `pre-demo-backup` tag on origin | Created at HEAD `f1e33d5` and pushed |
| P1 | Cluster guard (primary + fallback genesis) | Both `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` ✔ |
| P2 | Program hash MATCH; id; vault Active; QuoteState 897 B; v28; author `8R3V…`; expired; `min_bond=0` | ✔ (slot 510719230) |
| P3 | Keeper `8R3V…` balance ≥ 1 SOL; no running keeper | 11.492523307 SOL; none running ✔ |
| P4 | Hermes entitlement for SOL/USD feed | HTTP 200; latency 1063 ms ✔ |

Secret hygiene: `.ENV` gitignored ✔; no `api-key=` in tracked files ✔ (test
fixtures use `key=SECRET`); `logs/` now gitignored ✔.

## Task status

| Task | Status |
|---|---|
| A — Epoch check | **DONE** — `docs/EPOCH_CHECK.md`. `epoch_slots=1500` (immutable), earliest claim ≈ immediate via one overdue `crank_epoch`; `max_staleness_seconds` changeable but not changed; no proposal needed/possible. |
| B — Keeper latency measurement | pending |
| C — Keeper-side optimization | pending |
| D — Supervised 30-min live run | pending |
| Gate | **GREEN** (commit `25b5b38`): fmt; CI-scoped clippy; `cargo test --workspace`; `pytest simulation` 222 passed/2 skipped; app 60 tests + lint + build; keeper TS 24/9 + tsc; docs-consistency; banned clean; secrets clean; no `api-key=` tracked. |
| Decision rule (GREEN/AMBER/RED) | pending (needs Task D) |

## Gate restoration note

Main was pre-existing RED on the CI gates. Restored (in `25b5b38`): the Python
reference + parity test aligned to the S2-24 confidence floor; clippy lints in the
keeper lib and math tests; banned-word rewording; `logs/` gitignored; test fixtures
no longer contain a literal `api-key=`.


## Deliverables

- [ ] `docs/EPOCH_CHECK.md`
- [ ] `docs/KEEPER_LATENCY.md`
- [ ] `docs/DEMO_RUNBOOK.md` (Epoch parameter + operator steps)
- [ ] `docs/DEVNET.md` appended with run evidence
- [ ] `artifacts/devnet_keeper_run.json` (summary stats only)

## Hard-rule confirmations

- No protocol rule change: **to be confirmed at the end**.
- No swaps/deposits/withdrawals/claims/transfers: **to be confirmed**.
- No secrets committed; API key redacted: **confirmed so far**.
