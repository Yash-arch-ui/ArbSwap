# ArbSwap — Demo Readiness & Submission Package

Prepared for a hackathon demo + technical review. **Evidence frozen, not
fabricated.** Local + read-only Devnet only; no transaction was submitted in this
task. Canonical runbook: `docs/INTEGRATION.md`.

## 1. Evidence matrix (verified vs unproven)

### A. Verified on-chain history (Devnet, historical — always label as historical)
| Item | Evidence | What it establishes |
|---|---|---|
| Program deployed/upgraded | deploy `58izq9Fm…`; S2-9 `29zPYqTK…`; S2-23 upgrade `5ub1Su7ZfZ8iLLxTkC6rda3LdCs5ZAkeGsin8sJgdajDzstmr1tahGvyNPiBHivdhxGYNYYFQYMZKLhzfy99sZAo` | The deployed program is the tested artifact |
| Deployed ELF == local build | `scripts/devnet_program_hash.py` → **MATCH** (sha256 `b4df2b0f…f7096`, 769984 B) | Reproducible build identity |
| Deposit executed | `N6XoMGrpp84wCQvCvqsLV89wnwhmQjvLNRcc4nwwimXHAuniLCupZaJzCPoSfPst83c4Rk9ErXUnkUsQ7PX3voq` (S2-14) | LP deposit path works on-chain |
| Swap executed | `51TkKqfi9bt8QqpKKxJZnN2nyFv1HAMnSGW2mjctDYDEpuDi4Roch43RJapj3poz8H8DqYCfmE8QFSrbxVHx9TUC` (S2-15, BuyBase 1.75 USDC → 0.016290295 SOL) | End-to-end swap path works on-chain |
| QuoteState migration 865→897 | `qmTocoCx36EpQL6qTdTE4GAWhuW8vztXJouGuCyah76PEcC66sLdhsdpFP7pPCeTYem8Akfx8nhduefTSpV5qrh` (S2-23) | Migration is permissionless |
| Attributed quote committed | push+commit `4ABgziXU253Wnh6vUnTY1ijEBwyi4mn9GfGYs5g4KbU8P1wcLqyRRTD3SnsuBfXy5Svmjzt3jBDWfdGVpDVPwiVX` (S2-23, v18→v19) | Staged quote + attribution works live |
| Repeated quote maintenance | S2-24 run: **16** `COMMITTED_AND_VERIFIED` cycles, QuoteState v24→v28 | Keeper pipeline works when latency allows |

### B. Current on-chain state (read-only, this task)
Program hash **MATCH**; vault `8yvFBv9…` **Active**; config `min_bond = 0`
(**permissionless**); QuoteState `5MsGbdHv…` **897 B**, **v28**, author `8R3VDePS…`,
**expired** at read slot 510711829. The quote is **not** fresh → the app shows
`Expired` and disables swaps (fail-closed). No price is fabricated.

### C. Local verification (this task, actual results)
| Suite | Result |
|---|---|
| `cargo fmt --all --check` | clean |
| `cargo test --workspace` | green (program lifecycle **100**, recovery 8, oracle 3, security 3, breaker 2, fixtures 1; keeper **45**; math incl. regressions) |
| `yarn test` (app) | **54 passed** (6 files) |
| `yarn lint` / `yarn build` | clean / clean |
| Keeper TS `rpc.test` / `keeper_commit.test` / `tsc --noEmit` | 24 / 9 / clean |
| Browser E2E (`app/e2e/browser-smoke.mjs`) | all tabs rendered, **0 app exceptions**, screenshots captured; 2 console lines are web3.js **429 retry** notices (RPC rate limit), not app errors |
| Analytics `pytest` | **34 passed** |
| Docs consistency | pass |
| Secrets scan | **CLEAN** |
| Bundle freshness | **STALE** (source changed since bundle commit `e01601f`) — see §5 |

### D. Incomplete / unproven (stated honestly)
| Item | Status |
|---|---|
| Independent keeper B live commit | **INCOMPLETE — PROVIDER/PYTH LATENCY.** B (`6FqSc5vm9vdVDLRVbJZ9cYx4Mh4sVtCpM5x6qaLknB2G`) is provisioned + funded; 12-attempt bounded run and a Keeper-A control both committed **0** quotes (3–8 s pipeline vs 2 s freshness). Not a code or authorization defect |
| Decentralization "proof" | `min_bond=0` permissionless + `QuoteState.keeper` attribution are on-chain-proven; **multi-keeper live alternation is not**. Do not present it as a successful decentralization test |
| Economic thesis (LVR/markout superiority) | Model/replay output only; **not** a live profitability proof |
| Bundle freshness gate | stale; needs regeneration |

## 2. Recommended demo sequence (≈3–5 min)

1. **Problem + approach:** latency arbitrage vs LVR; ArbSwap = permissionless
   pooled capital + volatility/inventory-aware quoting on Solana.
2. **Architecture + lifecycle:** Pyth (Hermes) → Rust quote engine → `stage_quote`
   (pending PDA) → Wormhole VAA + Pyth push + `commit_quote` (atomic) → `swap`
   validates version/expiry/`min_out`.
