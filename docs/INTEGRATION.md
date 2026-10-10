# INTEGRATION.md — backend ↔ frontend, step by step

This is the operator's guide to wiring the ArbSwap backend (Anchor program +
keeper + artifact bundle) into the frontend dApp (`app/`), end to end. It is a
**checklist**, in order. Nothing here changes the backend; the backend is the
source of truth.

Branch layout:
- `main` — backend (`vault/`, `simulation/`, `scripts/`, `artifacts/`, `docs/`,
  `fuzz/`) + the frontend dApp (`app/`).
- `integration` — the same, plus the on-chain client and page wiring
  (`app/src/chain/program.ts`, `requestWithdraw`/`claimWithdraw`, live balances).
- `frontend` — the original dApp branch (older repo layout).

> Rule: the frontend **reads** the backend. It never re-derives protocol math,
> never hard-codes results, and never shows a number without a source.

---

## 0. Facts you must not invent (verify, then use)

| Item | Value |
|---|---|
| Program id (`declare_id!` / `Anchor.toml`) | `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` |
| RPC (devnet) | `https://api.devnet.solana.com` |
| Wrapped SOL mint (devnet) | `So11111111111111111111111111111111111111112` |
| USDC mint (devnet) | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Devnet USDC faucet | `https://faucet.circle.com` (20 USDC / address / 2 h) |
| Devnet SOL faucet | `https://faucet.solana.com` |
| Program admin | claimed by the operator key (`initialize_program`) |

Mint addresses are from Circle's official docs; confirm before citing.

---

## 1. Backend: build and test (no deploy yet)

```bash
# Rust backend
cargo fmt --all -- --check
cargo clippy -p arb-math -p arbswap-keeper -p arb-aggregator -p arbswap -- -D warnings
cargo test --workspace                 # expect all green
anchor build                           # SBF + IDL (target/idl/arbswap.json)

# Python research/analytics
.venv/bin/pytest simulation -q
```

Gate: tests green, `anchor build` OK. Do not proceed if red.

---

## 2. Backend: deploy the exact HEAD build to devnet

```bash
# 2.1 build the deployed method (cargo build-sbf, no idl-build) into a clean dir
rm -rf target/cu
( cd vault/program && CARGO_TARGET_DIR="$PWD/../../target/cu" cargo build-sbf )
cp target/cu/deploy/arbswap.so target/deploy/arbswap.so

# 2.2 operator/upgrade authority key (path OUTSIDE the repo, never committed)
export ARBSWAP_DEVNET_KEYPAIR="$HOME/.config/solana/id.json"
solana balance --url devnet            # needs a few SOL

# 2.3 deploy at the program id declared in Anchor.toml
solana program deploy target/deploy/arbswap.so \
  --program-id target/deploy/arbswap-keypair.json \
  --url https://api.devnet.solana.com \
  --keypair "$ARBSWAP_DEVNET_KEYPAIR" \
  --upgrade-authority "$ARBSWAP_DEVNET_KEYPAIR"

# 2.4 verify the deployed bytes equal the local build
.venv/bin/python scripts/devnet_program_hash.py \
  --program-id 2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm \
  --rpc https://api.devnet.solana.com --so target/deploy/arbswap.so
# expect: MATCH
```

Never reuse a **closed** program id (the upgradeable loader keeps a tombstone);
if the id is closed, generate a new keypair, `anchor keys sync`, and update
`Anchor.toml`, `app/src/chain/solana.ts`, and the docs.

---

## 3. Backend: claim the program admin (one time)

`initialize_program` must run before any vault can be created.

```bash
# program_config PDA = findProgramAddress([b"program"], programId)
# (compute with @solana/web3.js or the keeper helper)
cargo run -q -p arbswap-keeper -- init-program \
  https://api.devnet.solana.com \
  2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm \
  "$HOME/.config/solana/id.json" \
  <program_config_pda>
```

---

## 4. Backend: fund the operator with the vault tokens

