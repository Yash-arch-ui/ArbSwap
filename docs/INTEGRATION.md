# ArbSwap Backend ↔ `app` Integration Runbook

This is the implementation runbook for connecting the Rust/Anchor backend to the React app in this repository.

It is written for a coding agent. Follow the steps in order. Do not invent addresses, account layouts, token mints, ABI fields, or test results.

## 0. Scope and architecture

The active frontend is `app/`, not `frontend/`.

```text
vault/program       Anchor program: custody, shares, swap, guards
vault/math           fixed-point ladder and swap math
vault/keeper         Pyth reader and update_quote transaction sender
simulation           Python reference, simulator, analytics artifacts
app/                 Vite + React wallet client
```

The app has no live HTTP backend. It connects through:

1. Solana RPC for account reads and transactions.
2. Anchor IDL at `app/src/idl/arbswap.json`.
3. The deployed program at the configured program ID.
4. Static replay files under `app/public/artifacts/` for analytics.

The keeper is a separate process. It writes `QuoteState` to Solana; the app reads the resulting account.

## 1. Source of truth

When files disagree, use this order:

1. Deployed program and current Rust source: `vault/program/src/lib.rs`.
2. Generated IDL: `target/idl/arbswap.json`.
3. Committed frontend IDL: `app/src/idl/arbswap.json`.
4. Frontend chain client: `app/src/chain/`.
5. Documentation and mock UI.

After any ABI change, regenerate the IDL and copy the matching IDL to the app. Never hand-edit the IDL.

## 2. Current devnet constants

These constants are currently defined in `Anchor.toml`, `vault/program/src/lib.rs`, `app/src/chain/solana.ts`, and the IDL:

| Item | Value |
|---|---|
| RPC | `https://api.devnet.solana.com` |
| Program ID | `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` |
| Base mint | `76XvqdSVi2LhYWgeWjx6E1V2c7oBeB6ndUEp6xC44jp2` (`tSOL`, 9 decimals) |
| Quote mint | `q3xHxvxCBvYCMwuA6dFtTDHHwbqkrruTYWAWXdPuNFX` (`tUSDC`, 6 decimals) |
| Pyth feed ID | `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` |
| Token program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| App directory | `app/` |

These are worthless devnet test tokens. Do not substitute mainnet WSOL/USDC.

### Important deployment fact

The repository contains `scripts/devnet/init_vault.devnet.json`, but that file is a configuration, not proof that a vault exists. The four vault-specific accounts are generated during initialization and are not committed as secrets.

Therefore:

- Never hard-code a vault address before checking RPC.
- Derive the vault PDA from the two configured mints.
- Read the reserve, share mint, and share lock addresses from the on-chain `Vault` account.
- If the vault PDA has no account, stop and initialize the vault through the operator flow below.

## 3. Prerequisites and baseline checks

From the repository root:

```bash
cargo fmt --all -- --check
cargo test --workspace
anchor build
python3 -m pytest simulation -q
```

From the app:

```bash
cd app
yarn install
yarn test
yarn build
```

Return to the repository root before running Rust commands:

```bash
cd ..
```

Check the current program ID:

```bash
solana program show \
  2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm \
  --url https://api.devnet.solana.com
```

Check the IDL address:

```bash
node -e "const fs=require('fs'); const x=JSON.parse(fs.readFileSync('app/src/idl/arbswap.json','utf8')); console.log(x.address)"
```

Expected output:

```text
2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm
```

If the deployed bytes are available locally, verify them:

```bash
python3 scripts/devnet_program_hash.py \
  --program-id 2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm \
  --rpc https://api.devnet.solana.com \
  --so target/deploy/arbswap.so
```

Expected output: `MATCH`.

## 4. Derive the program accounts

The canonical PDA seeds are implemented in `app/src/chain/program.ts` and `vault/keeper/src/init_vault.rs`.

