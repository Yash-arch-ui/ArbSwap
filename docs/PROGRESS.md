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
| S2 CU reduction | PARTIAL | (this commit) | 125 Rust / 169 Py | update_quote ≈48k (<50k, target 40k not met); swap ≈59k (<=70k). Reciprocal-verify redesign deferred (payload change). |
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
  `render_docs.py`; `check_docs_consistency.py` (CI). CU corrected (48,209 /
  59,327). PASS.
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

- **B1 CU regression — PASS (cause named).** The `update_quote` difference was a
  **build-method artifact**, not a source regression: `cargo build-sbf`
  (661 KB, no `idl-build`) = 48,209; `anchor build` (744 KB, `idl-build`) =
  ≈51.3k. The program source in the measured path is byte-identical to `43002b3`
  (diff of `update_quote`/`Config`/`QuoteState`/fixture/`quote_update` empty).
  Fix: `scripts/measure_cu.sh` builds in a clean dedicated target dir and records
  the `.so` hash; canonical `update_quote` **48,209**, `swap` **59,327**
  (`artifacts/public/cu.json`).

- **B4 timelocked admin rotation — PASS.** `propose_admin` / `accept_admin` /
  `cancel_admin` (Config gains `pending_admin` + `admin_activate_slot`; successor
  must sign; timelocked `TIMELOCK_SLOTS`). Tests: `admin_rotation_*` (4) incl.
  wrong-signer, cancel, cross-vault config. Mutation rows S4.2. Squads v4 id
  VERIFIED (A-25). CU: propose/accept/cancel = 8,060 / 9,367 / 7,555.

- **B9 data contract for the frontend — PASS (a/b/d), CLOSED-BY-DECISION (c).**
  `scripts/publish_artifacts.py` → `artifacts/public/*.json` + `artifacts/schema/*.json`
  + `manifest.json` (schema version, commit, data hashes, parameter hash, flow
  type); validation tests `simulation/analytics/tests/test_artifacts_public.py`
  (jsonschema). Docs: `docs/DATA_SCHEMA.md`, `docs/INTEGRATION.md`. Read-only HTTP
  server CLOSED-BY-DECISION (static files suffice). `frontend/` untouched.

## Final fix pass (F1–F7) — on `main`

- **F1 status honesty — PASS.** `docs/STATUS.md` defines CLOSED-BY-DECISION
  (needs a written technical reason + evidence). B2 (compute redesign) and B6
  (one-hour E8 proxy) are relabelled **NOT DONE** (effort only); high-volatility
  windows are no longer EXTERNAL (they are run, F5); B8 is **PASS (offline)**.
  `CLOSURE_REPORT.md`, `AUDIT_ACHIEVED_VS_PLAN.md`, `CLAIMS.md` updated.
- **F2 CU single source — PASS.** All CU rendered from `artifacts/public/cu.json`;
  `scripts/check_docs_consistency.py` scans every doc and bans stale tokens.
  Canonical `update_quote` **48,209**, `swap` **59,327** (`cargo build-sbf`).
- **F3 bundle freshness — PASS.** Bundle regenerated at HEAD;
  `scripts/check_bundle_freshness.py` added to CI. Re-ran suites: **148 Rust /
  193 Python**; mutation table **51** (47 + 4 new F6 rows).
- **F4 retail diagnosis — PASS.** `diagnosis.json`: dominant term **volatility
  (~42%)**. Router `volume_share` counted attempted notional (rejected orders) —
  fixed + regression test; affected numbers superseded. Amendment-6 volatility
  re-choice → **no feasible candidate** (frozen params retained).
- **F5 real-flow evidence — PASS (T-A.i not met, reported).** `f5_real_flow.json`:
  2026-02-06 (σ 3.79×σ_ref), 2026-01-31 (σ 2.52×σ_ref) + 3 archived days;
  bootstrap 95% CIs above zero on **0/5** days. Honest negative result (F-08).
- **F6 keeper robustness — PASS (offline).** `prevalidate_quote` mirrors the
  on-chain bounds; 12 keeper tests (dropped tx, expired blockhash, duplicate
  send, out-of-order slot, stale/wide oracle, clock skew, fail-closed expiry);
  4/4 F6 mutation guards caught.
- **F7 devnet — SKIPPED.** `ARBSWAP_DEVNET_KEYPAIR` unset; README records the
  last devnet evidence (commits `7184cb3`, `36a3c79`, 2026-10-07) and notes the
  deployed program may differ from HEAD.
- Gate: fmt + clippy -D warnings clean, `anchor build` OK, docs consistency +
  bundle freshness + banned-word + secrets scans clean. Tag `final-candidate-3`.

## Idea-fidelity pass (I1–I5) — close the MasterPlan/BuilderPlan protocol gaps

Worked on `main`. All five code-level gaps named in the idea review are now
implemented, tested, and synced (account space, FORMULA.md, CU, mutation table,
bundle).

- **I1 open bonded keeper network (M7/§8.7) — DONE.** `update_quote` is
  permissionless when `config.min_bond > 0` (any bond-qualified keeper; allowlist
  only in the `min_bond == 0` MVP path). Test
  `permissionless_bonded_keeper_may_quote_when_min_bond_is_set`; mutation S4.4.
- **I2 LVR-budget depth rule (R16/§5.10) — DONE.** `lvr_depth_budget` (Python) and
  `lvr_depth_budget_bps` (Rust keeper) implement
  `V_active ≤ 8(R−gas)/σ²`; wired into the depth throttle with neutral defaults so
  historical study numbers are unchanged. Tests: doubling σ quarters the budget.
- **I3 volatility kill-switch (M9/§8.3) — DONE.** `max_vol_q64`/`max_vol_short`
  zero the depth (stop quoting) on a spike. Tests in keeper + reference.
- **I4 per-update spread step (honest execution §7.3) — DONE.** `Config`
  `max_spread_step_bps` bounds |Δhalf_spread| per update (`0` disables). Test
  `spread_step_is_bounded_per_update`; mutation S4.4.
- **I5 flow accumulator (§5.9) — DONE.** `QuoteState.flow_n: i128` records signed
  net base sold and resets on every `update_quote`. Test
  `flow_accumulator_tracks_net_base_and_resets`; mutation S4.4.
- Sync: `Config` +4 B, `QuoteState` +16 B, `PendingConfig` +4 B (space
  expressions + `account_spaces_match_serialized_sizes`); `docs/FORMULA.md`;
  `docs/SECURITY_CHECKLIST.md` S4.4; CU regenerated; bundle regenerated.
- Gate: fmt + clippy `-D warnings` clean, `anchor build` OK, **154 Rust / 198
  Python** tests, docs consistency + freshness + banned-word + secrets scans
  clean. Tag `final-candidate-4`.

Remaining (unchanged): the *value thesis* (Option 1) is still not demonstrated;
E8 real-pool data, one-hour proxy, and independent audit remain NOT DONE /
EXTERNAL; the frontend dApp is implemented on branch `frontend` (mock data,
old layout) but not integrated with `artifacts/public`.
