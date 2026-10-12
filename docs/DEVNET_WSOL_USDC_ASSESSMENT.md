# Canonical Devnet WSOL/USDC Vault — Read-Only Assessment

**Status:** assessment only. **No state-changing Devnet transaction was sent.**
Branch: `main` (tip `5de0ffa`, in sync with `origin/main`). Program:
`2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm`. Deployed byte hash
`9a05056e…` (688616 bytes) == local `cargo build-sbf` artifact (**MATCH**).

## Headline

A WSOL/USDC vault **already exists** on Devnet for this program (owner = program)
and is unfunded. Initialization is therefore **not** required. However, the
keeper→program oracle-price scaling is inconsistent at HEAD for any pair whose
base and quote decimals differ (both vaults are 9/6), which blocks live quoting
until resolved.

## 1. Does the deployed program support this pair? (source/test evidence)

**Yes — the program is mint-agnostic.**

- `initialize_vault` (`vault/program/src/lib.rs`) validates only:
  `program_config.admin == admin`, `base_mint != quote_mint`, `min_liquidity > 0`,
  fee-split sum `<= 10_000`, `weights_bps` sum `== 10_000`, strictly increasing
  `offsets_bps`, `expiry_slots > grace_slots`, `min_spread_bps <= max_spread_bps`,
  `utilization_max_bps <= 8_000`. There is **no mint allowlist** and no
  pair-specific assumption.
- PDA seeds: `vault = [b"vault", base_mint, quote_mint]`; base = WSOL,
  quote = USDC ordering is correct.
- Reserves are created as
  `token::mint = base|quote_mint, token::authority = vault`; `share_mint` is
  `decimals = 9, authority = vault`. Nothing is pair-specific.
- Mints are deserialized as classic `anchor_spl::token::Mint`, so Token-2022 is
  rejected; WSOL and Circle Devnet USDC are classic SPL Token.
- The Pyth feed id is stored per-`Config` (`config.pyth_feed_id`) and read on
  `update_quote`; the SOL/USD feed is appropriate for a WSOL/USDC pair.
- Mixed-decimal support is exercised by the on-chain suite: the lifecycle test
  mints base 9 / quote 6 (`vault/program/tests/litesvm_lifecycle.rs:171-172`).

## 2. Blockers

### B1 (critical) — keeper payload price vs program oracle check

- Keeper sets the payload field to the **decimal-normalized** price:
  `compute_quote` → `oracle_price_q64: price_raw`
  (`vault/keeper/src/lib.rs:567`), where
  `price_raw = normalize_price_q64(pyth_q64, base_decimals, quote_decimals)`
  (`:399`, `:606`). For 9/6 this **divides by 1000** (`:1288`).
- The program requires the payload to equal the **unscaled** Pyth Q64:
  `pyth_price_q64(price.price, price.exponent)` (`vault/program/src/lib.rs:530-533`),
  where `pyth_price_q64` applies no mint-decimal scaling (`:2234-2245`).
- Program tests encode the expected contract: with 9/6 mints the payload uses
  `PRICE_Q64 = 150<<64` from `PYTH_PRICE=15e9, EXPONENT=-8`
  (`vault/program/tests/common/mod.rs:105-109`, `litesvm_lifecycle.rs:72`).

Consequence: for a 9/6 pair the keeper would send `pyth/1000` while the program
expects `pyth`, so `update_quote` should revert `OraclePriceMismatch`. This
affects the **existing tSOL/tUSDC vault equally**; it is not new to WSOL/USDC.
The S2.2/S2.3 notes in `docs/PROGRESS.md` describe a keeper-side ladder
normalization, but the on-chain oracle comparison was not changed, so the two
sides disagree.

This was verified by source inspection and test vectors only; it should be
confirmed empirically with a single `update_quote` against the existing vault
(not performed here — state-changing).

> **RESOLVED in source (`s2-3f`, on `main`).** `update_quote` now computes the
> expected token-unit price **on-chain** from the verified Pyth value and the
> vault's own mint decimals (`normalize_pyth_price_q64`), and requires the keeper
> payload to equal it. Two read-only mint accounts were added to `update_quote`,
> bound by address to `vault.base_mint`/`vault.quote_mint`. Regression tests:
> `vault/program/tests/litesvm_oracle_scaling.rs`. A **program redeploy** is
> required for devnet to carry the fix; no deploy/state-changing tx was sent.

Likely fix direction (requires a design decision + program change + redeploy,
or a keeper change): either scale the Pyth price by the vault mints' decimals
on-chain (pass the two `Mint` accounts to `update_quote`), or keep the on-chain
comparison in human units and stop normalizing the payload while applying the
decimal scale only where amounts are valued. This is a math-spec change and
needs explicit approval (BuilderPlan §0 rule 7).

### B2 — no app pair selection

`app/src/chain/solana.ts` hard-codes `BASE_MINT`/`QUOTE_MINT` to tSOL/tUSDC;
`deriveVaultAddresses`/`fetchProtocolState` accept a pair but callers use the
constants. The app cannot select the WSOL/USDC vault without code changes.

### B3 — config/scripts are pair-specific (not a bug, a note)

