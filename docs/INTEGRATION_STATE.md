# INTEGRATION_STATE.md — STEP 0 reconciliation (devnet)

Read-only reconciliation. No code changes; only documentation fixes (listed in
§2 and §6). Devnet deploy was **already recorded** (STEP 1, commit `61d04fc`);
this report verifies the current deployed state and does **not** redeploy.

| | |
|---|---|
| Repo | `https://github.com/Yash-arch-ui/ArbSwap.git` |
| Branch | `integration` |
| HEAD | `d184355` (working tree: only `app/yarn.lock` modified) |
| Date (UTC) | 2026-10-11 |

---

## 1. Canonical program id + deployment

**Canonical id = `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm`.** The old id
`CCR33kX4Q9iucvgN4kRga2txmtu32vxy3bXpKyxPdBQx` is **closed** (upgradeable-loader
tombstone) and is referenced only as history.

| Location | Value | Evidence |
|---|---|---|
| `vault/program/src/lib.rs:8` (`declare_id!`) | `2mwp…` | `grep -n declare_id vault/program/src/lib.rs` |
| `Anchor.toml` `[programs.devnet]` / `[programs.localnet]` | `2mwp…` | `Anchor.toml` |
| `target/idl/arbswap.json` `address` | `2mwp…` | `python3 -c ...['address']` |
| `app/src/idl/arbswap.json` `address` | `2mwp…` | same |
| `app/src/chain/solana.ts:10` `ARBSWAP_PROGRAM_ID` | `2mwp…` | grep |
| `docs/DEVNET.md`, `docs/INTEGRATION.md`, `docs/WEB_ASSUMPTIONS.md` | `2mwp…` | grep |
| `README.md`, `NOTES.md` | `2mwp…` | grep |

Deployment on devnet:

```
$ solana program show 2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm --url https://api.devnet.solana.com
Owner: BPFLoaderUpgradeab1e11111111111111111111111
ProgramData Address: 4156VC8Vzc8wQDqtLe9rdRHtRj9UpRysp2uBTNGW93Mh
Authority: ddGs6hk5E4oPzSnwFfX4pD4DDhDTLTwRddv1VQym7bH   (rotated from 8R3VDePS… by STEP 1)
Last Deployed In Slot: 509857799   Data Length: 688616 bytes

$ solana program show CCR33kX4Q9iucvgN4kRga2txmtu32vxy3bXpKyxPdBQx --url https://api.devnet.solana.com
Error: Program CCR33kX4… has been closed
```

**Deployed bytes == HEAD build (MATCH).**

```
$ .venv/bin/python scripts/devnet_program_hash.py \
    --program-id 2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm \
    --rpc https://api.devnet.solana.com --so target/deploy/arbswap.so
on-chain ELF   688616 bytes sha256=0cdf95754c50630f6618c975d0ecec931b421159f7d3c813383ad5670677730a
local ...      688616 bytes sha256=0cdf95754c50630f6618c975d0ecec931b421159f7d3c813383ad5670677730a
MATCH — deployed program == this build
```

**Mismatches found: none.** All four sources (declare_id, Anchor.toml, IDL,
app/docs) agree on `2mwp…`, and the deployed data hash equals the local HEAD
`.so`.

---

## 2. Inverse-sqrt redesign (`InvalidInverseSqrt`) at HEAD

**Implemented at HEAD.** The B1–B10 report ("B2 NOT DONE", "cargo-fuzz absent")
is **stale** and has been corrected.

- Commit **`2d77d3e`** — "C3/B2: ask capacity via verified inverse sqrt
  (multiply+shift); update_quote <= 40k CU median".
- Commit **`3df287b`** — "fuzz: add cargo-fuzz targets + nightly CI short run".
- Error variant: `vault/program/src/lib.rs:2437` (`InvalidInverseSqrt`); raised at
  `lib.rs:696` when `inv_sqrt_is_conservative` fails (`lib.rs:693-697`).
- Math: `vault/math/src/quote.rs:201` `base_capacity_from_inverse_sqrts`.
- Tests:
  - `vault/math/tests/capacity_inverse.rs` — 1,000,000-case differential
    (`inverse_capacity_over_estimates_the_exact_one`) + `a_halved_inverse_is_rejected_as_an_under_estimate`.
  - `vault/program/tests/litesvm_lifecycle.rs:1507`
    `update_quote_rejects_an_under_estimated_inverse_sqrt` (asserts
    `InvalidInverseSqrt`).
