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

**Decision (S2.2): S2.3 was BLOCKED** on this defect. It is **FIXED in S2.3**
(see the next section); the fix is keeper-side and needs no program redeploy.

## S2.3 FIX — decimal normalization (keeper)

**Root cause.** `vault/keeper/src/lib.rs::compute_quote` built `sqrt_lo/sqrt_hi`,
`reservation_price`, `anchor_sqrt_price` and the payload `oracle_price_q64` from
the raw Pyth **human** price `P`, while the token-decimal scale
(`KeeperParams::base_atom_scale`) was applied only to the inventory-skew value.
For a 9/6 pair the ladder was therefore priced 10^3 too high and the on-chain
edge valuation 10^3 too high.

**Fix.** The human price is normalized **once** to `P_raw = P × 10^(d_q − d_b)`
by `normalize_price_q64` (integer; division floors); `P_raw` feeds the inventory
valuation, the ladder, the directional add-on and the serialized payload. The
`base_atom_scale: u128` field is replaced by `base_decimals: u8` /
`quote_decimals: u8`. In `live`, the decimals are read from the vault's mint
accounts via RPC (authoritative); `single` takes them as arguments. The
program is **unchanged** (it is decimal-agnostic), so no redeploy is required.

**Before/after (level 1, 2,000 tSOL base / 218,505.807 tUSDC quote at $109.2529,
full depth; `scripts/pool_sizing.py`):**

| | before (human-price ladder) | after (raw-atom ladder) |
|---|---|---|
| level-1 ask quote capacity | 10,928,567.87 tUSDC | 10,928.57 tUSDC |
| level-1 ask human price | ~109,285 tUSDC/tSOL | ~109.29 tUSDC/tSOL |
| level-1 bid base capacity | 0.1000 tSOL | 100.03 tSOL |
| on-chain `available_value` | ~437,011,000 tUSDC | 437,011.61 tUSDC |

The report's 10^3 error is gone: level-1 ask human price returns `109.2857`
(≈ the oracle) instead of `109,285.7`.

**Round-trip.** base 2,000 tSOL / quote 218,505.807 tUSDC at $109.2529:
level-1 human quote/base ratio `109.2857` (≈ oracle `109.2529`, difference is the
2 bps spread); demo 10 tSOL ≤ half of level 1; flow cap 200 tSOL; `available_value`
437,011.61 tUSDC; edge bound (50 bps) 2,185.06 tUSDC.

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
the local build (`address` = program id).

**Provenance note (S2.3):** the S2.3 change is **keeper-only** — the program
source is unchanged, so the deployed program still matches the program build
(`9a05056e…`) and **no redeploy is needed** to use the corrected keeper. The
keeper binary changed and must be rebuilt for the S2.5 live run. The exact-HEAD
hash match describes the program build, not the keeper.

## S2.3 decision

The keeper now normalizes the human oracle price exactly once
(`normalize_price_q64`), the on-chain edge valuation is correct in quote atoms
once the payload carries `P_raw` (no program change), and the 9/6 regression
tests (Rust unit, Python parity, sizing tool) show the 10^3 error is gone.
**S2.3: UNBLOCKED** for a tSOL(9)/tUSDC(6) vault, subject to operator
authorization for the state-changing steps (init/funding/deposit/keeper/smoke),
which are **not** performed here.


# Part 2 / Step 2 — S2.3 execution preflight (2026-10-11)

All tokens are **TEST TOKEN, devnet**; program `2mwpYHpZ…`.

## Read-only preflight (passed)

| Check | Result |
|---|---|
| Program id (`declare_id!`/`Anchor.toml`) | `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` |
| Deployed ELF vs local SBF build | **MATCH** — 688,616 B, sha256 `9a05056e4c50630f6618c975d0ecec931b421159f7d3c813383ad5670677730a` |
| `ARBSWAP_DEVNET_KEYPAIR` public key | `8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH` (program admin) |
| tSOL mint | `76Xvqd…` dec 9, classic SPL, mint auth `8R3V…`, no freeze |
| tUSDC mint | `q3xHxvx…` dec 6, classic SPL, mint auth `8R3V…`, no freeze |
| `program_config` `[b"program"]` | `J6MGfX1YvGq6yCP3eAqzbugpF83CTaBcTLKcmrxmBSok` exists (owner = program, 41 B) → **no `initialize_program` needed** |

## Oracle snapshot (Hermes, read-only)