```text
program_config = PDA([b"program"])
vault          = PDA([b"vault", base_mint, quote_mint])
config         = PDA([b"config", vault])
quote_state    = PDA([b"quote", vault])
bond_vault     = PDA([b"bond", vault])
deposit_ticket = PDA([b"dep", vault, user])
withdraw_ticket= PDA([b"wd", vault, user])
keeper_bond    = PDA([b"keeper", vault, keeper])
```

The app already derives the first five in `deriveVaultAddresses()`. Keep all derivation in one chain module. Do not duplicate seed strings inside page components.

To inspect the configured vault from the app/client, call:

```ts
const state = await fetchProtocolState(connection, BASE_MINT, QUOTE_MINT);
```

Interpret the result exactly:

```text
state.exists == false       vault PDA does not exist; initialize or stop
state.vaultData exists      Vault account decoded; read reserve/share accounts
state.quoteData absent      no quote has been written yet; swaps disabled
quote expiry <= currentSlot quote expired; swaps disabled
```

## 5. Initialize the vault, only if absent

### 5.1 Key rules

- Never commit keypairs.
- Never use a mainnet keypair.
- Use a dedicated devnet keypair outside the repository.
- The initializer config currently points to `$HOME/.config/solana/id.json`; change that path to the approved devnet operator key before sending.
- `initialize_program` is one-time and has already been executed for the current program ID. Do not run it again if the `program_config` PDA exists.

### 5.2 Inspect the configuration

```bash
node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync('scripts/devnet/init_vault.devnet.json','utf8')))"
```

The configuration contains:

- tSOL/tUSDC mints
- admin, keeper, and treasury public keys
- Pyth feed ID
- fee split
- warm-up and epoch duration
- spread, inventory, capacity, oracle, and flow limits
- six ladder offsets and weights

Do not modify parameters for a live deployment without recording the decision in `docs/ASSUMPTIONS.md` and obtaining operator approval.

### 5.3 Dry-run the initializer

```bash
cargo run -q -p arbswap-keeper -- \
  init-vault scripts/devnet/init_vault.devnet.json
```

The dry run prints the actual addresses for:

```text
vault
config
quote_state
program_config
base_reserve
quote_reserve
share_mint
share_lock
```

Save this output outside source code or in an approved deployment record. The four generated signer keypairs must remain available to the operator for the initialization transaction.

### 5.4 Send only after approval

```bash
cargo run -q -p arbswap-keeper -- \
  init-vault scripts/devnet/init_vault.devnet.json --send
```

After confirmation:

1. Run `fetchProtocolState()` or inspect the vault PDA with RPC.
2. Confirm `baseMint` and `quoteMint` match the configured pair.
3. Confirm reserve, share mint, and share lock accounts exist.
4. Confirm the app can decode `Vault`, `Config`, and `QuoteState`.

If the initializer has not been sent, the app must show `Vault not initialized`; do not fill the screen with sample TVL or prices.

## 6. Seed liquidity

The vault requires both tokens. Check wallet balances first:

```bash
solana balance --url devnet
spl-token accounts --url devnet
```

The deposit instruction is:

```text
deposit(base_amount: u64, quote_amount: u64, min_shares: u64)
```

Amounts are raw atoms:

```text
1 tSOL  = 1_000_000_000 atoms
1 tUSDC = 1_000_000 atoms
```

The deposit must be proportional in both tokens. The program creates a warm-up ticket; shares are not immediately active for withdrawal.

The app builder is `deposit()` in `app/src/chain/program.ts`. It must:

1. Fetch `Vault`.
2. Derive the user's associated token accounts.
3. Derive `[b"dep", vault, user]`.
4. Use the reserve/share accounts from `Vault`.
5. Submit the instruction.
6. Wait for confirmation.
7. Fetch the deposit ticket and share balance.

Do not report a locally calculated share estimate as the confirmed result.

## 7. Start the keeper and write a quote

