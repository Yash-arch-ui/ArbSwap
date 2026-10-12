# Full Guide: Connect the ArbSwap Backend to the `app`

This guide connects the current ArbSwap backend to the active React dApp in this repository.

It uses:

- Anchor program: `vault/program/`
- Shared math: `vault/math/`
- Keeper: `vault/keeper/`
- Research and analytics: `simulation/`
- Frontend: `app/`

Do not use `frontend/`. That directory is an obsolete Next.js scaffold with no application source.

## 1. What “connected” means

The connection has four layers:

```text
Pyth / keeper
      |
      v
Solana devnet program  <---- Anchor IDL + RPC ----  React app
      |
      v
program events / artifacts  <----------------------  Analytics screens
```

The app does not call a backend HTTP server. The current design uses:

1. Solana RPC for live account reads and transactions.
2. `app/src/idl/arbswap.json` for the Anchor ABI.
3. The keeper to write fresh quotes on-chain.
4. Static JSON files in `app/public/artifacts/` for replay analytics.

## 2. Current devnet configuration

The following values must agree across `Anchor.toml`, `vault/program/src/lib.rs`, the IDL, and `app/src/chain/solana.ts`.

| Setting | Value |
|---|---|
| Cluster | Solana devnet |
| RPC | `https://api.devnet.solana.com` |
| Program ID | `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` |
| Base token | tSOL, mint `76XvqdSVi2LhYWgeWjx6E1V2c7oBeB6ndUEp6xC44jp2`, 9 decimals |
| Quote token | tUSDC, mint `q3xHxvxCBvYCMwuA6dFtTDHHwbqkrruTYWAWXdPuNFX`, 6 decimals |
| Token program | Classic SPL Token |
| App | `app/` |

These are worthless test tokens. They are not mainnet SOL and USDC.

## 3. Install prerequisites

Required tools:

- Rust toolchain from `rust-toolchain.toml`
- Solana CLI
- Anchor CLI
- Node.js and Yarn
- Python 3 and the simulation dependencies

From the repository root:

```bash
cargo test --workspace
anchor build
python3 -m pytest simulation -q
```

Install and test the app:

```bash
cd app
yarn install
yarn test
yarn build
```

Start the app locally:

```bash
yarn dev
```

Open the Vite URL shown in the terminal, normally `http://localhost:5173`.

## 4. How the app connects to Solana

### 4.1 Wallet and RPC provider

`app/src/chain/WalletProvider.tsx` creates:

- `ConnectionProvider` using `SOLANA_DEVNET_RPC`
- Phantom and Solflare wallet adapters
- `WalletProvider`
- `WalletModalProvider`

The provider hierarchy in `app/src/App.tsx` is:

```text
SolanaWalletProvider
  ProtocolProvider
    Navbar + pages
```

The wallet signs transactions. It does not provide protocol state by itself.

### 4.2 Anchor program client

`app/src/chain/program.ts` creates an Anchor `Program` with:

```text
app/src/idl/arbswap.json
        +
AnchorProvider(connection, wallet)
        +
ARBSWAP_PROGRAM_ID
```

The IDL must be generated from the same program build as the deployed program. Never hand-edit the IDL.

### 4.3 Account reads

`fetchProtocolState()` reads:

- `Vault`
- `Config`
- `QuoteState`
- reserve token balances

It derives the main PDAs using the program seeds:

```text
vault        = PDA(["vault", base_mint, quote_mint])
config       = PDA(["config", vault])
quote_state  = PDA(["quote", vault])
bond_vault   = PDA(["bond", vault])
program      = PDA(["program"])
```

User-specific accounts:

```text
deposit_ticket  = PDA(["dep", vault, user])
withdraw_ticket = PDA(["wd", vault, user])
```

The app maps raw Anchor values to UI values in `app/src/chain/live.ts`. Raw token amounts remain integer atoms until the display boundary.

### 4.4 Polling

`ProtocolContext` currently polls live state every 8 seconds and refreshes wallet balances after connection changes.

The context should expose these states to every page:

- Vault exists or does not exist
- Quote exists or does not exist
- Quote is fresh, aging, or expired
- Vault is active, paused, or winding down
- Wallet token balances
- User share balance
- RPC error and last refresh time

## 5. Verify the deployed backend before wiring the UI

Run these checks before debugging frontend code.

### 5.1 Verify program identity

```bash
solana program show \
  2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm \
  --url https://api.devnet.solana.com
```

Verify the IDL address:

```bash
node -e "const x=require('./app/src/idl/arbswap.json'); console.log(x.address)"
```

It must print:

```text
2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm
```

Verify deployed bytes against the local build:

```bash
python3 scripts/devnet_program_hash.py \
  --program-id 2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm \
  --rpc https://api.devnet.solana.com \
  --so target/deploy/arbswap.so
```

Expected result: `MATCH`.

### 5.2 Verify the program admin PDA

The one-time `initialize_program` instruction has already been run for the current program ID. Do not run it again.

```text
program_config = PDA(["program"])
```

If the PDA already exists, calling `initialize_program` again will fail.

### 5.3 Verify the vault