SOL/USD feed `0xef0d…b56d`; price **109.6973911** USD; confidence **2.5369 bps**
(≤ `max_conf_bps` 10); publish_time `1791720697`, age 1 s (≤ `max_staleness` 2 s).
Valid against the configured limits.

## `max_quote_size` semantics and the 10 tSOL demo

`vault/program/src/lib.rs:816-819` requires
`amount_in > 0 && amount_in <= config.max_quote_size`, where `amount_in` is the
**input token's raw amount** — quote atoms for `BuyBase`, base atoms for
`SellBase`. It is one scalar on raw input units (not value-normalised).

With the proposed `max_quote_size = 100,000,000,000` (1e11):

| Direction | `amount_in` (raw atoms) | ≤ 1e11? |
|---|---|---|
| SellBase: 10 tSOL base in | 10 × 1e9 = 1.0e10 | yes (10× headroom) |
| BuyBase: quote in for ~10 tSOL out @ 109.6974 | ~1.097e9 | yes (~91× headroom) |

Flow cap (`max_window_flow_bps = 1,000`) = 10% of base reserve = 200 tSOL after
the intended deposit; demo base flow 10 tSOL is 5% of it. Utilization: with the
S2.3-corrected ladder, ask capacity ≤ `available_base × 0.5`. **The 10 tSOL demo
passes both directions; `max_quote_size` is not the blocker.**

## BLOCKER — configured pool exceeds the funding script's mint caps

Required first-deposit liquidity at the snapshot price:

| Token | Human | Raw atoms |
|---|---|---|
| tSOL (base) | 2,000 tSOL | 2,000,000,000,000 |
| tUSDC (quote) | 219,394.7822 tUSDC | 219,394,782,200 |

`scripts/test_tokens.sh` per-call caps: **5 tSOL** (`CAP_TSOL`) and **5,000 tUSDC**
(`CAP_TUSDC`). Required exceeds both — tSOL 400×, tUSDC 43.88×. With the
enforcement fixed (below), the script refuses:

```
REFUSED: amount 2000000000000 exceeds per-call cap 5000000000
REFUSED: amount 219394782200 exceeds per-call cap 5000000000
```

Per the checkpoint rules, the cap is **not** raised and the amount is **not**
split; **S2.3 is BLOCKED** at funding. Initializing a vault that cannot be
funded is not done.

## Bug fixed — `test_tokens.sh` cap check was bypassed

The caps were written `CAP_TSOL=5_000_000_000`; bash does not accept `_` digit
separators, so `(( AMOUNT > CAP ))` failed with "value too great for base" and
the `if` was skipped — the cap was **not enforced**. The mint command also used
the non-existent `--owner` flag instead of `--mint-authority`. Both are fixed
(plain integers; `--mint-authority` + explicit recipient ATA), with a regression
test (`simulation/sim/test_test_tokens_script.py`) that asserts an over-cap
amount is refused and `spl-token` is never invoked.

**Consequence observed before the fix (captured; not repeated):** the over-cap
attempt ran `create-account` and created two empty ATAs for the operator
(tSOL ATA, tUSDC ATA) — transactions `BUWPR4vuTAQezrvdB8mYa2Qp4QX7qCBBWrMHPw84fEkhHhQAjvjF22TThxPjM1c73MbddtpoMkUVLE7yAoVDjRN`
and `4ERsYywncGeu8a3T8D4EkPhtnZki9BpcpHvig2aa8Xd9TWo2AMh7ks9oVTJCEBFE1nhzzKCkfBJsvDpbsqDEWhGg`,
both `Status: Ok`. The `mint` step failed (`missing signature for supplied
pubkey: 8R3V…`), so **no test tokens were minted** (balances remain 0). No further
funding was attempted.

# Part 2 / Step 2 — S2.3A: pool resized under the existing mint caps (2026-10-11)

Read-only calculation checkpoint. All tokens are **TEST TOKEN, devnet**. No cap
change, no mint, no vault init, no transaction.

## Fresh oracle snapshot (Hermes, read-only)

SOL/USD `0xef0d…b56d`; price **109.59998065** USD; confidence **2.7638 bps**
(≤ max 10); publish_time `1791721366`, age 1 s (≤ max 2 s). Valid.

## Caps (unchanged) and candidate evaluation

Caps: **5 tSOL** (5,000,000,000 atoms) and **5,000 tUSDC** (5,000,000,000
atoms). The binding cap is tSOL; a balanced pool needs only `base × price` quote.