### 7.1 Build the keeper

```bash
cargo build -p arbswap-keeper
```

### 7.2 Required live arguments

The actual parser is in `vault/keeper/src/main.rs`. The command is positional and must be passed in this exact order:

```text
cargo run -q -p arbswap-keeper -- live \
  <rpc_url> \
  <program_id> \
  <vault> \
  <config> \
  <quote_state> \
  <base_reserve> \
  <quote_reserve> \
  <price_feed_account> \
  <keeper_bond_pda> \
  <keeper_keypair_path> \
  <feed_id_hex> \
  <max_staleness_seconds> \
  <max_conf_bps> \
  <priority_micro_lamports_per_cu> \
  <run_seconds> \
  <max_vol_bps> \
  <lvr_budget_bps>
```

Use these configured values unless the operator has approved another policy:

```text
rpc_url       https://api.devnet.solana.com
program_id    2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm
feed_id_hex   ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d
max_stale     2
max_conf_bps  10
```

`<price_feed_account>` and `<keeper_bond_pda>` are addresses, not feed IDs. Get the price-update account from the configured Pyth setup and derive the keeper bond using `[b"keeper", vault, keeper]`. If either account is unavailable, stop and resolve the deployment configuration; do not substitute the feed ID as an account address.

The keeper reads token decimals from the on-chain mint accounts. This is required because tSOL has 9 decimals and tUSDC has 6.

### 7.3 Keeper behavior

The keeper:

1. Reads the Pyth price-update account.
2. Rejects stale or wide-confidence observations.
3. Reads vault reserves and configuration.
4. Computes the ladder using shared keeper/math logic.
5. Applies the decimal normalization once.
6. Prevalidates on-chain bounds.
7. Submits `update_quote`.
8. Repeats every 400 ms.

If it stops, the existing quote must expire. The frontend must disable swaps after expiry.

## 8. Exact `update_quote` ABI

The `update_quote` instruction has:

```text
accounts:
  keeper
  vault
  config
  quote_state
  price_update
  keeper_bond
  base_reserve
  quote_reserve

args:
  update: QuoteUpdate
```

`QuoteUpdate` is defined in the IDL and Rust source as:

```text
update_slot: u64
oracle_publish_time: i64
oracle_price: u128
oracle_conf_bps: u32
anchor_sqrt_price: u128
p_res_sqrt: u128
half_spread_bps: u32
ask_extra_bps: u32
bid_extra_bps: u32
depth_mult_bps: u32
offsets_bps: [u32; 6]
weights_bps: [u32; 6]
ask_levels: [LevelUpdate; 6]
bid_levels: [LevelUpdate; 6]
```

`LevelUpdate` is:

```text
sqrt_lo: u128
sqrt_hi: u128
liquidity: u128
inv_lo: u128
inv_hi: u128
```

All fixed-point fields are integer values. Do not recreate this payload in the React app. The keeper is the quote writer.

## 9. Exact frontend transaction ABI

The frontend builders must match `app/src/idl/arbswap.json` exactly.

### `deposit`

```text
args: base_amount: u64, quote_amount: u64, min_shares: u64
accounts:
  user, vault, config, base_reserve, quote_reserve, share_mint,
  share_lock, user_base, user_quote, user_shares, deposit_ticket,
  token_program, system_program
```

### `swap`

```text
args: side: SwapSide, amount_in: u64, min_out: u64, min_version: u64
accounts:
  trader, vault, config, quote_state, base_reserve, quote_reserve,
  trader_base, trader_quote, token_program
```

`SwapSide` values are:

```text
{ buyBase: {} }
{ sellBase: {} }
```

### `request_withdraw`

```text
args: shares: u64
accounts:
  user, vault, share_lock, deposit_ticket, user_shares,
  withdraw_ticket, token_program, system_program
```

### `claim_withdraw`

