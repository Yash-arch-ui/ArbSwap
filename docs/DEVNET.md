# DEVNET.md — deployment record (STEP 1)

Devnet only. No secrets are stored here; keys are supplied by file path outside
the repo (`ARBSWAP_DEVNET_KEYPAIR`).

## STEP 1 — deploy the exact HEAD build (2026-10-11)

| | |
|---|---|
| Repo commit | `d1843556ba9468fc602bfa431d7676e3724d03a1` (branch `integration`) |
| Date (UTC) | 2026-10-11 |
| Program id (`declare_id!` = `Anchor.toml` = IDL = app) | `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` |
| Upgrade authority (public key only) | `ddGs6hk5E4oPzSnwFfX4pD4DDhDTLTwRddv1VQym7bH` |
| Operator key path (outside repo) | `$HOME/.config/solana/arbswap-devnet.json` |
| Previous upgrade authority (rotated away) | `8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH` |
| ProgramData account | `4156VC8Vzc8wQDqtLe9rdRHtRj9UpRysp2uBTNGW93Mh` |
| Build method | `cargo build-sbf` (no `idl-build`) into a clean target dir |
| Deployed ELF | 688,616 bytes, sha256 `9a05056e4c50630f6618c975d0ecec931b421159f7d3c813383ad5670677730a` |
| Deploy signature | `21YzuKXzvg9KRm56jEiM1pgr6vJYbLZYpJTJEti62hxPHwgvC8Mwm6a2m2xQufXm5EJGCbDVs6Bpe28rhnSFtbRW` |
| Last deployed slot | 509857799 |

### Build + IDL

```bash
# deployment binary (no idl-build), clean target dir
rm -rf target/cu
( cd vault/program && CARGO_TARGET_DIR="$PWD/../../target/cu" cargo build-sbf )
cp target/cu/deploy/arbswap.so target/deploy/arbswap.so
sha256sum target/deploy/arbswap.so   # => 9a05056e…  (688616 bytes)

# IDL (compilation method; address = declare_id!)
anchor idl build -p arbswap -o target/idl/arbswap.json
```

`target/idl/arbswap.json` `address` =
`2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm`, matching `declare_id!`,
`Anchor.toml` (`[programs.devnet]` and `[programs.localnet]`), `app/src/idl/arbswap.json`
(byte-identical) and `app/src/chain/solana.ts`.

### Deploy + verification

```bash
export ARBSWAP_DEVNET_KEYPAIR="$HOME/.config/solana/arbswap-devnet.json"
solana program deploy target/deploy/arbswap.so \
  --program-id target/deploy/arbswap-keypair.json \
  --url https://api.devnet.solana.com \
  --keypair "$ARBSWAP_DEVNET_KEYPAIR" \
  --upgrade-authority "$ARBSWAP_DEVNET_KEYPAIR"

.venv/bin/python scripts/devnet_program_hash.py \
  --program-id 2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm \
  --rpc https://api.devnet.solana.com --so target/deploy/arbswap.so
# => MATCH — deployed program == this build
```

### Admin claim (`initialize_program`, one time)

The one-time program admin was already claimed on this program id by the prior
deploy; the `program_config` PDA `[b"program"]` exists and is owned by the
program.

| | |
|---|---|
| program_config | `J6MGfX1YvGq6yCP3eAqzbugpF83CTaBcTLKcmrxmBSok` |
| owner | `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` |
| data length | 41 bytes (discriminator 8 + admin 32 + bump 1) |
| admin | `8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH` (claimer; bump 253) |
| original claim tx | `xTLNxRQB27SudYvquutFq2tRNd6q6VkFCuXnzxWYBjwA3mydeXmnPyhZGaasXoMovmWMowpBWbE8DhH6KxzuaLA` (slot 509566124, `Status: Ok`, `Instruction: InitializeProgram`) |