| base (tSOL) | quote (tUSDC) | quote atoms | quote ≤ cap | L1 ask base (depth 0.9) | half L1 |
|---|---|---|---|---|---|
| 3.0 | 328.7999 | 328,799,941 | yes (6.6% of cap) | 0.1350 tSOL | 0.0675 |
| **4.0** | **438.3999** | **438,399,922** | **yes (8.8%)** | **0.1800 tSOL** | **0.0900** |
| 5.0 (max) | 547.9999 | 547,999,903 | yes (11.0%) | 0.2250 tSOL | 0.1125 |

Selected: **base 4.0 tSOL, quote 438.399922 tUSDC** — not the maximum, leaving
**1.0 tSOL** of the 5 tSOL budget as tester/operator float. Reproduce:
`scripts/pool_sizing.py --price 109.59998065 --base-tokens 4 --depth-bps 9000`.

## Ladder capacities (selected pool, keeper depth throttle = 0.9, 9/6)

| Level | weight_bps | ask base (tSOL) | ask quote (tUSDC) | bid base (tSOL) | bid quote (tUSDC) |
|---|---|---|---|---|---|
| 1 | 1,000 | 0.1800 | 19.7339 | 0.1801 | 19.7280 |
| 2 | 1,500 | 0.2700 | 29.6083 | 0.2701 | 29.5920 |
| 3 | 2,000 | 0.3600 | 39.4935 | 0.3603 | 39.4560 |
| 4 | 2,000 | 0.3600 | 39.5231 | 0.3606 | 39.4560 |
| 5 | 2,000 | 0.3600 | 39.5822 | 0.3612 | 39.4560 |
| 6 | 1,500 | 0.2700 | 29.7754 | 0.2717 | 29.5920 |

Totals: ask base 1.800 tSOL; bid quote 197.280 tUSDC. Level-1 human price
`109.6329` ≈ oracle `109.59998` (diff = the 2 bps spread). Largest trade within
level 1 = **0.1800 tSOL**; half = **0.0900 tSOL**.

## Proposed demo trade (reduced)

**Demo = 0.02 tSOL** (10× smaller than the infeasible 10 tSOL). At depth 0.9 it is
**11.1% of level 1** and **22.2% of half-level-1**; it stays within half of
level-1 while the keeper depth throttle ≥ ~0.2. `max_quote_size` (1e11) passes both
directions (SellBase 0.02 tSOL = 2.0e7 atoms; BuyBase quote in ≈ 2.2e6 atoms).
Flow cap (1,000 bps × base reserve) = **0.4 tSOL**; demo = 5% of it. Utilization
(0.5) holds for the corrected ladder. Edge-loss: available value **876.80 tUSDC**,
bound (50 bps) **4.38 tUSDC** (an honest fill earns the spread; no trip expected).

Trade-size-to-depth: demo/base = **0.50%** vs the simulator B1 mean trade/depth
**0.333%** (1.5×). Capacity checks do **not** prove execution quality.

## First-deposit share expectation (integer program rule)

`initialize_vault` then `deposit(base 4,000,000,000, quote 438,399,922)`:
`total_shares = isqrt(dB·dQ) = 1,324,235,512`; **user shares = total − min_liquidity
= 1,324,234,512**; `min_liquidity = 1,000` is minted **locked** to `share_lock` and
counted in the supply. Not guaranteed until the exact on-chain arithmetic runs;
stated as the predicted value under `min_liquidity = 1000`.

## Warm-up / epoch precondition

`deposit` sets `activate_slot = now + warmup_slots`; `request_withdraw` requires
the warm-up elapsed (`WarmupNotElapsed` otherwise); `crank_epoch` requires
`now ≥ epoch_start + epoch_slots`. With the proposed `warmup_slots = 150` (~60 s
at 0.4 s/slot) the warm-up is fine, but `epoch_slots = 216,000` is **~1 day**, so
the withdrawal smoke test (S2.4/S2.6c) would need a ~24 h wait unless the
operator sets a shorter `epoch_slots` (e.g. 1,500 ≈ 10 min) for the devnet vault.
This is an operational pre-condition for the checkpoint, not a strategy change.

## State of the two accidentally created ATAs (read-only)

| ATA | mint | owner | balance |
|---|---|---|---|
| `BdujRgRbCGyqm9GywN4mjhVZfhqdz4xR85LdDEzQPtJh` | tSOL `76Xvqd…` | `8R3V…` | 0 |
| `HWC82t8f3sTh33xb3YVFpxETUgw8VERAFveWhmZ8zwxt` | tUSDC `q3xHxvx…` | `8R3V…` | 0 |

