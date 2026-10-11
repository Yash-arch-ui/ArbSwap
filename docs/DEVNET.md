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