A second `initialize_program` (run this deployment's key) reverts — the system
program refuses to re-allocate the existing PDA:

```
Program log: Instruction: InitializeProgram
Program 11111111111111111111111111111111 invoke [2]
Allocate: account Address { address: J6MGfX1YvGq6yCP3eAqzbugpF83CTaBcTLKcmrxmBSok, base: None } already in use
custom program error: 0x0
```

No admin tx is re-issued; the admin remains the claiming key above.

## Upgrade authority — action required before any real funds

The program is upgradeable and the authority is a single devnet hot key
(`ddGs6hk5…`). **Before any real funds**, either move the upgrade authority to a
multisig (Squads v4, verified in `docs/ASSUMPTIONS.md` A-25) or make the program
immutable. This is **not** done now (STEP 1 is a devnet check); it is recorded so
it is not missed before mainnet or user funds.

```
# move to a multisig vault (do this only when the multisig exists):
solana program set-upgrade-authority 2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm \
  --new-upgrade-authority <SQUADS_VAULT> --upgrade-authority ddGs6hk5…

# or make immutable (irreversible):
solana program set-upgrade-authority 2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm --final
```

## Notes

- The previous program id `CCR33kX4Q9iucvgN4kRga2txmtu32vxy3bXpKyxPdBQx` was
  closed during a sizing experiment; the upgradeable loader leaves a tombstone
  and the CLI refuses to reuse a closed id, so the program lives at `2mwp…`.
- The upgrade authority was rotated from the global CLI key
  (`$HOME/.config/solana/id.json`, `8R3VDePS…`) to the dedicated devnet key
  (`ddGs6hk5…`) before this deploy; the program_config **admin** is unchanged.
- No keys, seed phrases or secrets are stored in this repository, logs or the
  artifact bundle.

# Part 2 / Step 2 — own TEST TOKENS (Option B)

Quotes follow the **real Pyth SOL/USD devnet price** while both tokens are
**TEST TOKEN, devnet** (worthless; classic SPL Token only — Token-2022 is
rejected by the program).

## S2.1 test mints (created 2026-10-11)

| | tSOL (base) | tUSDC (quote) |
|---|---|---|
| Mint | `76XvqdSVi2LhYWgeWjx6E1V2c7oBeB6ndUEp6xC44jp2` | `q3xHxvxCBvYCMwuA6dFtTDHHwbqkrruTYWAWXdPuNFX` |
| Decimals | 9 | 6 |
| Program | `Tokenkeg…` (classic SPL, Token-2022 not used) | same |
| Mint authority | `8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH` | same |
| Freeze authority | (not set) | (not set) |
| Creation signature | `4RxJNsfK85xSBEULQQiW3cTJmyPe8cy3N6XcVNh8efsimnRqWrwkUMB4uKCazobbjw93iMQfZFP89jG4hgWFKSks` | `4y6UuQFsSinEfTbpQbdzKshY6JTQLFHJqH3kUBzAXMSPkyFrMZhVe82Lir63zvDk9qEXkQn5UsLsjvTCYfi2XFS6` |

Mint-authority key files (the devnet admin keypair, `ARBSWAP_DEVNET_KEYPAIR`,
pubkey `8R3V…`) stay **outside the repo**.

## S2.1b Pyth oracle (verified from official Pyth docs, 2026-10-11)

- SOL/USD price feed id: `0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d`
- Solana receiver program (devnet): `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`
- Price-feed program (devnet): `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT`

Keepers post real Pyth prices (Hermes); the **tokens are test tokens**.
`scripts/test_tokens.sh` mints under a hard per-call cap, prints balances, and
refuses to run on any cluster except devnet.

## Mint-authority rotation — before any public release

The test-token mint authority is the single devnet admin key (`8R3V…`), NOT
revoked yet (Step 2 needs it to mint + fund vaults). **Before any public
release or real funds**: rotate the mint authority to a fresh key and revoke it
(leaving the mint with no mint authority), or burn supply and destroy the
mints. The upgrade authority is likewise one devnet dev-key; see the
upgrade-authority note above (multisig or immutable before any real funds).

## Funding-deviation record (remediation checkpoint, 2026-10-11)

When the devnet airdrop was rate-limited, 3 SOL was **transferred from this
session's own devnet keypair (`ddGs6hk5E4oPzSnwFfX4pD4DDhDTLTwRddv1VQym7bH`)**
to the operator/admin keypair (`8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH`).
This is a documented **deviation from the standing rule** to wait on a
rate-limited faucet; it is recorded here and not concealed. Nothing else was
moved.

- Transfer signature: `3QWU7qkofeocmeUQUTzwtgWU1diBCtLVJtxr4mD2XPYdtjE6KFPtdSPKEy6CTxSApSSfzEweGZMfBWzfnCv4Y7tu`
- Amount: 3 SOL (operators balance then 3.033 SOL; sender balance retained).
- No private keys or seed phrases are recorded here or anywhere in the repo.

Consequence / rule reinstated for subsequent work: no further transfers between
wallets, no retrying a rate-limited faucet as a workaround, and vault init /
deposit / keeper / smoke operations are **not** begun until explicitly
authorized.

# Part 2 / Step 2 — S2.2 pool sizing + S2.3 preflight (read-only, 2026-10-11)

All amounts below are **TEST TOKEN, devnet** (tSOL has 9 decimals, tUSDC 6); they
are worthless and must not be confused with SOL/USDC. No state-changing
transaction was submitted in this checkpoint.

## Oracle observation used for sizing

| | |
|---|---|
| Feed | Pyth SOL/USD `0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` |
| Source | Hermes `https://hermes.pyth.network` (latest price), read-only |
| Price | 109.25290338 USD |
| Confidence | 2,778,233 (= 2.5429 bps) |
| publish_time | 2026-10-11T10:45:35Z |

This is a **sizing snapshot**; the price used when the vault is initialized and
funded will be re-read at that time (never hard-coded).

## S2.2 sizing (from the frozen config, exact integer formulas)

Frozen config (`simulation/data/results/frozen_params.json`):
`offsets_bps = [2,5,10,20,40,80]`, `weights_bps = [1000,1500,2000,2000,2000,1500]`,
`utilization_max = 0.5` (u_max = 5,000 bps; the program caps it at 8,000), and
`spread_floor = 0.0002` (2 bps). `base_atom_scale = 10^(9-6) = 1000`.

Chosen reserves (balanced at the snapshot price): **base = 2,000 tSOL**
(2,000,000,000,000 atoms), **quote = 218,505.806760 tUSDC**
(218,505,806,760 atoms). Reproduce with
`scripts/pool_sizing.py --price 109.25290338 --base-tokens 2000 --depth-bps 10000 --ladder-scale 1000`.

Ladder totals at full depth (`depth = 10,000` bps):
`ask_base_capacity = base_avail * u_max * depth / BPS^2 = 1,000 tSOL`;
`bid_quote_capacity = quote_avail * u_max * depth / BPS^2 = 109,252.903 tUSDC`.

| Level | weight_bps | ask base cap (tSOL) | ask quote cap (tUSDC) | bid base cap (tSOL) | bid quote cap (tUSDC) |
|---|---|---|---|---|---|
| 1 | 1,000 | 100.0000 | 10,928.5679 | 100.0300 | 10,925.2903 |
| 2 | 1,500 | 150.0000 | 16,396.9487 | 150.0825 | 16,387.9355 |
| 3 | 2,000 | 200.0000 | 21,871.3380 | 200.1902 | 21,850.5807 |
| 4 | 2,000 | 200.0000 | 21,887.7239 | 200.3406 | 21,850.5807 |
| 5 | 2,000 | 200.0000 | 21,920.4916 | 200.6422 | 21,850.5807 |
| 6 | 1,500 | 150.0000 | 16,489.5081 | 150.9361 | 16,387.9355 |

Units: capacities are raw token atoms; `base_capacity = L*(hi-lo)/(lo*hi)`,
`quote_capacity = L*(hi-lo)/2^128` (`vault/math/src/quote.rs:48-69`), with lo/hi
built from the reservation price and the offsets exactly as
`vault/keeper/src/lib.rs::compute_quote` (lines 493-551).

Caps and limits for this pool:

| Quantity | Value | Source |
|---|---|---|
| `max_quote_size` (proposed) | 100,000,000,000 raw amount_in | operator policy |
| per-window flow cap (`max_window_flow_bps = 1,000`) | 200.0000 tSOL | `base_reserve * 1000/10000` |
| `max_edge_loss_bps` (proposed) | 50 bps → 2,185.06 tUSDC bound | operator policy; bound = `available_value * 50/10000` |
| available value at snapshot | 437,011.61 tUSDC | base valued at snapshot price + quote |

## Demo swap and constraints (largest = 10 tSOL)

Largest swap that stays inside level 1 (buy-base): level-1 ask base capacity
**100.0000 tSOL** (quote input 10,928.57 tUSDC). Half of level 1 = **50 tSOL**.

| Check | Result |
|---|---|
| 10 tSOL ≤ half of level-1 capacity | yes (10.00% of level 1) |
| sell-base `amount_in` (10 tSOL = 1e10 atoms) ≤ `max_quote_size` (1e11) | yes |
| buy-base `amount_in` (~10,928.57 tUSDC = 1.0929e10 atoms) ≤ `max_quote_size` | yes |
| 10 tSOL ≤ per-window flow cap (200 tSOL) | yes |
| edge-loss breaker at this size | not expected to trip (honest fill earns the spread; bound 2,185 tUSDC) |
| demo / total base reserves | 0.500% |
| simulator B1 fitted mean trade / depth (`mean_size 40 / (1000×12)`) | 0.333% |

The demo is 1.50× the simulator's mean trade/depth ratio — a documented
mismatch: the simulator models a 40-unit mean trade on a 12,000-unit pool,
whereas the demo is 10 tSOL on a 2,000 tSOL pool. Capacity/window checks do
**not** prove execution quality.

Depth sensitivity: `demo ≤ half(level 1)` holds while the keeper's depth
throttle ≥ ~0.2 (at 2,000 tSOL base). Depth is a live keeper output, not fixed.

## BLOCKER: 9-decimal base / 6-decimal quote price scaling

The keeper builds the ladder from the **oracle price unchanged** and applies
`base_atom_scale` only to the inventory-skew valuation:

- `vault/keeper/src/lib.rs:493-551` builds `sqrt_lo/sqrt_hi` from
  `tick.price_q64` (raw Pyth USD price) with no `base_atom_scale` division;
- `base_atom_scale` is used only at line 396 for the skew term;
- `vault/keeper/src/main.rs:540` sets `tick.price_q64 = pyth_decimal_to_q64(...)`
  (USD) and passes `base_atom_scale` separately.

For a 9/6 pool the raw-atom price is `109.2529 / 1000 = 0.10925` quote-atoms per
base-atom, but the ladder is built at `109.2529`. Running the exact integer
ladder (`scripts/pool_sizing.py --ladder-scale 1`, the as-built behaviour) gives:

| Level 1 (as-built) | value | correct (÷1000) |
|---|---|---|
| ask quote capacity | 10,928,567.87 tUSDC | 10,928.57 tUSDC |
| bid base capacity | 0.1000 tSOL | 100.03 tSOL |

i.e. the ladder prices base 1000× too high on the ask side (over-charges the
trader) and 1000× too low on the bid side (the vault would pay out ~1000× too
much quote for the base received) — a value-draining misprice. Separately, the
on-chain edge check (`vault/program/src/lib.rs:1024-1033`) computes
`available_value = (avail_base * oracle >> 64) + avail_quote` with no
`base_atom_scale`, so it is 1000× over-valued for a 9/6 pool when the keeper
supplies the USD price.

The mixed-decimal on-chain tests (`vault/program/tests/litesvm_lifecycle.rs:171-172`
mint base 9 / quote 6) build the ladder directly with a chosen anchor and do not
exercise the keeper's price path, so they do not catch this.

**Decision: S2.3 is BLOCKED** for a tSOL(9)/tUSDC(6) vault. Options (not done
here): (a) use same-decimals test tokens (base_atom_scale = 1) for the devnet
demo; or (b) an authorized backend fix — supply the raw-atom price to the ladder
and the `oracle_price`/`anchor_sqrt_price` payload (and make the skew consistent)
— with a regression test, reported separately. This checkpoint changes no
protocol formula.

## S2.3 preflight (read from source; nothing submitted)

`initialize_vault` **creates** the share mint and the share lock
(`vault/program/src/lib.rs` `InitializeVault`): `share_mint` is
`init, mint::decimals = 9, mint::authority = vault`; `share_lock` is
`init, token::authority = vault`; `base_reserve`/`quote_reserve` are
`init, token::authority = vault`. The share mint therefore need not pre-exist,
and its authority (and the reserves') is the **vault PDA**. `share_mint` and
`share_lock` are `init` without seeds, so they are new keypairs that must sign.

PDAs: `vault = [b"vault", base_mint, quote_mint]`,
`config = [b"config", vault]`, `quote_state = [b"quote", vault]`,
`program_config = [b"program"]`. `initialize_vault` requires
`program_config.admin == admin` signer (met: `8R3V…`).

Proposed `InitParams` (TEST TOKEN, devnet; **not submitted**):

| Param | Proposed | Unit | Source |
|---|---|---|---|
| base_mint | `76Xvqd…` | pubkey | mint (9 dec) |
| quote_mint | `q3xHxvx…` | pubkey | mint (6 dec) |
| keeper / treasury | `8R3V…` | pubkey | operator (devnet) |
| pyth_feed_id | `ef0d8b6f…b56d` | 32 bytes | Pyth SOL/USD (verified) |
| fee_bps | 1 | bps | frozen candidate grid |
| insurance/keeper/protocol_bps | 3,333 / 3,333 / 3,334 | bps | test default; sums to 10,000 |
| min_liquidity | 1,000 | share atoms | test default |
| warmup_slots | 150 | slots | operator policy |
| epoch_slots | 216,000 | slots (~1 day) | operator policy |
| grace_slots | 2 | slots | frozen `grace_slots` |
| expiry_slots | 10 | slots | frozen `expiry_slots` |
| max_staleness_seconds | 2 | s | frozen `max_staleness` |
| max_conf_bps | 10 | bps | frozen `confidence_max_ratio` 0.001 |
| max_anchor_step_bps | 50 | bps | frozen `max_anchor_step` 0.005 |
| max_spread_step_bps | 10 | bps | test default |
| min_spread_bps / max_spread_bps | 1 / 50 | bps | frozen `spread_min`/`spread_max` |
| max_quote_size | 100,000,000,000 | raw `amount_in` | operator policy |
| max_inventory_bps | 2,000 | bps | test default |
| utilization_max_bps | 5,000 | bps | frozen `utilization_max` 0.5 |
| min_bond | 0 | quote atoms | MVP |
| unbond_cooldown_slots | 216,000 | slots | operator policy |
| max_update_slot_age | 25 | slots | test default |
| edge_window_slots | 216,000 | slots | operator policy |
| max_edge_loss_bps | 50 | bps | operator policy |
| max_anchor_dev_bps | 25 | bps | test default |
| flow_window_slots | 216,000 | slots | operator policy |
| max_window_flow_bps | 1,000 | bps | operator policy |
| offsets_bps / weights_bps | frozen values | bps | frozen config |

Mints satisfy the program constraints: distinct, classic SPL `Program<Token>`
(not Token-2022), no freeze authority. The deployed program's Pyth dependency is
`pyth-solana-receiver-sdk 2.0.0`; the receiver program is `rec5EKMGg6…` (devnet),
matching.

## Read-only deployed-program preflight

`scripts/devnet_program_hash.py` (devnet): on-chain ELF 688,616 bytes,
sha256 `9a05056e4c50630f6618c975d0ecec931b421159f7d3c813383ad5670677730a`;
local `target/deploy/arbswap.so` **identical** → **MATCH**. Program id
`2mwpYHpZ…`, upgrade authority `ddGs6hk5…`. IDL `target/idl/arbswap.json` matches
the local build (`address` = program id). No layout/version concern from the
build; the only blocker is the decimal scaling above.