`scripts/devnet/init_vault.devnet.json` is tSOL/tUSDC-specific. `vault/e2e`
`deposit` uses fixed `1e9` base / `1.1e8` quote atoms (1 base / 110 quote at
6 dp), not CLI-configurable. Do **not** repoint these at the new pair.

## 3. Derived addresses and existence checks (Devnet, read-only)

Program: `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm`. Mints:
WSOL `So11111111111111111111111111111111111111112` (9 dp) and
USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (6 dp).

| Account | Derived address | Exists? |
|---|---|---|
| vault | `8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt` | **yes** (owner = program) |
| config | `ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT` | **yes** |
| quote_state | `5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG` | **yes** |
| bond_vault | `9HtVpCHu51Vs8hBrCT46cJodLYTHgHWKNtLWfaPSdgAX` | no (created on first bond; `min_bond = 0`) |

Decoded vault state:

```
base_mint    So11111111111111111111111111111111111111112
quote_mint   4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
base_reserve 8vfr2KmMmXYUTjRg5cAiSYD6EhN1d8pjJnmFC95E2vfm
quote_reserve G8q1WMKT8fnGQh85kCB8Aihf6F7tctXJDKbA6gn1jPeS
share_mint   AyGcsmW6n8WvgHbHbw2SVbYAsWaw2XcYD5SyH9EdWeL9
share_lock   E5mxeoL32RYohrDP9ycGhG7F1hAtm8DQFmT6Bp3Cwm2a
total_shares 0   epoch 0   status 0 (Active)
```

```
config: keeper = treasury = 8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH,
        fee_bps = 1, min_bond = 0
quote_state: version 0, update_slot 0, expiry_slot 0   (no quote written)
reserves: 0 WSOL / 0 USDC     share supply: 0          (initialized, unfunded)
```

`program_config` (global) `J6MGfX1YvGq6yCP3eAqzbugpF83CTaBcTLKcmrxmBSok`
exists; admin `8R3V…` (matches the expected operator). `initialize_program` must
not be re-run.

## 4. Token verification (Devnet, read-only)

| Mint | Program owner | Decimals | Mint authority | Freeze authority |
|---|---|---|---|---|
| WSOL `So111…1112` | `Tokenkeg…` | 9 | none | none |
| USDC `4zMMC…` | `Tokenkeg…` | 6 | `GrNg1XM2ctzeE2mXxXCfhcTUbejM8Z4z4wNVTy2FjMEz` (Circle) | `CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT` (Circle) |

Both are classic SPL Token (not Token-2022). Circle USDC has a freeze authority —
expected for USDC; the program does not check it.

## 5. Initialization plan — **not required**

Because the vault already exists, no `initialize_vault` is needed. For the
record, the initializer would have required: admin `8R3V…` + 4 generated signer
keypairs (`base_reserve`, `quote_reserve`, `share_mint`, `share_lock`), a new
pair-specific config file with `base_mint = WSOL`, `quote_mint = USDC`, and the
same bounded parameters as the tSOL/tUSDC config. The existing tSOL/tUSDC vault
and this WSOL/USDC vault must both remain untouched.

## 6. Minimum practical first deposit (price ≈ 111.35 USD/SOL, read-only)

First deposit rule: `shares = floor(isqrt(base_atoms × quote_atoms)) − min_liquidity(1000)`.
The deposit must be proportional in both tokens. The practical binding
constraint is **USDC**: Circle's faucet provides ~20 USDC per address per 2 h,
while WSOL is wrapped from freely-airdropped devnet SOL.

| base | quote @111.35 | shares |
|---|---|---|
| 0.1 WSOL | 11.135 USDC | 33,368,147 |
| 0.18 WSOL | 20.043 USDC | 60,063,465 |
| 0.2 WSOL | 22.27 USDC | 66,737,294 |
| 1.0 WSOL | 111.35 USDC | 333,690,474 |

Recommendation: start with **0.2 WSOL + 22.27 USDC** (or the largest balanced
amount the operator can fund from the faucet), re-reading the Pyth price at
deposit time. Any amount satisfies the program; the ratio must match the oracle.

## 7. How users obtain the canonical tokens (no project mint authority)

- **WSOL:** airdrop devnet SOL, then wrap it (create the WSOL ATA, `solana transfer --to <wsol-ata>`, `spl-token sync-native`), or `spl-token wrap`.
- **USDC:** Circle Devnet faucet `https://faucet.circle.com` (~20 USDC per
  address per 2 h). No project key required.

## 8. Required code/config changes and tests

1. **Resolve B1** (oracle scaling): decide program-side vs keeper-side; land the
   change with unit + `litesvm` differential tests and a fresh golden vector;
   redeploy and re-verify the byte hash if the program changes.
2. **App pair selection** (B2): introduce a pair/registry so the UI targets
   either vault without mixing state; add a test that the WSOL/USDC vault decodes.
3. **Keeper config** for the second vault: a documented launch command using the
   WSOL/USDC vault/config/quote/reserve addresses (no code change needed once B1
   is fixed; keeper reads decimals from the mints).
4. **Docs:** add a second-vault deployment record mirroring `docs/DEVNET.md`.

## 9. Explicit statement

No state-changing Devnet transaction was sent: no initialization, no
`initialize_program`, no minting, no transfers, no deposit, no swap, no
authority changes, no keeper submission, no deploy/upgrade. Everything above is
read-only RPC inspection plus local source reading.
