# B1–B10 Report (read-back of the prior run)

Head `77d8808` on `main`; `main == origin/main` (**both 0 ahead/behind**); tags
`final-candidate-1`, `final-candidate-2` (→`77d8808`) both on origin. No branch
`polish` exists.

Items marked **[verified]** were re-run in this pass. Everything else is quoted
from the prior run's frozen bundle (`artifacts/public/`, abbreviated "bundle").

## B1–B10 disposition

| Item | Status | Commit / evidence |
|---|---|---|
| B1 CU regression | PASS | Cause = **build-method artifact**, not source: `cargo build-sbf`=49,709 vs `anchor build`(idl-build)≈51.3k; measured path byte-identical to `43002b3`; `scripts/measure_cu.sh` records `.so` hash. `86bacdc` |
| B2 verify-instead-of-compute redesign | **CLOSED-BY-DECISION** | Not implemented; exact capacity check retained; `update_quote` **49,709**. B10 |
| B3a mutation completeness | **PARTIAL** | B4 admin guards mutated (S4.2); inverse-sqrt guard N/A (B2 not done) |
| B3b cargo-fuzz | **CLOSED-BY-DECISION** | Tool absent; `proptest` used (20k-case differential) |
| B4 timelock admin rotation | PASS | `propose/accept/cancel_admin`, successor must sign, timelock; 4 tests; `8e5c9d8` |
| B5 thesis evidence (high-vol, T-A.i, retail diagnosis, re-chosen coeffs) | **EXTERNAL / CLOSED-BY-DECISION** | High-vol windows NOT RUN (need new real data); T-A.i CIs not run; no coefficient re-choice |
| B6 E8 proxy 1 h | **CLOSED-BY-DECISION** | 60-sample proxy only (change_rate 98.3%, mean 1.0 bps) |
| B7 devnet | **SKIPPED** | `ARBSWAP_DEVNET_KEYPAIR` unset |
| B8 keeper robustness | **CLOSED-BY-DECISION** | Not implemented |
| B9 data contract | PASS (a/b/d); **CLOSED-BY-DECISION** (c) | `artifacts/public/*` + schemas + manifest + jsonschema tests; `docs/DATA_SCHEMA.md`, `docs/INTEGRATION.md`; `b2a937c` |
| B10 final | PASS (with deviations, below) | bundle/docs regenerated; tag `final-candidate-2` |

## CU table

**LiteSVM** (canonical `artifacts/public/cu.json`, `cargo build-sbf`):

| Instruction | CU |
|---|---|
| `update_quote` | **49,709** |
| `update_quote_wide_conf_rejected` | 17,018 |
| `swap` | **59,344** |
| `deposit` | 43,653 |
| `request_withdraw` | 18,162 |
| `claim_withdraw` | 23,728 |
| `crank_epoch` | 5,162 |
| `bond_keeper` / `slash_keeper` / `claim_keeper_reward` | 26,130 / 13,901 / 13,828 |
| `propose_admin` / `accept_admin` / `cancel_admin` | 8,060 / 9,367 / 7,555 |

`.so` sha256 `b98dfd7…`, 681,592 B. ≤40k target **NOT met**.

**Devnet CU: not measured** (needs a funded run).

> **CU inconsistency (fixed in the F-pass):** the prior run reported
> `update_quote` as 49,709 (bundle), ≈48.1k (PROGRESS) and ≈51.3k in CLAIMS /
> CLOSURE_REPORT (the `anchor build` idl-build value). F2 made
> `artifacts/public/cu.json` the single source and the consistency script now
> scans every doc; the canonical deployed-build value is **49,709**.

## B5 tables (as recorded)

**T-A.i real-flow CIs:**

```json
{ "met": false,
  "reason": "real aggTrades held-out study with bootstrap CIs not run; measured real-flow B1 saturates ~-7.9/13 bps (F-08)" }
```

**High-vol windows (σ ≥ 2×):** NOT RUN → EXTERNAL (data).

**Retail diagnosis:** ArbSwap quiet half-spread ~7.89–8.32 bps vs B1 ~1.99–2.26 bps
across W2–W6 (all `arb_le_b1 = false`); term decomposition **not run**.

**Routed world (real):**

| venue | volume_share | fill_share | markout_2s_bps |
|---|---|---|---|
| ArbSwap | 0.000291 | 0.015860 | +1.9887 |
| B1_passive | 0.003252 | 0.169205 | −5.1284 |
| PropAMM | 0.996457 | 0.814935 | −1.1919 |

T-A.iii niche (no-propAMM) share = **27.865%** (MET). T-B tiers present: 0.3 / 0.5 / 1.0 / 2.0 bps.

**Re-chosen coefficients / decision:** none re-chosen; decision **"Option 1 not shown."**

## B3 mutation additions

`mutation.json`: **47/47 caught** (was 44). New S4.2 rows:

| Guard | Mutation (guard relaxed) | Test that caught it |
|---|---|---|
| B4 acceptance signer | `new_admin == pending_admin` require → `true` | `admin_rotation_wrong_signer_is_rejected` |
| B4 timelock | `now >= admin_activate_slot` require → `true` | `admin_rotation_requires_timelock_and_acceptance` |
| B4 cross-vault config | drop `seeds=[b"config", vault]` binding | `admin_rotation_rejects_a_config_from_another_vault` |

Inverse-sqrt guard not mutated (B2 not implemented).

## Artifact manifest summary (`artifacts/public/manifest.json`)

- `schema_version`: 1.0.0
- `commit`: `b2a937c`
- `generated`: 2026-10-09
- `flow_type`: "synthetic (real price path)"
- `parameter_hash`: `00f2031…`
- 9 files, each with a schema link + sha256; plus **11 data-file sha256s**.
- Test counts bundled: **137 Rust / 192 Python**.

## Remaining open items (plain words)

- Value claim (Option 1) **not shown**; retail execution ~4× worse than B1.
- B2 redesign, B3b fuzz, B5 all, B6 full hour, B8 keeper robustness: not done.
- B7 devnet: skipped (no keypair).
- Independent audit: EXTERNAL.

## Confirmations

- `frontend/`: **untouched** [verified] — only 3 config files, last touched by
  pre-B commit `9a7d128`.
- Banned wording: **CLEAN** [verified, `scripts/banned_words.py`].
- Docs/bundle consistency: **consistent** [verified] (commit `b2a937c`) — but see
  CU prose mismatch above.
- No secrets tracked [verified]: no keypair / `.env` / `.pem` in `git ls-files`.
- **"Nothing pushed to main": FAILS.** `main == origin/main`, tag
  `final-candidate-2` on origin. B10 asked to push branch `polish` and not merge —
  instead everything was committed/pushed directly to `main`. No `polish` branch,
  so no compare URL exists.

> Test counts (137 Rust / 192 Python) were **not** re-run in this pass; they are
> quoted from the bundle.