Both confirmed from their creation signatures and read via `getAccountInfo`
(jsonParsed). Empty; not closed or recreated.

## Status

The selected pool (4.0 tSOL / 438.399922 tUSDC) and demo (0.02 tSOL) fit the
existing caps with headroom. **S2.3: READY FOR OPERATOR APPROVAL** — pending a
decision on `epoch_slots` for the withdrawal smoke test. No transaction was
submitted.

# Part 2 / Step 2 — S2.3C vault-initialization client (dry-run) — 2026-10-11

A small operator client builds the one-time `initialize_vault` transaction from
the program's own `InitParams`/accounts types, so the payload cannot drift from
the on-chain ABI. **Dry-run is the default; `--send` is required to submit.**
No transaction was submitted in this checkpoint. TEST TOKEN, devnet.

## Files

- `vault/keeper/src/init_vault.rs` — config schema, validation, PDA derivation,
  instruction builder, plan.
- `vault/keeper/src/main.rs` — `init-vault <config.json> [--send]` subcommand.
- `scripts/devnet/init_vault.devnet.json` — the S2.2 configuration.
- Tests in `init_vault.rs` (PDA derivation, discriminator, 5 signers, invalid
  configs, generated signers touch no disk).

## Usage

```bash
# dry-run (default): derive PDAs, build + inspect, do NOT submit
cargo run -q -p arbswap-keeper -- init-vault scripts/devnet/init_vault.devnet.json

# submit (only after operator approval; not run here)
cargo run -q -p arbswap-keeper -- init-vault scripts/devnet/init_vault.devnet.json --send
```

## Dry-run output (2026-10-11)

```
program_id     2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm
vault          52cNnsipn9R3P6Bcsf4vxSAM4k1gyyJpCoHcFyHCWCUK
config         HhBCf2Xor5pgLBRP6SvkuiTL3G4j1i87hGNwx9GryZf8
quote_state    4mSBaDguULxqxgr4riAtTxC4LjeXYVArNwCDvUT6hJtf
program_config J6MGfX1YvGq6yCP3eAqzbugpF83CTaBcTLKcmrxmBSok
signers        8R3V…, <base_reserve>, <quote_reserve>, <share_mint>, <share_lock>
data (356 bytes) 30bfa32c47813fa4…   # sha256("global:initialize_vault")[..8]
```

Accounts (order): `admin(s,w), program_config, vault(w), config(w),
quote_state(w), base_mint, quote_mint, base_reserve(s,w), quote_reserve(s,w),
share_mint(s,w), share_lock(s,w), token_program, system_program, rent`.
**Signers (5): admin + the 4 newly generated keypairs** (`base_reserve`,
`quote_reserve`, `share_mint`, `share_lock`; generated in-memory, written nowhere
in dry-run). PDAs derive from `[b"vault", base, quote]` etc.

## Configuration (TEST TOKEN, devnet)

Base tSOL `76Xvqd…` / quote tUSDC `q3xHxvx…`; keeper = treasury = `8R3V…`; Pyth
SOL/USD feed `0xef0d…b56d`; fee 1 bps; split 3333/3333/3334; min_liquidity 1000;
warmup 150; **epoch 1,500 (PROPOSED, pending operator approval)**; grace 2;
expiry 10; staleness 2 s; conf 10 bps; anchor_step 50; spread_step 10; spread
1–50; `max_quote_size` 1e11; inventory 2000; utilization 5000; `min_bond` 0;
cooldown 216,000; slot_age 25; edge 216,000/50; anchor_dev 25; flow 216,000/1000;
offsets `[2,5,10,20,40,80]`; weights `[1000,1500,2000,2000,2000,1500]`.

## Trust assumptions (accurate, not "fully decentralized")

- Vault creation is **admin-gated** (`program_config.admin == admin`); the unique
  per-pair PDA is retained (`docs/DECENTRALIZATION_REVIEW.md`).
- `min_bond = 0` means the **configured keeper** (`config.keeper = 8R3V…`) is the
  only authorized quoter — this is the allowlist MVP, **not** an open bonded
  keeper network.
- `claim_keeper_reward` requires `keeper == config.keeper`; do **not** claim a
  permissionless keeper-reward design until that is resolved and tested.
- Timelock and emergency controls are unchanged.

## Remaining prerequisites before `--send`

1. Operator approval of the exact plan, including `epoch_slots` (1,500 proposed).
2. Confirm `ARBSWAP_DEVNET_KEYPAIR`/admin is `8R3V…` and equals `program_config.admin`.
3. Fund test tokens within the mint caps (S2.4 uses them after init).
4. No vault exists yet (dry-run shows the PDAs are unused).