The vault trades WSOL/USDC. Acquire both on devnet:

1. `solana airdrop 2 --url devnet` (native SOL) and/or `faucet.solana.com`.
2. **Wrap SOL** into the WSOL token account (the ATA of `So111…1112`).
3. Get devnet **USDC** from `https://faucet.circle.com` (mint
   `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`).

Check balances before initializing the vault:

```bash
spl-token accounts --url devnet
```

---

## 5. Backend: initialize the vault

`initialize_vault(params: InitParams)` creates the vault, config, quote state and
reserves. PDAs:

| Account | Seeds |
|---|---|
| `vault` | `[b"vault", base_mint, quote_mint]` |
| `config` | `[b"config", vault]` |
| `quote_state` | `[b"quote", vault]` |
| `bond_vault` | `[b"bond", vault]` |
| `deposit_ticket` | `[b"dep", vault, user]` |
| `withdraw_ticket` | `[b"wd", vault, user]` |
| `keeper_bond` | `[b"keeper", vault, keeper]` |
| `program_config` | `[b"program"]` |

`InitParams` (see `vault/program/src/lib.rs`) includes mints, keeper, treasury,
Pyth feed id, fee split, warmup/epoch/expiry slots, oracle + risk bounds, admin
rotation fields, and the ladder `offsets_bps`/`weights_bps`.

Recommended first vault: base = WSOL, quote = devnet USDC, feed = SOL/USD.

---

## 6. Backend: seed liquidity + start quoting

1. **Deposit** (both tokens, pro-rata):
   `deposit(base_amount, quote_amount, min_shares)`.
2. **Quote**: run the keeper (or post one `update_quote`) so `QuoteState` has
   levels, an anchor and an expiry. A swap before this reverts.
3. **Smoke-test** a `swap` and check `SwapEvent` on the explorer.

---

## 7. Frontend: point the app at the backend

All chain constants live in `app/src/chain/solana.ts`:

```ts
export const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com';
export const ARBSWAP_PROGRAM_ID = new PublicKey('2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
```

Dependencies (`app/package.json`): `@solana/web3.js`, the wallet-adapter packages,
`@coral-xyz/anchor`, `@solana/spl-token`.

```bash
cd app
yarn install      # or npm install
yarn build        # tsc -b && vite build
yarn dev          # local dev server
```

Deploy: Vercel (root `app/`, build `yarn build`, output `dist`). The artifact
bundle is served from `app/public/artifacts/*.json`.

---

## 8. Frontend: the on-chain client (`app/src/chain/program.ts`)

- **Program**: `new Program(idl, new AnchorProvider(connection, wallet))` using
  `app/src/idl/arbswap.json` (copied from `target/idl/arbswap.json`).
- **PDAs**: derive exactly as the seeds table in §5.
- **Reads**: `program.account.vault.fetch`, `.config.fetch`,
  `.quoteState.fetch`.
- **Writes**: builders for `deposit`, `swap`, `requestWithdraw`,
  `claimWithdraw`, `crankEpoch`.

Instruction arguments (from the IDL):

| Instruction | Args |
|---|---|
| `deposit` | `base_amount: u64`, `quote_amount: u64`, `min_shares: u64` |
| `swap` | `side: {buyBase \| sellBase}`, `amount_in: u64`, `min_out: u64`, `min_version: u64` |
| `request_withdraw` | `shares: u64` |
| `claim_withdraw` | — |
| `crank_epoch` | — |

Account lists (from the IDL):

| Instruction | Accounts |
|---|---|
| `deposit` | user, vault, config, base_reserve, quote_reserve, share_mint, share_lock, user_base, user_quote, user_shares, deposit_ticket, token_program, system_program |
| `swap` | trader, vault, config, quote_state, base_reserve, quote_reserve, trader_base, trader_quote, token_program |
| `request_withdraw` | user, vault, share_lock, deposit_ticket, user_shares, withdraw_ticket, token_program, system_program |
| `claim_withdraw` | user, vault, base_reserve, quote_reserve, share_mint, share_lock, withdraw_ticket, user_base, user_quote, token_program |
| `crank_epoch` | vault, config |

