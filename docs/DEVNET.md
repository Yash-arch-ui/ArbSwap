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

---

## P2 GATE — FULL LIFECYCLE PASSED ON DEVNET (branch `dev`)

The complete money path ran on devnet against the deployed program
`CCR33kX4Q9iucvgN4kRga2txmtu32vxy3bXpKyxPdBQx`, consuming a **fully verified**
SOL/USD Pyth update posted with the **official `@pythnetwork/pyth-solana-receiver`
TypeScript SDK**.

Vault: `8pubuchUdm9vmnXhxCRie32phFuDiiGi3skCa5okg4qU`
(base mint `Aiv3cxvMCrKq3VadsV9o72pHbuNKseN1jHF56QuGyWSc`, quote mint
`EwGBJg2XqVYcPVnNDfvt5dSZwsFXL4meaMoFgK6FCz6a`).

| Step | Signature |
|---|---|
| `deposit` | `2cZqAfRowJev4CZJe5ESc1c2H4b667cbB8RHJgQfJ15yRAvAaDmEWM2f7T5cNUzDsxn93LCZZ2en3nLUtJbFwaTi` |
| `update_quote` (Pyth `PriceUpdateV2` `BPaaStZuWrUfGfbaFomayCpVjaEJ48pLgxmbmWfqj8Rx`) | `2U67ZEAgHy5dYJCHbkgN8cRb7qiJ8MFBTU8LmQqmqXinqX8pft7gVTKMfBJJSnuVp9FqphrrWr8amwmJWqpzxdub` |
| `swap` BuyBase | `4bBrSFfir7NVhW3JmikCGEXRWnPHa8iy4qsDKhANxssAV5dJZTntpL2kMstcriu7v9XVxq9Xa6M2WbfxHGt9WV32` |
| `swap` SellBase | `2PNitWMCW8FZrJQc3LDFs1JeBFJiWAheHLHExRH376y9cfLs3hmedT2L1KaFSdXg5RvyxJoNQPykrqLNJ2jUt7Lv` |
| `request_withdraw` | `DATqE2VAeQQCntoSfCQYjkyZfj5q1CjYFTFqyNCQzzCHdXx3n1xB4fBjjeFGnrc3KUXpErfNSR6aLYqi85XCRi3` |
| `crank_epoch` | `5gG4EorK2isjqv631gq9wpxJ8Kbpm9SBkUQoEpzmkSiF96PE7uT6EPv3hHriyfFZYsne4pS24YSWEUoySPuQ9JBk` |
| `claim_withdraw` | `G7NSneNm6dNiMqHCEqHJaYX2Q52BBaBCKh3Msg3663KLcNE2rQQcZ4gMsTjTcaYYAeUiizw32oT5bbSrm7NtcCS` |

Pyth post signatures: `2XDaEmvFxUQ4Uokv9qyxt5tVSbHUyrwmnikLwGUeHUS43PKwxbQviwk9JCY64bLcvBEqpKjhGcL8BFen7ysVd9rq`,
`mjz7VjgvMueiw6hjSPgKjdUHG4AzFzpfkKaUj1bJm3abCPoGBsPsbv4HoigbChPWuGSrf8BthprSEKz5HPzGqxr` (one of the runs).

### Reproduce

```bash
# 1. mints + LP accounts + vault (writes /tmp/arbswap_state.json)
cargo run -q -p arbswap-e2e -- setup https://api.devnet.solana.com ~/.config/solana/id.json \
  ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d /tmp/arbswap_state.json

# 2. post a fully verified SOL/USD update with the OFFICIAL Pyth TS SDK
#    (writes /tmp/arbswap_pyth.json; PYTH_API_KEY from the environment only)
cd scripts/devnet && npm install && PYTH_API_KEY=... npx tsx post_pyth.ts

# 3. full loop (consumes the PriceUpdateV2 from step 2)
cd ../.. && cargo run -q -p arbswap-e2e -- loop https://api.devnet.solana.com \
  ~/.config/solana/id.json /tmp/arbswap_state.json /tmp/arbswap_pyth.json
```

### Compatibility notes (verified, not guessed)

- Deployed receiver `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` ==
  `DEFAULT_RECEIVER_PROGRAM_ID` in `@pythnetwork/pyth-solana-receiver@0.16.0`.
- Hermes `getLatestPriceUpdates({encoding:"base64"})` returns the Pythnet
  accumulator blobs the SDK's `addPostPriceUpdates` parses — no custom parser.
- `PriceUpdateV2` account owner is the receiver program; `update_quote` requires
  `Account<PriceUpdateV2>` (unchanged constraint). No on-chain check weakened.
- npm packaging: `jito-ts`→`@solana/web3.js@1.77` needs the legacy
  `rpc-websockets/dist/lib/client` subpath; `scripts/devnet/fix-rpc-websockets.cjs`
  (postinstall) writes the `.js` re-export shims. web3.js pinned to `1.92.3`.
- A smoke-test note: the keeper ladder treats the price as an atom-ratio, so the
  devnet bid depth is small; the SellBase size was set to 50,000 base atoms and
  `expiry_slots` to 1000 so the quote stays live across the multi-tx loop.