```text
args: none
accounts:
  user, vault, base_reserve, quote_reserve, share_mint, share_lock,
  withdraw_ticket, user_base, user_quote, token_program
```

### `crank_epoch`

```text
args: none
accounts: vault, config
```

### Breakers

```text
trip_breaker:  vault, config, quote_state
reset_breaker: admin, vault
```

`trip_breaker` and `reset_breaker` are real blockchain instructions. The current React functions that only mutate local state are not integration.

## 10. Frontend implementation tasks

### 10.1 `app/src/chain/solana.ts`

Keep the RPC, program ID, mints, decimals, and feed ID here. Do not duplicate them in pages.

Keep native SOL separate from tSOL:

```text
native SOL = transaction fee balance
tSOL       = vault base token balance
```

### 10.2 `app/src/chain/program.ts`

Keep all PDA derivation and Anchor transaction builders here.

Add these reads before wiring the pages:

- `fetchWithdrawTicket(connection, user)`
- `fetchDepositTicket(connection, user)`
- `fetchShareBalance(connection, user)`
- `fetchKeeperBond(connection, keeper)` when the risk view needs it

Every write must return the confirmed signature.

### 10.3 `app/src/context/ProtocolContext.tsx`

The provider must expose:

```text
vaultInitialized
quoteAvailable
quoteState
vaultState
riskBreakers
wallet balances
share balance
deposit ticket
withdrawal ticket
loading
lastUpdatedSlot
liveError
refreshProtocol()
refreshBalances()
```

Do not initialize live state with realistic fake TVL, prices, APY, or tickets. Empty state must be zero or `n/a` and visibly identified as unavailable.

### 10.4 `SwapPage.tsx`

The current page has two integration defects:

1. It derives `expectedOut` and `minOut` from a floating-point reservation-price approximation.
2. It sends `minVersion = 0`.

Fix it as follows:

1. Read current `QuoteState`.
2. Reject expired/paused quotes.
3. Parse input as a string.
4. Convert to integer atoms using 9 or 6 decimals.
5. Use the backend-compatible integer quote path or a conservative user-confirmed `min_out`.
6. Pass the current quote version as `min_version`.
7. Confirm the transaction.
8. Refresh balances, quote, vault, and transaction status.

If the app cannot calculate the exact quote safely, it must show an estimate and ask the user for a slippage floor. It must not claim exact execution from a client-side approximation.

### 10.5 `VaultPage.tsx`

The current page imports `MOCK_USER_TICKETS` and creates a random local ticket. Remove both.

After deposit or withdrawal request, fetch the actual account:

```text
deposit ticket  = PDA(["dep", vault, wallet])
withdraw ticket = PDA(["wd", vault, wallet])
```

Show account-derived epoch, activation, claimability, shares, and outputs. A locally calculated estimate must be labeled `estimate`.

### 10.6 `RiskPage.tsx`

Use only:

- `Vault.status`
- `Config` bounds
- quote slot/expiry
- oracle timestamp/confidence stored in `QuoteState`
- configured keeper/bond state

The following are not currently stored in `QuoteState` and must not be shown as live values:

- short/medium volatility
- current inventory skew
- keeper update counts
- priority fees
- current jump flag

Either wire a telemetry source or render `unavailable`.

### 10.7 `AnalyticsPage.tsx`

The current page still imports `MOCK_LVR_DATA` and `MOCK_QUOTE_VS_FILL`. Remove those imports from the live page.

Load artifacts from `/artifacts/` and show:

- `manifest.commit`
- `manifest.schema_version`
- `manifest.flow_type`
- window/date range
- `model output` or `replay` label
- losing regime and limitations

If an artifact is missing, render `n/a`; never silently use mock data.

## 11. Transaction lifecycle required by every page

Implement this state machine for every write:

```text
idle
  -> wallet signature pending
  -> confirmation pending
  -> confirmed
  -> refresh accounts
```

Failure path:

```text
pending -> failed -> preserve last confirmed state + show error
```