Token accounts are the owner's **associated** token accounts:
`getAssociatedTokenAddressSync(mint, owner)`. Wrap SOL before depositing/quoting
WSOL.

---

## 9. Frontend: page-by-page wiring

| Page | Reads | Writes |
|---|---|---|
| **Overview** | live balances; headline/model numbers from `artifacts/public` | — |
| **Swap** | wallet SOL/USDC balances; on-chain `QuoteState` (anchor, spread, expiry, version) | `swap(side, amount_in, min_out, min_version)`; then `refreshBalances()` |
| **Vault** | on-chain `Vault` (reserves, total_shares, status) + user share ATA | `deposit`, `request_withdraw`, `claim_withdraw`; then `refreshBalances()` |
| **Risk** | on-chain `Config` bounds + `QuoteState` (spread, depth, staleness) | (admin-only: `reset_breaker`, `wind_down`) |
| **Analytics** | `artifacts/public/held_out.json`, `routed_world.json`, `thesis.json`, `headline.json` | — |

Every write must: build → send → await confirmation → `refreshBalances()` and
re-read the changed accounts. Never display a client-computed protocol result.

---

## 10. Data contract (read-only model results)

The UI reads **only** from `artifacts/public/` (served as `/artifacts/*.json`):

| File | Use |
|---|---|
| `manifest.json` | commit, flow type, sha256, `schema_version` |
| `headline.json` | headline numbers, routed world, cost |
| `held_out.json` | per-window venue metrics (markout, half-spread, gap, PnL) |
| `routed_world.json`, `envelope.json` | routed tables / operating envelope |
| `thesis.json` | pre-registered decision string |
| `cu.json`, `mutation.json`, `test_counts.json` | cost/security/test tables |
| `e8_proxy.json` | real-quote proxy (labelled a proxy, not a fill gap) |

Rules: validate against `artifacts/schema/*.json`; show `manifest.commit` and
`flow_type`; label every model number "model output"; show the losing regime;
never use a banned word (`docs/CLAIMS.md`).

---

## 11. End-to-end acceptance checklist

- [ ] `cargo test --workspace` and `.venv/bin/pytest simulation -q` green.
- [ ] `anchor build` OK; `scripts/devnet_program_hash.py` reports MATCH.
- [ ] `initialize_program` confirmed; `program_config` exists.
- [ ] Operator holds devnet WSOL and USDC (faucets in §0).
- [ ] Vault initialized; reserves funded; `Vault` account decodes.
- [ ] Keeper posted a `QuoteState` with levels and a future expiry.
- [ ] `app` builds (`yarn build`) and reads live balances.
- [ ] A swap changes the wallet's SOL/USDC balances (after `refreshBalances`).
- [ ] Analytics shows the real bundle, including the losing regime.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Balances never change | mock UI / no RPC read | use `useWallet`+`useConnection`, `refreshBalances` (§8) |
| `vault not initialized` | no WSOL/USDC vault | run §5–§6 |
| swap reverts `QuoteExpired` | keeper not running | post `update_quote` (§6) |
| `NotBonded` on quote | `min_bond > 0` and keeper unbonded | `bond_keeper` |
| deposit reverts | missing/incorrect ATA or no tokens | wrap SOL, get USDC (§4) |
| `InvalidInverseSqrt` on update | keeper payload under-estimates inverses | use the keeper's encoder (it derives them) |
| build errors after wiring | Anchor/IDL typing | run `yarn build` and fix the reported types |

---

## 13. What is explicitly not provided

- A live HTTP API/indexer server: **CLOSED-BY-DECISION** (static bundle suffices).
- A fill-gap measurement: needs funded mainnet trades (E8 is a quote proxy).
- Economic proof of Option 1: **not shown** (`docs/THESIS.md`); the UI must state
  this, not imply otherwise.