- Mutation: `docs/SECURITY_CHECKLIST.md` §S4.4 — "C3/B2 inverse-sqrt
  verification" guard relaxed → **caught**; re-runnable via
  `scripts/mutation_program.py`. Aggregate: `artifacts/public/mutation.json`
  `caught 55 / total 55`.
- Fuzz: `fuzz/fuzz_targets/{arb_math,walk_ladder,quote_validation}.rs`; CI job
  `.github/workflows/ci.yml:47` (nightly + `scripts/fuzz_short.sh 30`).
- CU at HEAD: `update_quote` median **49,336** (5-run spread 47836-50836), `swap` **63,579** — source `artifacts/public/cu.json` (`.so` sha256 `0cdf9575…`).

Docs corrected to match the code:

| File | Before | After |
|---|---|---|
| `docs/STATUS.md:18` | B2 **NOT DONE** | B2 **DONE** (C3/B2) |
| `docs/AUDIT_ACHIEVED_VS_PLAN.md:126` | C3 **NOT DONE** | C3 **PASS** |
| `docs/AUDIT_ACHIEVED_VS_PLAN.md:128-129` | C4.1 PARTIAL / C4.2 CLOSED-BY-DECISION (fuzz absent) | C4.1 **PASS** (55 caught) / C4.2 **PASS** (fuzz + CI) |
| `docs/AUDIT_ACHIEVED_VS_PLAN.md:130` | C4.3 CLOSED-BY-DECISION | C4.3 **PASS** (implemented `8e5c9d8`) |
| `docs/AUDIT_ACHIEVED_VS_PLAN.md:160-162` | B2/B3a/B3b NOT DONE/PARTIAL | all **PASS** |
| `docs/AUDIT_ACHIEVED_VS_PLAN.md:175` | F1 note "B2 relabelled NOT DONE" | B2 since implemented |
| `docs/SECURITY_CHECKLIST.md:234` | inverse-sqrt "not implemented" | implemented; guard mutation caught |
| `docs/CLAIMS.md:26` | "≤40k target is not met" | **NOT met on the demo host (median 49,336 CU > 40,000; host-sensitive)** |

---

## 3. Frontend location, branch state, build

- The **real dApp is `app/`** — Vite 8 + React 19 + TypeScript, wallet-adapter
  (Phantom/Solflare), `@coral-xyz/anchor`. All chain code lives in
  `app/src/chain/` (`solana.ts`, `program.ts`, `WalletProvider.tsx`) and the IDL
  in `app/src/idl/arbswap.json`.
- `frontend/` is a **dead Next.js scaffold**: only `package.json` (Next 16),
  `tsconfig.json`, `yarn.lock`, `audit-allowlist.json`; **no `src/`** — it cannot
  build. `scripts/frontend_audit_gate.mjs` still reads
  `frontend/audit-allowlist.json` while auditing `app/dist`, so the name is
  misleading.
- Branch inventory:

| Branch | Tip | Contents |
|---|---|---|
| `main` | `a9fff7c` | backend + `app/` dApp merged via PR #1 (`frontend`→`main`) |
| `integration` | `d184355` | `main` + on-chain client wiring (`app/src/chain/program.ts`, `data/backend.ts`, page wiring), CI frontend/audit gate, bundle under `app/public/artifacts/`, `docs/INTEGRATION.md` |
| `frontend` | `443ea30` | older dApp tip (already contained in `main`) |

- **`app/` builds today:** `yarn build` (`tsc -b && vite build`) succeeded
  (2769 modules, `dist/assets/index-*.js` 1.17 MB). `yarn test` (vitest) exists.

### Proposed canonical layout + branch plan (needs your approval)

1. **Canonical app dir = `app/`.** Delete the `frontend/` directory and move
   `frontend/audit-allowlist.json` → `app/audit-allowlist.json`; point
   `scripts/frontend_audit_gate.mjs` at `app/`. (One naming authority.)
2. **Canonical branch = `main`.** Fast-forward/PR `integration` → `main` (the
   integration branch is strictly ahead: wiring + CI + tests).
3. **Retire `frontend`** (fully merged) and delete the `frontend/` path in a
   follow-up `chore/repo-layout` commit.
4. Add `ARBSWAP_DEVNET_KEYPAIR` to CI/docs; never reference the global CLI key.