Do not optimistically change token balances or vault totals.

Show the signature and a devnet explorer link after confirmation:

```text
https://solscan.io/tx/<SIGNATURE>?cluster=devnet
```

## 12. Analytics artifact integration

The app currently serves static files from `app/public/artifacts/`.

Required files:

```text
manifest.json
headline.json
held_out.json
routed_world.json
envelope.json
thesis.json
cu.json
mutation.json
test_counts.json
e8_proxy.json
```

Rules:

- `manifest.json` is the provenance entry point.
- Replay values are not live vault values.
- E8 is a proxy unless the artifact explicitly says otherwise.
- Do not show APY or profitability projections as current product results.
- Do not show `0.00 bps`, `99.9%`, `0.24 bps`, or `~620 CU` unless the displayed value is read from a named artifact.

## 13. Local verification

Run from the repository root:

```bash
cargo fmt --all -- --check
cargo test --workspace
anchor build
python3 -m pytest simulation -q
```

Run from `app/`:

```bash
```

Run the app only after the backend state is ready. The UI can build without a vault, but a live swap cannot succeed without:

```text
existing vault
non-zero reserves
fresh QuoteState
funded wallet
fresh keeper/oracle input
```

## 14. End-to-end smoke test

### Read path

- [ ] App connects to devnet.
- [ ] Wallet address renders.
- [ ] Native SOL and tSOL/tUSDC balances load from RPC.
- [ ] Vault existence is checked by PDA.
- [ ] Vault/config/quote accounts decode.
- [ ] Quote version, ladder, expiry, and status render from on-chain data.

### Write path

- [ ] Deposit uses both token ATAs and the fetched reserve/share accounts.
- [ ] Deposit confirmation refreshes the ticket and share balance.
- [ ] Swap uses integer atoms and current quote version.
- [ ] Swap is disabled when quote expired or vault paused.
- [ ] Swap confirmation refreshes balances.
- [ ] Withdrawal request creates/reads the real ticket.
- [ ] Claim uses the real ticket and refreshes balances.
- [ ] Crank is available only when epoch conditions are met.

### Keeper path

- [ ] Keeper reads the correct price-update account.
- [ ] Keeper feed ID matches the configured feed ID.
- [ ] Keeper reads the actual vault/config/quote/reserve addresses.
- [ ] Keeper uses 9/6 decimal normalization.
- [ ] Keeper posts `update_quote`.
- [ ] App observes the new quote version.
- [ ] Stopping keeper causes expiry, not a fabricated frontend quote.

### Evidence path

- [ ] App displays the confirmed transaction signature.
- [ ] Analytics loads artifacts from `/artifacts/`.
- [ ] Artifact provenance is visible.
- [ ] Replay/model values are labeled.
- [ ] Missing values render `n/a`.
- [ ] Claims match `docs/CLAIMS.md`.

## 15. Stop conditions

Stop and ask the operator instead of guessing if:

- The vault PDA is absent and no initialization approval exists.
- The configured admin key is unavailable or does not match `program_config.admin`.
- The price-update account is unknown.
- The keeper keypair is missing.
- The deployed IDL address differs from the program ID.
- The program hash does not match the intended build.
- Token decimals differ from 9/6.
- The app wants to use mainnet tokens or real funds.
- A UI value has no on-chain or artifact source.

## 16. Security and demo limitations

- This is a devnet test-token integration.
- No private keys belong in Git.
- The deployed program is upgradeable and requires stronger authority management before real funds.
- The system is not independently audited.
- Replay/backtest output is not proof of live profitability or live execution quality.
- A keeper outage should cause quote expiry and disabled swaps.

For the product rationale and math specification, read `MasterPlan.md`, `BuilderPlan.md`, and `docs/BUILD_PLAN.md`. For deployment history, read `docs/DEVNET.md`. For claim boundaries, read `docs/CLAIMS.md`.
