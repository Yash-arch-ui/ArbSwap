# SUBMISSION_TEXT.md — short submission description

## One line
ArbSwap: an on-chain, keeper-quoted RFQ-style AMM on Solana (devnet), with an
EWMA volatility / jump detector, a timelocked parameter path, and a live browser
dApp.

## What is built and verified (devnet, test tokens only)
- **On-chain program** `2mwpYHpZ…`: bond-permissionless keeper quote commit,
  two-sided ladder `swap` with a fee split (insurance/keeper/protocol), LP
  `deposit` + warm-up tickets, epoch-settled `request_withdraw`/`crank_epoch`/
  `claim_withdraw`, flow cap, realized-edge breaker, and a timelocked parameter
  path.
- **EWMA volatility / jump detector** with guarded activation (LiteSVM suites +
  frontend read path).
- **Single-sided entry/exit** (`deposit_single`/`claim_withdraw_single`) on the
  vault's own ladder: Python-reference parity (600 golden vectors, 100k
  differential, 20k fuzz), LiteSVM suites, deployed on devnet (browser UI behind
  a fail-closed flag, off by default).
- **Live keeper** (Rust engine + TypeScript driver) committing fresh quotes on
  devnet; a public dApp reading live on-chain state.
- **Frontend** (Vite/React/TS) with the swap page, Vault deposit/withdraw, Risk
  and Overview; reads only on-chain state + `artifacts/public`.

## What is NOT claimed
- The **value thesis (Option 1) is not shown** — reported as a negative result.
- **No independent audit** ("no known issues in self-review, independent audit
  pending").
- The single-sided **browser UI** is behind `VITE_ENABLE_SINGLE_SIDED` (off by
  default). A live single-token smoke (CLI-signed) has passed for both base and
  quote directions; the browser **wallet-signed** path is not yet exercised, so
  the flag stays off (`docs/SINGLE_SIDED_DESIGN.md`, `docs/DEVNET.md`).
- Real-pool E8 value data and the one-hour proxy are not done.
- Tokens are **devnet test tokens**, not real assets.

## How to run (local)
```bash
# backend gates
cargo fmt --all -- --check
cargo clippy -p arb-math -p arbswap-keeper -p arb-aggregator -p arbswap -- -D warnings
cargo test --workspace
.venv/bin/pytest simulation -q
# frontend
cd app && yarn install && yarn lint && yarn test && yarn build
```
Reproduction of the headline chart (no data/keys): `./scripts/headline.sh`.

## Links
- Deployment + evidence: `docs/DEVNET.md`, `docs/VOLATILITY_DEVNET_DEPLOYMENT.md`.
- Claims with evidence: `docs/CLAIMS.md`.
- Design: `docs/ARCHITECTURE.md`, `docs/FORMULA.md`,
  `docs/SINGLE_SIDED_DESIGN.md`.
- Demo: `docs/DEMO_SCRIPT.md`, `docs/DEMO_RUNBOOK.md`.
- Frontend deploy: `docs/DEPLOY_FRONTEND.md`.
- Q&A: `docs/QA.md`.