The app can read the vault only after the configured tSOL/tUSDC vault has been initialized. If it is absent, the app must show `Vault not initialized` and disable swap/deposit actions.

The vault initialization client is:

```text
vault/keeper/src/init_vault.rs
```

Dry run first:

```bash
cargo run -q -p arbswap-keeper -- \
  init-vault scripts/devnet/init_vault.devnet.json
```

Only with explicit operator approval:

```bash
cargo run -q -p arbswap-keeper -- \
  init-vault scripts/devnet/init_vault.devnet.json --send
```

The `--send` command creates state and requires the operator key. Never put a private key in the repository.

## 6. Fund the devnet demo wallet

The wallet needs native SOL for transaction fees and both test tokens for the demo.

Check the wallet:

```bash
solana address
solana balance --url devnet
spl-token accounts --url devnet
```

The test-token minting procedure is documented in `docs/DEVNET.md` and guarded by devnet-only scripts. Respect the configured mint caps. The app should display zero balances if the wallet has no token account; it must not display sample balances.

## 7. Start the keeper

The keeper writes `QuoteState` updates. Without a current quote, swaps must fail safely after expiry.

The keeper supports these command shapes:

```text
arbswap-keeper replay <csv>
arbswap-keeper single <price_q64> <base_reserve> <quote_reserve> [previous_price_q64] [base_decimals] [quote_decimals]
arbswap-keeper live <rpc_url> <program_id> <vault> <config> <quote_state> <base_reserve> <quote_reserve> <price_feed> <keeper_bond> <keeper.json> [priority_fee] [run_seconds] [max_vol_bps] [lvr_budget_bps]
```

Use the exact vault addresses printed by the initialization dry run or fetched from the chain. Do not guess them.

The keeper must:

1. Read the configured Pyth feed.
2. Normalize the 9-decimal base / 6-decimal quote price once.
3. Read current vault reserves.
4. Compute the quote using shared keeper/math logic.
5. Validate bounds offline.
6. Submit `update_quote`.
7. Let the quote expire if the oracle or RPC is stale.

The app never invents a quote if the keeper stops.

## 8. Frontend live data flow

The intended data flow is:

```text
RPC account data
  -> fetchProtocolState()
  -> toQuoteState()/toVaultState()/toRiskBreakers()
  -> ProtocolContext
  -> Overview / Swap / Vault / Risk pages
```

### Overview page

Use live state for:

- Quote version
- Current slot
- Vault TVL
- Reserve balances
- Vault status

Use backend artifacts for:

- Markout charts
- LVR replay
- Research comparisons

Label artifact values as `model output` or `replay`.

### Swap page

The swap page must:

1. Read current quote state.
2. Check `status !== Expired`.
3. Check vault status is active.
4. Parse user input as a decimal string.
5. Convert input to atoms using the token decimals.
6. Compute or obtain a conservative integer `min_out`.
7. Pass the current quote version as `min_version`, not `0`.
8. Submit `swap`.
9. Wait for confirmation.
10. Refresh balances, quote, vault, and transaction state.

The current `SwapPage.tsx` still computes the preview with JavaScript floating-point arithmetic and uses `minVersion = 0`. Treat this as unfinished integration. The final implementation must use the backend-compatible integer quote path or a deliberately conservative minimum output.

Swap arguments are:

```text
swap(side, amount_in, min_out, min_version)
```

Sides are:

```text
{ sellBase: {} }  // tSOL in, tUSDC out
{ buyBase: {} }   // tUSDC in, tSOL out
```

### Vault page

The vault page must use:

```text
deposit(base_amount, quote_amount, min_shares)
request_withdraw(shares)
claim_withdraw()
crank_epoch()
```

Required behavior:

- Deposit both tokens pro-rata.
- Show share amount as an estimate until confirmed.
- Fetch the real `DepositTicket` after deposit.
- Fetch the real `WithdrawTicket` after withdrawal request.
- Never create a fake ticket ID in React state.
- Enable claim only when the on-chain ticket is eligible.
- Refresh state after every confirmed transaction.

The current page seeds `MOCK_USER_TICKETS` and creates a random local ticket. Remove that behavior before the demo.

### Risk page

The live risk page may display:

- Vault status from `Vault.status`
- Quote age and expiry
- Oracle publish time and confidence stored in `QuoteState`
- Configured spread, anchor, staleness, inventory, and size bounds
- Configured keeper address and bond requirement

It must not present keeper-local volatility, priority fees, update counts, or current skew as live unless they come from a telemetry source.

The current `tripManualBreaker` and `resetBreaker` only mutate React state. They are not blockchain controls. Replace them with real authorized transactions or label them as simulation-only.

### Analytics page

Load replay data from:

```text
app/public/artifacts/manifest.json
app/public/artifacts/headline.json
app/public/artifacts/held_out.json
app/public/artifacts/routed_world.json
app/public/artifacts/envelope.json
app/public/artifacts/thesis.json
app/public/artifacts/cu.json
app/public/artifacts/mutation.json
app/public/artifacts/test_counts.json
app/public/artifacts/e8_proxy.json
```

The page must show:

- Artifact commit
- Schema version
- Flow type
- Data window
- Model/replay label
- Losing regime or limitation

The current `AnalyticsPage.tsx` still imports `MOCK_LVR_DATA` and `MOCK_QUOTE_VS_FILL`. Replace those imports with artifact data. If the artifact does not contain a metric, render `n/a`.

## 9. Transaction lifecycle pattern

Every write should follow this pattern:

```text
validate UI input
  -> build Anchor instruction
  -> wallet signs
  -> send transaction
  -> wait for confirmed signature
  -> show explorer link
  -> fetch changed accounts
  -> render confirmed state
```

Use these visible states:

```text
idle
pending wallet signature
pending confirmation
confirmed
failed
```

Do not update balances optimistically. If confirmation fails, preserve the last confirmed state and show the error.

## 10. Account and decimal rules

The configured pair has different decimals:

```text
tSOL  = 9 decimals
tUSDC = 6 decimals
shares = 9 decimals
```

Examples:

```text
1.0 tSOL  = 1_000_000_000 atoms
1.0 tUSDC = 1_000_000 atoms
```

Rules:

- UI inputs are strings.
- Transaction amounts are `bigint`/Anchor `BN`.
- Never multiply large token amounts using JavaScript `number`.
- Never assume base and quote have equal decimals.
- Use reserve token-account balances, not only cached `Vault` fields.
- Display a formatted number only after the integer value is known.

## 11. Build the backend and app together

When the program ABI changes:

1. Change the Rust program.
2. Update program tests.
3. Run `cargo test --workspace`.
4. Run `anchor build`.
5. Regenerate the IDL.
6. Copy the matching IDL to `app/src/idl/arbswap.json`.
7. Update `app/src/chain/program.ts` account/argument types.
8. Update `ProtocolContext` mapping.
9. Update page transaction flows.
10. Run app tests/build.
11. Deploy only after local checks pass.
12. Verify deployed program bytes and IDL address.

Never deploy a program with an older IDL in the app.

## 12. Full verification commands

From the repository root:

```bash
cargo fmt --all -- --check
cargo test --workspace
anchor build
python3 -m pytest simulation -q
```

From `app/`:

```bash
```

Before demo:

```bash
git status --short
git diff --check
```

Confirm no private keys, seed phrases, or local wallet files are in the worktree.

## 13. Hackathon demo sequence

1. Open the app and show `Solana Devnet`.
2. Connect Phantom or Solflare.
3. Show live native SOL, tSOL, and tUSDC balances.
4. Show live vault status, reserve balances, quote version, and expiry.
5. Show the six-level ladder from on-chain `QuoteState`.
6. Execute a small tSOL/tUSDC swap.
7. Show the confirmed transaction on Solscan devnet.
8. Refresh and show changed wallet balances.
9. Deposit both test tokens and show the warm-up ticket.
10. Request a withdrawal and show the real on-chain ticket.
11. Switch to replay analytics and show artifact provenance.
12. Stop or pause the keeper in a controlled rehearsal and show quote expiry disables swaps.

Keep a recorded replay as the fallback. The live deployment uses test tokens and must not be presented as a production vault.

## 14. Final acceptance checklist

### Backend

- [ ] Program ID is consistent everywhere.
- [ ] Deployed bytes match the intended local build.
- [ ] Vault exists for the configured tSOL/tUSDC pair.
- [ ] Reserves are non-zero.
- [ ] Keeper posts fresh quotes.
- [ ] Quote expires when keeper stops.
- [ ] `cargo test --workspace` passes.
- [ ] `anchor build` passes.

### App

- [ ] `app/yarn build` passes.
- [ ] Wallet connects to devnet.
- [ ] Live balances come from configured mints.
- [ ] Vault/config/quote state loads from RPC.
- [ ] Swap uses integer amounts and a non-zero quote version floor.
- [ ] Expired and paused quotes disable swaps.
- [ ] Deposit confirmation refreshes the UI.
- [ ] Withdrawal request reads the real ticket.
- [ ] Withdrawal claim is wired or explicitly marked unavailable.
- [ ] No live page uses `mockData.ts`.
- [ ] No local React state is presented as on-chain risk state.
- [ ] Every transaction shows pending, confirmed/failed, signature, and refreshed state.

### Analytics

- [ ] Static artifacts load from `/artifacts/`.
- [ ] Manifest provenance is visible.
- [ ] Replay/model values are labeled.
- [ ] E8 proxy is labeled as a proxy.
- [ ] Missing metrics show `n/a`, not fabricated zeros.
- [ ] Claims match `docs/CLAIMS.md`.

## 15. Important limitations

- There is no live backend HTTP API in this design.
- The app reads live protocol state directly from Solana RPC.
- Analytics is static replay data unless a future indexer is added.
- Keeper volatility and operational telemetry are not all stored on-chain.
- The current app still has mock presentation paths that must be removed or isolated.
- The current devnet assets are worthless test tokens.
- The system is not independently audited.
- Backtest results are not proof of live profitability or adversarial execution quality.

For the shorter integration checklist, see `docs/INTEGRATION.md`.