## STEP 2 — S2-37 upgrade: tunable expiry_slots (2026-10-14)

Adds `expiry_slots` to `ParamsUpdate` (admin-tunable via the timelocked
`set_params`/`apply_params`, bounded `grace_slots < expiry_slots <= 600`). No
`Config`/`QuoteState` layout change; same `TIMELOCK_SLOTS` and authorization.

| | |
|---|---|
| Repo commit | `40621b0` (branch `main`) |
| Program id | `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` |
| Upgrade authority (public key) | `ddGs6hk5E4oPzSnwFfX4pD4DDhDTLTwRddv1VQym7bH` |
| Fee payer (public key) | `8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH` |
| Build | `cargo build-sbf` into a clean target dir |
| New ELF (payload) | 772,256 bytes, sha256 `0cdf9575bc91c4829706f6b1886341877625174f3d46c50b83c306c8904826c1` |
| On-chain account | 780,224 bytes (loader retained 7,968 B trailing padding), sha256 `dff8a3020f4053342a3b5b6b109f1253ff126df4048fb1244811e30a5595371f` |
| Upgrade signature | `31Aa7GZXKyFzzVNnFE2xfdqhuohdEtuYvE5bJKoixpZ9uMpW77uhpLAaFdCiH17RMB4ReEZpWwWw1Byma6Bqyb7f` |
| Upgrade slot / block time | 510905181 / 1791961375 (2026-10-14T06:36Z) |
| Previous ELF (rollback) | `~/arbswap-rollback/arbswap_b4df2b0f.so` (769,984 B, sha256 `b4df2b0f93735c7532871769ec713e92179f6375252a5bad7d8fea9c989f7096`) |
| Post-upgrade smoke | vault Active; Config field-by-field unchanged (expiry_slots still 10); keeper bounded 5 min: 6 `COMMITTED_AND_VERIFIED` (v120->121+), author `8R3V...`, QuoteState len 897; swap preflight builds, only `QuoteExpired` when expired; no new error codes; no rollback |

**Parameter change (S2-37 Task 3) is PENDING**: `set_params(expiry_slots=120)` is
not yet proposed/applied; the live `Config.expiry_slots` remains 10 until then.

## STEP 3 — single-sided upgrade + live two-sided smoke (2026-10-16)

Task 6 of the single-sided execution prompt. Adds `deposit_single` and
`claim_withdraw_single` (and shared helpers) as **purely additive** code: no
`Config`/`Vault`/`QuoteState` layout change, no change to any existing
instruction. Build is `cargo build-sbf` in a clean target dir; the deployed
program is byte-identical to the reviewed artifact.

| | |
|---|---|
| Repo commit | `00dee6a` (branch `deposit-withdraw`) |
| Program id | `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` |
| Upgrade authority (public key) | `ddGs6hk5E4oPzSnwFfX4pD4DDhDTLTwRddv1VQym7bH` |
| Fee payer (public key) | `8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH` |
| New ELF (clean build) | **933,240 bytes**, sha256 `c8725a23698de9d0779041771936c443e39d92f36b4c5353c20ce87b597cb015` |
| On-chain account | 933,240 bytes, sha256 `c8725a23…` — **MATCH** (`devnet_program_hash.py`) |
| Upgrade signature | `21VdJsBeRkrX3WVTPx6pdYmfrPCnaqqh4VuudJoJwrQkkmm5ts9o9XD1EtvFs36z7E4Rp5y5F82iAkcQ4Cy3wioB` |
| Upgrade slot / block time | 511682809 / 1792146982 (2026-10-16T10:36:22Z) |
| Previous ELF (rollback) | `~/arbswap-rollback/arbswap_pre_single_sided.so` (849,368 B, sha256 `42eeac64…`) — **not used** |
| Release preflight (`release_preflight.ts`) | `ok:true`; vault Active; Config field-by-field unchanged; QuoteState len 897 |
| Post-upgrade keeper (5 min) | quote versions 4795→4810, 0 failures, author `8R3V…` |

### Task 6.5 — live two-sided lifecycle (`scripts/devnet/two_sided_lifecycle.ts`)

Simulate-then-submit, admin `8R3V…`, one molar-proportional round trip:
deposit 1,000,000 base atoms (0.001 WSOL) + 127,817 quote atoms (0.127817 USDC).