3. **Live app (read-only):** Overview + Swap tabs show the **real** committed
   quote (v28) and its **Expired** status; swaps disabled with a clear reason.
   Balances belong to the connected wallet. No fabricated price.
4. **Historical evidence:** show the executed deposit + swap signatures on
   explorer — explicitly labeled as past on-chain history, distinct from now.
5. **Risk page:** `KEEPER: PERMISSIONLESS`, keeper-rewards panel (connected
   wallet's own entitlement), on-chain guard status.
6. **Analytics:** static research artifacts (labeled model/replay); the optional
   on-chain export is shown as unavailable.
7. **Honesty close:** the independent-keeper live proof is blocked by provider
   latency; the design and permissionless path are proven on-chain and in LiteSVM.

**Fallback (no RPC / no browser):** use the recorded assets in `docs/`
(`demo_backup.html`, `demo_backup.mp4`, `pitch_deck.html/pdf`) and the historical
signatures above. Clearly mark replay/recording as non-live.

## 3. Submission package (technical narrative)

**Core innovation (not a plain AMM clone):**
- **Staged, oracle-validated quoting:** `stage_quote` + Pyth push + `commit_quote`
  are atomic; the ladder is bound to the *verified* price (anchor-deviation +
  step guards), so a keeper cannot quote arbitrarily far from Pyth.
- **Inventory-aware, volatility-aware quoting** with depth throttling and LVR
  budget, all enforced on-chain by capacity/inventory/flow bounds.
- **Bounded swaps:** version/expiry/`min_out`/flow-cap checks; revert rather than
  fill worse.
- **Permissionless, attributable keepers:** `min_bond=0` open quoting; the quote
  author is recorded in `QuoteState.keeper` and keeper rewards are per-keeper
  (`KeeperReward` PDA), with immutable eligibility.

**Trust boundaries:** Solana + Pyth/Wormhole are trusted external infra; the
protocol does not rely on an ArbSwap-operated backend. The single-key upgrade
authority and discretionary slashing are the remaining centralized controls.

**Implemented & demonstrated:** program, math, staged quote lifecycle, migration,
permissionless authorization + attribution, frontend reads/gating/builders, keeper
tooling + RPC failover, tests (Rust/LiteSVM/TS/browser).

**Experimental / unproven:** live independent-keeper commit (provider latency);
economic superiority (model/replay only); full multi-keeper live operation.

**Methodology/limits:** `docs/RESULTS.md`, `docs/METHODOLOGY.md`, `docs/CLAIMS.md`.
Do not claim the research proves economic superiority — the recorded evaluation
does not support that.

**Bottlenecks / next steps:** (1) lower-latency RPC / co-located Hermes to meet the
2 s window; (2) multisig upgrade authority + objective slashing; (3) connected-
wallet browser E2E; (4) regenerate the artifact bundle.

## 4. Reproduce locally

```bash
# validation suite
cargo fmt --all --check && cargo test --workspace
cd app && yarn test && yarn lint && yarn build
cd ../scripts/devnet && npx tsx rpc.test.ts && npx tsx keeper_commit.test.ts
.venv/bin/python -m pytest simulation/analytics/tests -q
.venv/bin/python scripts/check_docs_consistency.py && .venv/bin/python scripts/secrets_scan.py

# live app
cd app && yarn dev        # then open the printed URL (Devnet)

# read-only live state
cd scripts/devnet && npx tsx keeper_inspect.ts

# browser E2E (see docs/S2_27_BROWSER_E2E.md)
APP_URL=http://localhost:5173/ node app/e2e/browser-smoke.mjs
```

## 5. Live infrastructure limitations (exact)

- **Provider/Pyth latency:** the 3-transaction staged pipeline (stage + Wormhole
  VAA + Pyth push/commit) took **3–8 s** from `publish_time` to commit execution,
  vs the deployed **2 s** freshness rule. Only the public
  `api.devnet.solana.com` is configured (no `ARBSWAP_RPC_URL`/fallbacks). Hermes
  publish-age p50 665 ms / p90 1242 ms. **No protocol rule was weakened.**
- **Wallet-adapter connection:** `ConnectionProvider` is primary-endpoint bound;
  the app's reads and tx construction use the failover pool. Documented, not
  replaced.
- **Bundle freshness gate** is stale (source changed since `e01601f`); regenerate
  with `scripts/measure_cu.sh && python scripts/export_artifacts.py && python
  scripts/publish_artifacts.py` before a formal submission if the CI gate matters.

## 6. Pre-submission checklist

- [ ] Quote the **current** on-chain state (reread; do not present v28 as active).
- [ ] Label historical txs, replay/model output, and mock UI states clearly.
- [ ] Do not claim independent-keeper success or economic superiority.
- [ ] Secrets/`.ENV`/keypairs never in slides, screenshots, or the bundle.
- [ ] (Optional) regenerate the artifact bundle to clear the freshness gate.
- [ ] Have the demo fallback (recording/HTML) ready in case RPC is unavailable.
