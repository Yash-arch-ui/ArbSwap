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