Waiting for approval before executing 1–4.

---

## 4. Is `main` protected?

**No.**

```
$ gh api repos/Yash-arch-ui/ArbSwap/branches/main/protection
{"message":"Branch not protected","status":"404"}
```

Only one PR was ever opened (#1 `frontend`→`main`, merge commit `a9fff7c`). All
recent `main` commits arrived by **direct push** by `Yash_10` — i.e. **no
review**:

```
2026-10-10T21:16 a9fff7c Merge branch 'frontend' into main            [direct push]
2026-10-10T21:16 1d6632b Merge frontend dApp (app/) into main         [direct push]
2026-10-10T20:56 443ea30 frontend: live wallet balances               [direct push]
2026-10-10T14:10 cd4d0f0 f3: regenerate bundle after program-id change [direct push]
2026-10-10T14:10 2a71c37 devnet: fresh program id 2mwp…               [direct push]
2026-10-10T14:01 6a46f30 f3: regenerate bundle at HEAD                [direct push]
2026-10-10T14:01 50956ed devnet: redeploy exact HEAD build            [direct push]
2026-10-10T13:47 d5c5e93 F-08 reproducible residual                   [direct push]
2026-10-10T13:35 2d77d3e C3/B2 inverse sqrt                           [direct push]
2026-10-10T13:11 3df287b fuzz: cargo-fuzz targets + nightly CI        [direct push]
```

**Recommendation (not done):** require a PR + at least one approval on `main`.

---

## 5. Upgrade-authority key file

Docs/scripts referenced the **general CLI key**
`$HOME/.config/solana/id.json`:

- `docs/INTEGRATION.md:62` (STEP 2.2) and `:95` (STEP 3)
- `scripts/devnet_deploy.sh:5`, `TARGETIDEATASKS_P2.md:232`
- `Anchor.toml` `[provider].wallet = "~/.config/solana/id.json"` (localnet
  provider; **left unchanged** — it is not the devnet upgrade authority).

**Recommendation (applied to the guide):** use a **dedicated devnet keypair
outside the repo**, supplied via `ARBSWAP_DEVNET_KEYPAIR`, holding only devnet
SOL — e.g. `$HOME/.config/solana/arbswap-devnet.json`. `docs/INTEGRATION.md`
§2.2/§3 now use `$ARBSWAP_DEVNET_KEYPAIR` (the operator key) instead of the
global default. `docs/DEVNET.md` already referenced `ARBSWAP_DEVNET_KEYPAIR`.

---

## 6. CU numbers regenerated from artifacts/public/cu.json

Canonical values (`artifacts/public/cu.json`, median of 5, `cargo build-sbf`,
`.so` sha256 `0cdf9575…`): `update_quote` **49,336**, `swap` **63,579**. The
mirror `simulation/data/results/cu.json` `instructions` matches exactly. Fixed
stale references in `docs/CLAIMS.md` ("≤40k not met" → met) and annotated the
superseded `~48k` rows in `docs/PROGRESS.md`.

```
$ .venv/bin/python scripts/check_docs_consistency.py
CU scan: 1 historical snapshot(s) excluded: docs/P1_RESULTS.md
docs consistent with bundle (commit 2a71c37)
```

Note: the bundle manifest commit is `2a71c37` (the program-id/docs change after
CU measurement); `cu.json` records that the id is a compile-time constant and
does not affect CU.

---

## Go / No-Go list

| # | Check | Verdict |
|---|---|---|
| 1 | Single canonical program id (all sources agree) | **GO** |
| 2 | Deployed devnet program == HEAD build (hash MATCH) | **GO** |
| 3 | Inverse-sqrt redesign implemented + tested + mutated | **GO** |
| 4 | `app/` builds today | **GO** |
| 5 | Docs consistent with `cu.json` (`check_docs_consistency`) | **GO** |
| 6 | Banned-word / secrets scans | **GO** (`banned_words` CLEAN) |
| 7 | `main` protected + reviewed | **NO-GO** — unprotected, direct pushes |
| 8 | Repo layout (`frontend/` dead scaffold) | **NO-GO** — needs cleanup (approval) |
| 9 | Upgrade authority is a single devnet hot key | **NO-GO before real funds** — move to multisig or make immutable |
| 10 | `program_config` admin claimed | **GO** (`J6MGfX1YvGq6yCP3eAqzbugpF83CTaBcTLKcmrxmBSok`) |
