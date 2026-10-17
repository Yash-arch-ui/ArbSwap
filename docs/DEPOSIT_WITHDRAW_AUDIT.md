# Deposit / Withdraw Session Audit

**Branch:** `deposit-withdraw` · **HEAD:** `2155731` · **Tag:** `demo-freeze-1`
**Date:** 2026-10-16 (IST) · **Cluster:** Solana devnet (test tokens only)
**Status:** all tasks complete; gate green; pushed (`0 0` vs `origin/deposit-withdraw`).

This is the audit of the single-sided deposit/withdraw final-execution session
(Tasks 0–10). It is a record, not a claim of audit coverage.

---

## 0. Lineage & final state

- Branch `deposit-withdraw` is a copy of `volatility` at `b55196a` (D-000).
- HEAD `2155731`, in sync with `origin/deposit-withdraw`.
- Annotated tag `demo-freeze-1` at HEAD; also tags `pre-single-sided`, `single-sided-1`.
- 24 commits from the branch point (`2cd897c` → `2155731`).
- Untracked root `json` deliberately left (D-001). A stray edit to
  `docs/ARBSWAP_PPT_SOURCE_OF_TRUTH.md` is preserved in `stash@{0}` (not from this session).

## 1. Task-by-task

| Task | Status | What was done | Evidence |
|---|---|---|---|
| 0 state/precheck | DONE | Read-only on-chain + key prechecks | `2cd897c`; D-001…D-008 |
| 1 design | DONE (NO-GO overridden) | Single-sided design + GO/NO-GO | `abfd9c5`; D-011, D-015 |
| 2 reference + vectors | DONE | Python mirror; **600** golden vectors (400 deposit / 200 withdraw); **100k** brute-force differential; **20k** fuzz | `00dee6a`, `f66f54d`; D-018; 287 Rust / 239 Py |
| 3 program | DONE | `deposit_single` + `claim_withdraw_single`; LiteSVM **22**; CU **161,693 / 49,355** | `420e765`, `586b038`; D-015/D-016 |
| 4 frontend | DONE (flag off) | Integer mirror `singleSided.ts`; Deposit “with” / Withdraw “as” toggles; simulate → preview → confirm; fail-closed flag | `f5a76c2`, `fb19468`; D-017; 15 + 18 tests |
| 5 docs | DONE | Design, self-review, risk surfaces, decisions | `98b9c23`, `a7fe957`; D-015…D-018 |
| 6 deploy | DONE (6.1–6.5) | `build-sbf` **933,240 B / `c8725a23…`**; upgrade; post-upgrade smoke; live two-sided lifecycle | `2645c79`; D-019; `docs/DEVNET.md` STEP 3 |
| 7 demo/evidence | DONE | Offline simulator (bundled, no network) + on-chain evidence panel | `59c2924`; 11 tests |
| 8 liveness/proofs | DONE | 8.1 30-min fresh-quote **87%**; 8.2 live Buy/Sell swaps | `2155731` |
| 9 site package | DONE | `DEPLOY_FRONTEND.md`; dist keyless-verified | `0ea089c`, `edee72c`; D-013 |
| 10 submission | DONE | QA / submission / pitch / checklist synced; fresh-clone PASS; tag | `edee72c`; D-014 |
| gate-fix | DONE | Bundle-freshness + secrets green; browser RPC public-only | `81e96c4`, `9134cd1`, `2ef5f41`; D-008/009/010/012 |

## 2. On-chain actions (devnet, test tokens only)

- **Program upgrade** `21VdJsBeRkrX3WVTPx6pdYmfrPCnaqqh4VuudJoJwrQkkmm5tso9o9XD1EtvFs36z7E4Rp5y5F82iAkcQ4Cy3wioB`
  → program `2mwpYHpZ…` now **933,240 B / sha256 `c8725a23…`** (authority `ddGs6hk5…`).
  Rollback ELF retained, **unused**.
- **Two-sided lifecycle (Task 6.5):** deposit `2szDwnxJ…` (slot 511687211) →
  request `28exTx39…` (511689827) → crank `jyy8EHSh…` (511689839) → claim
  `hWenydz7…` (511689856). Token deltas == event == pro-rata; reserves ≥ liabilities;
  `total_shares` Δ = ticket shares.
- **Expired-quote window observed:** slot `511,690,109` was at/past
  `QuoteState.expiry_slot` `511,690,087` (a real lapse between keeper refreshes).
  The on-chain claim path takes **no** `quote_state` account and performs no
  freshness check.
- **Live swaps (Task 8.2):** BuyBase `5zu74zPr…` (511779271, 0.5 USDC) +
  SellBase `5jxap9Nz…` (511779315, 0.005 WSOL), fee 1 bps, simulate-then-submit.
- **Keeper:** tmux `arbswap-keeper`; 87% fresh; attributed author `8R3V…`.

## 3. Verification (at freeze `demo-freeze-1`)

- `cargo fmt --all --check` OK; `clippy -D warnings` OK; **287** Rust tests;
  `cargo build-sbf` reproduced the deployed hash (`c8725a23…`).
- `.venv/bin/pytest simulation -q` → **237 passed / 2 skipped**.
- App: oxlint clean, **171** Vitest pass, `yarn build` OK, `dist` contains no key.
- `check_docs_consistency.py`, `check_bundle_freshness.py`, `banned_words.py`,
  `secrets_scan.py` — **CLEAN**.