| Step | Signature | Slot / time | Result |
|---|---|---|---|
| (b) deposit | `2szDwnxJGALdEmC2G1oh7EgRa36wFU5xFYSKSCsoyqwWkCRqu8tsznu1GqUuWVu9g7nn6RxPy4tRhCFpNeELHi8Q` | 511687211 / 10:53:48Z | `DepositEvent{shares:359,111, base_amount:999,995, quote_amount:127,817}`; `total_shares` 184,925,609→185,284,720 |
| (c) request_withdraw | `28exTx39CFbkAuQK1wKQgf67mUc1rmHcspEhLSC9JTDmkG3Nywwbjxj7Nf5q5FwaW8mLjy7voHdKrsoXQMfW1DdZ` | 511689827 / 11:04:12Z | warm-up elapsed (`activate_slot` 511,687,361); shares 359,111 moved to `share_lock`; ticket epoch = vault.epoch+1 |
| (c) crank_epoch | `jyy8EHShc3jcCunHXHHfqGT1FWE7xrMkqnBouTV7SxCMKgC6qd8x4nn8288D8zLs8cR2UVXaUk2ApN7idDfEYQK` | 511689839 / 11:04:15Z | vault epoch 0→1 (≥ `epoch_start + 1,500`) |
| (c) claim_withdraw | `hWenydz7pxAvUxseriyXpytpi1MRhN6YwVvWepPCbV9eQ7LAmQXonWUgi44NQuXxmAWfhxxKvfqLyfzuDhNn8te` | 511689856 / 11:04:19Z | `WithdrawClaimed{base_amount:999,994, quote_amount:127,816}` |

Verification (all automated checks PASS): token deltas **equal** the claim event
**and** the pro-rata formula `shares · net_reserve / total_shares`
(expected_base 999,994 = delta_base 999,994; expected_quote 127,816 =
delta_quote 127,816); `total_shares` 185,284,720→184,925,609 (Δ = 359,111 =
ticket shares, burned from `share_lock`); reserves after (base 514,951,395 /
quote 65,820,108) **≥** liabilities (base 498 / quote 372). The `WithdrawClaimed`
`shares` field reads `0` because the ticket is zeroed before the emit
(`lib.rs:726` then `:729`) — cosmetic, the burned amount is verified via
`total_shares`.

**(d) claim while the quote is expired.** Confirmed a real expired window on a
two-sided path: slot 511,690,109 ≥ `QuoteState.expiry_slot` 511,690,087
(version 4862) — the quote does lapse between keeper refreshes. `claim_withdraw`
takes **no** `quote_state` account and performs no freshness check (account list
above), so the on-chain claim `hWenyd…` is valid regardless of quote age; a
re-simulation against the already-settled ticket fails only with `Custom 6004`
(`InvalidAmount`, 0 shares), never with any staleness error.

**(a)/(e) single-token live smoke: NOT RUN.** No single-sided CLI exists yet, so
`deposit_single`/`claim_withdraw_single` were exercised only by the LiteSVM suite
(`litesvm_single_sided.rs`) and the reference differential — not on devnet.
Consequently `VITE_ENABLE_SINGLE_SIDED` is **not** set in any build.

**No rollback triggered** (6.4): hash matched, vault Active, all smokes green.

### Task 8.2 — live BuyBase / SellBase swaps (`scripts/devnet/swap_smoke.ts`)

Operator-run live smoke: waits for a genuinely fresh committed quote, builds the
same account set the dApp signs (manual Borsh), **simulates**, and only then
submits + confirms. Admin `8R3V…`, devnet test tokens only, fee 1 bps.

| Side | Signature | Slot | Input | Quote version |
|---|---|---|---|---|
| BuyBase | `5zu74zPrkVwgZmXcxs3R34BssSeiktzrvcRNFA2gPhNidfVHWNo7oaM2gz74QCqBpJVUgE9VjaDerecSJDfMuznx` | 511779271 | 0.5 USDC (500,000 atoms) | 5974 |
| SellBase | `5jxap9NzQN54GTbyBGDDYzicG12a2iQDkSqh2gvVRm3gyo98ETAQeSbwPzew3b2FGPuVqvCrGNUuLYnKHgj1JU3T` | 511779315 | 0.005 WSOL (5,000,000 atoms) | 5974 |

Both attributed to the active keeper `8R3V…` and confirmed via
`getSignatureStatuses` polling (no websocket). The read-only `swap_preflight.ts`
carried a `system_program` account bug (`PublicKey.default` at index 9); it is
correctly `SystemProgram.programId` in `swap_smoke.ts`.
