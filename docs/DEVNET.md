# DEVNET.md — devnet deployment record

**Status: DEPLOYED + admin claimed.** No secrets below (program id and account
addresses are public).

| Item | Value |
|---|---|
| Cluster | `https://api.devnet.solana.com` |
| Program id | `CCR33kX4Q9iucvgN4kRga2txmtu32vxy3bXpKyxPdBQx` |
| ProgramData | `GguKzds7FhirzVoo1Yp4EdBgXDqqCihZhEWpg9pjkMJ9` |
| Upgrade authority | `8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH` |
| Program config (admin) | `5gjmTuCtPCmHGRr2qGPNb4KpNMbCFUKTbMw4iLPTGnAr` (PDA `[b"program"]`) |
| Loader | `BPFLoaderUpgradeab1e11111111111111111111111` |
| Data length | 744,376 bytes (`target/deploy/arbswap.so`) |

## Signatures

| Step | Signature |
|---|---|
| Initial deploy | `35gAkvpa88YTq31KushCuLD9S6LQpEUyNeCCjAfaUiB7mjnvSn1YDLCKCAKjE4iuTvHUs3oiJnGtkoMhqatyNL7R` |
| Upgrade | `45sk39oTFNiS6jsMWm3JuqoEyEmxaL231pJBzfhEEYu9rA2XjoCE9fGpTvfkxc5qEcBcgbu38kFVCXDC9Z8f9L74` |
| `initialize_program` | `4ZNu7xbSkCk6ktcdav8VHjhkGpxrnssEtXbRBiwyUv5zPJ2aiaYAEADZcwE1qayRwKpqaMKzB4z3KLwjWe8J1P8i` |

Verify with `solana program show CCR33kX4Q9iucvgN4kRga2txmtu32vxy3bXpKyxPdBQx --url devnet`.

## What worked

- `anchor keys sync` aligned `declare_id!` and `Anchor.toml` to the
  keypair-backed id `CCR33…` (no keypair existed for the old `E8ptk…` id);
  references updated in README/NOTES; `[programs.devnet]` added.
- `anchor deploy --provider.cluster devnet` deployed the program (upgradeable).
- `initialize_program` claimed the one-time program admin, so `initialize_vault`
  cannot be front-run (program_config now exists).

## What did NOT work / remains

- **IDL metadata write** fails with "Failed to initialize IDL" (the metadata
  account `HMuUkDPKqouLg5hrH14QRkGXf7WaxMqgLFW9RA1tk7ui` exists but Anchor's
  write/upgrade errors). This is a client-convenience issue only; the program
  bytecode is on-chain and callable. Not blocking.
- **Full money-path e2e** (create 9-dp base + 6-dp quote mints, initialize the
  vault with a devnet Pyth feed id, deposit → update_quote with a real Pyth
  update → swap both directions → request_withdraw → crank_epoch →
  claim_withdraw) is **NOT DONE** — no scripted client yet.
- **Live keeper** run (10–15 min, low cadence) is **NOT DONE**.
- The `init-program` helper lives in `vault/keeper/src/main.rs`
  (`arbswap-keeper init-program <rpc> <program_id> <admin_keypair> <program_config>`).

## Next steps

1. Script the mints + vault init + money-path loop (S7.3).
2. Choose a devnet Pyth feed id (VERIFY from official Pyth docs) and post a
   `PriceUpdateV2` for `update_quote`.
3. Run the live keeper briefly (S7.5).

---

## P2 gate — devnet money-path progress (branch `dev`)

### Setup DONE on devnet (mints + vault)

`cargo run -q -p arbswap-e2e -- setup https://api.devnet.solana.com <keypair> <feed_id>`

| Item | Address / signature |
|---|---|
| mints+accounts tx | `54p6dfAAe1AsWqAxbv8LBA7CtYCcY7QHtgAHW6wDZuuhMwa4upqJhFshwMUBHePCXaFUFG8jDbR3fCDi5VvQTiov` |
| base mint (9 dp) | `CKqPS4AapFauaNnsWzKo4FEvxnEjW9kXZ4cV8GTfD8V3` |
| quote mint (6 dp) | `GZinkYfCJpAPux7KGhUjQco3xRauGTA57DUrbM35fpmP` |
| LP base account | `8DDAMwwhNpGZ1496BnCYVVsJuksfLrSEcRyFP7kSG2CS` |
| LP quote account | `Af3tbpJzTyiDmdt1Gg42UmEe25UuS3xp5B4F8HBWMW3N` |
| `initialize_vault` tx | `2TrHKZn6VPwKBXFEVegqAXfxxrsbmAxbUP2ucD8RjKw6hue67LXJD42nKLsdE6zGsXpLmCrwg194ojw8kbj6vbVA` |
| vault | `DpC2MPJ43ycsnoaDmZWUHUijWrr8aqSMkMmuBqW3NF7V` |
| config | `dH6GhYPgqFJTHTHwQf4ujd5VsfuxUs3HAhdKrYgbaFc` |
| quote_state | `9GjxaFhhuAV5tfjoSQLaoSDPxqN9aCEyoyBZoMReeTmw` |
| base_reserve | `53jaYgXGsgS8BGdvVjhaGEko5GzLtdQxUSqEiYvuG9Af` |
| quote_reserve | `6oXbAxjUewmz3kfuh3zTJ9Pt38Kor9YaGXSwoRDSTFPo` |
| share_mint | `CtJyzcABFoFSihErnZMBp2BupkSMupkbbvYsfMzxJ4M3` |
| share_lock | `C4zkBMXi9ac6awRL4nn8xHpueyqqssfA6wKcHJoSs4dW` |

Feed id used: SOL/USD `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d`.

### Remaining for the gate: `update_quote`/`swap`

`update_quote` requires a real `PriceUpdateV2` account. Hermes returns a
**Pythnet accumulator (Merkle) update** (`PNAU…`, verified by fetching with the
API key in `.env`), so the client must parse it (`pythnet-sdk`
`wire::v1::AccumulatorUpdate`) and call the receiver's `PostUpdate`/
`PostUpdateAtomic` (accounts: payer, guardian_set, config, treasury,
price_update (signer), system_program, write_authority). This is the one
remaining client. Deposit/withdraw do not need the oracle and can run once the
LP share account is created.