- Fresh-clone reproduction **PASS** (committed tree self-contained; no stray files).

## 4. Decisions logged

`D-000` branch · `D-001` stray json · `D-002` keypair paths · `D-003` deployed hash ·
`D-004` expiry_slots · `D-005` volatility pending · `D-006`/`D-007` rollback artifact ·
`D-008`/`D-009` bundle-freshness · `D-010` browser RPC public · `D-011` NO-GO →
`D-015` override · `D-012` no committed `.env.production` · `D-013` CSP unsafe-inline ·
`D-014` stale-item no-churn · `D-016` implementation deviations · `D-017` frontend
gating · `D-018` reference ownership · `D-019` deploy + two-sided scope.

## 5. Docs touched

`PROGRESS.md` (task table + FINAL REPORT), `DEVNET.md` (STEP 3 lifecycle + Task 8.2
swaps), `DECISIONS.md`, `SELF_REVIEW_SINGLE_SIDED.md`, `SINGLE_SIDED_DESIGN.md`,
`QA.md`, `SUBMISSION_TEXT.md`, `PITCH_OUTLINE.md`, `PRE_DEMO_CHECKLIST.md`,
`DEPLOY_FRONTEND.md`, `CLAIMS.md` / runbook.

## 6. Explicitly NOT done (honest)

- Single-token **live** smoke (Task 6.5 (a)/(e)) never run → `VITE_ENABLE_SINGLE_SIDED`
  stays **off** (fail-closed default).
- Browser **wallet-signed** swap: operator-only (CLI-signed evidence recorded instead).
- Option-1 value thesis not shown.
- No independent audit (“no known issues in self-review, independent audit pending”).
- Real-pool E8 value data / one-hour proxy not done.
- Tokens are devnet test tokens, not real assets.

## 7. Compliance / hygiene

Devnet only. No secrets printed or committed. No parameter/authority/vault writes
beyond the planned program upgrade. No force-push / rebase / amend of published
commits. One commit per task; full gate before push. `json` left untracked.

## 8. Cross-branch flags

- The Vault **pending-status UI fix** (`1e17dcd`) was committed on `volatility` /
  `main`, **not** on `deposit-withdraw`.
- `docs/VOLATILITY_DEVNET_DEPLOYMENT.md` on this branch still reads **“APPLY PENDING”**,
  whereas on-chain volatility is applied (`enabled=true`); the reconcile commit
  `7186606` lives on `volatility` / `main`.

> **Resolved in the 2026-10-17 defect-closure session — see §9.**

---

## 9. 2026-10-17 defect-closure session

The audited `demo-freeze-1` baseline (`2155731`) was preserved (tag not moved).
This section records the closure session; it does not rewrite the freeze record.

- **Issue A (quote expiry / claim correctness).** Determined that the two-sided
  `claim_withdraw` is **intentionally quote-free** and settles pro-rata from live
  reserves; `WithdrawTicket` stores only `{owner, shares, epoch}`. Expiry is
  enforced only where a committed quote is consumed (`swap`, `deposit_single`,
  `claim_withdraw_single`). The observed expired window is a **liveness**
  characteristic on quote-consuming paths, which fail closed — not an exploitable
  stale-price claim. No program change (would need a prohibited upgrade). Added
  LiteSVM regression tests: `deposit_single_expiry_boundary_is_exclusive`,
  `claim_withdraw_single_expiry_boundary_is_exclusive`,
  `withdraw_ticket_fixes_shares_only_and_settles_pro_rata`. Decision D-021.
- **Issue B (single-sided live smoke).** Executed live on devnet for **both**
  directions via `scripts/devnet/single_sided_smoke.ts` (all accounting checks
  PASS). CLI-signed only. `VITE_ENABLE_SINGLE_SIDED` **stays off** (browser
  wallet-signed path unexercised). Decision D-020; evidence `docs/DEVNET.md`
  STEP 4.
- **Issue C (cross-branch).** Ported the pending-status UI fix onto this branch's
  superset `VaultPage` (plus single-sided notice sites); reconciled the
  applied-volatility docs after a read-only on-chain re-verification
  (`enabled = true`). Decision D-022.
- **Issue D (keeper liveness).** Kept the 87% **sample** metric as primary;
  added a time-weighted fraction, effective sampling period and max oracle age
  (`fresh_monitor_core.ts`, 15 unit checks). No cadence/economics change. D-023.
- **Issue E (frontend safety).** Single-sided deposit confirm now re-reads quote
  freshness and discards a stale prepared tx; blockhash refreshed before send;
  claim preview uses the ticket-backed share amount (sidebar/preview agree);
  re-entry guards on all submit handlers; claim-preview cancellation classified.
- **Issues F/H (claims + docs).** Updated single-sided status and the active
  devnet configuration in `CLAIMS.md`, `QA.md`, `SUBMISSION_TEXT.md`,
  `PITCH_OUTLINE.md`, `DEVNET.md`; added decisions D-020…D-024. No profitability
  or audit claim added; Option-1 still not shown; no independent audit.
- **Issue G (gates).** `cargo fmt --check`, CI-scoped clippy, `cargo test
  --workspace` (290), `cargo build-sbf` (hash MATCH `c8725a23…`), Python
  `pytest simulation` (237 pass / 2 skip), app oxlint + 179 Vitest + `yarn build`,
  docs/bundle/banned/secrets checks, and the fresh_monitor unit test — see the
  final report in the session record.
