# S2-21A — Legacy `QuoteState` migration (local implementation)

Status: **local code + tests only. Not deployed. No transactions.**
Related: `docs/S2_20_IMPLEMENTATION.md`, `docs/DECENTRALIZATION_AUDIT.md`.

## 1. Verified layouts

Anchor account discriminator for `QuoteState`: `beffae2c13d7259c`
(`sha256("account:QuoteState")[..8]`) — **identical for legacy and current**, since
the account name is unchanged.

| | Fields (in order) | Serialized body | Allocated `space` |
|---|---|---|---|
| **Legacy (pre-S2-19)** | `version, update_slot, expiry_slot, anchor_sqrt_price, p_res_sqrt, half_spread_bps, ask_extra_bps, bid_extra_bps, depth_mult_bps, window_start_slot, window_base_sold, window_base_bought, oracle_publish_time, oracle_conf_bps, oracle_price, edge_window_start_slot, realized_edge, flow_n, ask_levels[6], bid_levels[6], bump` | 837 B (+8 disc = 845) | **865 B** |
| **Current (S2-19+)** | legacy fields **+ `keeper: Pubkey`** appended | 869 B (+8 disc = 877) | **897 B** |

The deployed Devnet `QuoteState` (`5MsGbdHv…TYAgG`) was read over RPC: **data length
865 B, owner = the program, disc `beffae2c13d7259c`** — matching the legacy layout.
`LEGACY_QUOTE_STATE_LEN = 865`, `CURRENT_QUOTE_STATE_LEN = 897` in source, and the
`InitializeVault` `space` expression evaluates to 897.

> Only `QuoteState` changed layout in S2-19/S2-20. `Config` kept `min_bond`/`keeper`
> (now non-tunable), so it needs no migration. `PendingConfig` shrank (`ParamsUpdate`
> lost `min_bond`/`keeper`); it is a transient, admin-created account — any in-flight
> proposal must be re-proposed after the upgrade (no state migration needed).

## 2. `migrate_quote_state` (permissionless)

`vault/program/src/lib.rs`:

- Accounts: `payer` (mut signer, funds the rent shortfall), `vault`
  (`seeds=[b"vault", base_mint, quote_mint]`), `quote_state` (`UncheckedAccount`,
  `mut`, `seeds=[b"quote", vault]`), `system_program`.
- Safety checks (in order):
  1. `quote_state.owner == program id` (`InvalidAccountOwner`).
  2. `quote_state` is the canonical `[b"quote", vault]` PDA (the `seeds` constraint).
  3. discriminator == `sha256("account:QuoteState")[..8]`
     (`InvalidAccountDiscriminator`).
  4. length == `CURRENT_QUOTE_STATE_LEN` ⇒ **idempotent no-op** (no resize/rewrite).
  5. length == `LEGACY_QUOTE_STATE_LEN` ⇒ decode via `LegacyQuoteState`
     (a plain `AnchorSerialize/Deserialize` mirror of the old fields — the shorter
     account is **never** deserialized into the larger current struct).
     Any other length ⇒ `UnsupportedAccountLength`.
- Funding: computes `Rent::minimum_balance(897)`; transfers **only the shortfall**
  from `payer` to the account via `system_program::transfer`.
- Resize: `AccountInfo::resize(897)` (zero-extends the appended region).
- Write: re-serializes the current struct (discriminator + all preserved fields +
  `keeper = Pubkey::default()`), so every legacy field is preserved byte-for-byte.
- Emits `QuoteStateMigrated { slot, from_len: 865, to_len: 897 }`.
- Atomic: any failure (owner/disc/length/funding/resize) reverts the whole tx.

The caller gains no control over vault config, quote contents, keeper identity,
reserves, shares, or fee accounting.

### Legacy keeper attribution

The appended `keeper` is set to the **unattributed sentinel `Pubkey::default()`**.
A legacy quote has no cryptographically established author, so it is **never**
attributed to `config.keeper`. To enforce this, `swap` now rejects an
unattributed quote:

```rust
require!(ctx.accounts.quote_state.keeper != Pubkey::default(), ErrorCode::UnattributedQuote);
```

So a migrated legacy quote (even if still fresh) cannot be swapped against and
cannot accrue any keeper reward; a newly committed, attributed quote is required.

## 3. Fresh vs expired legacy quote

- **Expired legacy quote:** after migration it is unattributed but the normal,
  validated recovery/refresh flow is unchanged (`quote_reanchor_eligible` keys off
  on-chain expiry/staleness, not keeper identity). Any eligible keeper may commit a
  new quote, which records that keeper and re-enables swaps.
- **Fresh legacy quote:** it remains readable with all fields preserved, but swaps
  are blocked (`UnattributedQuote`) until a new attributed quote is committed. The
  quote's expiry and the normal anchor-step limits are untouched.

No oracle, freshness, confidence, deviation, version, replay, pending-quote,
ladder, inventory, capacity, or slippage check was changed.

## 4. Tests (`vault/program/tests/litesvm_lifecycle.rs`)

A genuine legacy-format fixture is built from `arbswap::LegacyQuoteState` (with the
canonical PDA bump, as `initialize_vault` stored it), serialized with the
`QuoteState` discriminator, and padded to 865 B.

| Test | Proves |
|---|---|
| `migrate_legacy_quote_state_preserves_fields_and_is_unattributed` | 865 → 897; every field preserved; `keeper == default` |
| `migrated_legacy_quote_is_not_swappable_or_rewardable` | fresh unattributed quote ⇒ `UnattributedQuote`; no reward PDA created |
| `fresh_commit_after_migration_attributes_independent_keeper` | full transition: legacy → migrated → independent-keeper commit → attributed swap reward |
| `migrate_is_idempotent_on_an_already_migrated_account` | re-running is a byte-identical no-op |
| `migrate_rejects_a_wrong_pda` | `ConstraintSeeds` |
| `migrate_rejects_a_wrong_owner` | `InvalidAccountOwner` |
| `migrate_rejects_a_bad_discriminator` | `InvalidAccountDiscriminator` |
| `migrate_rejects_an_unsupported_length` | `UnsupportedAccountLength` |
| `migrate_fails_safely_without_rent_funding` | under-funded payer ⇒ atomic failure, account unchanged (865 B, 1 lamport) |

Migration does not touch reserves, token balances, shares, fees, admin, keeper
policy, or vault configuration; existing withdrawal/claim tests are unchanged.

## 5. Validation results

- `cargo test --workspace`: green — program lifecycle **99** (incl. 9 migration),
  recovery **8**, oracle **3**, security **3**, breaker **2**, fixtures **1**;
  keeper **44**; math **+4**.
- `cargo fmt --all --check`: clean.
- Analytics `pytest`: **34 passed**. `yarn test` **29**, lint clean, build clean.
- Docs-consistency: pass. Secrets scan: CLEAN.
- IDL regenerated (`target/idl/arbswap.json` → `app/src/idl/arbswap.json`),
  now containing `migrate_quote_state`.

## 6. What must be migrated before deployment

- The single canonical `QuoteState` PDA `5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG`
  (865 B) must be migrated to 897 B **once**, after the upgraded program is
  deployed and before any swap/quote path can read it.
- `Config` needs no migration. Any in-flight `PendingConfig` proposal should be
  re-proposed (the account is transient).

## 7. Ordered steps for an authorised Devnet deploy + migration

1. Deploy the upgraded program (upgrade authority `ddGs6hk5…`); no config/authority
   change.
2. Call `migrate_quote_state(payer, vault, quote_state)` once (any funded signer;
   the account is currently 865 B). It emits `QuoteStateMigrated`; verify the
   account is 897 B and `keeper == default`.
3. Have an independent keeper commit a fresh quote (permissionless, `min_bond==0`);
   verify `QuoteState.keeper` is that signer and a swap credits that keeper's
   `KeeperReward` PDA.
4. Run the two-independent-keeper failure-injection test (outage, stale quote,
   large jump, recovery) as described in `docs/S2_20_IMPLEMENTATION.md`.
5. (Governance, separately) move the upgrade authority to a multisig.

---

## S2-22 addendum — preflight + manifest

`scripts/devnet/release_preflight.ts` (read-only) reports the live `QuoteState`
layout (legacy 865 vs current 897), owner, discriminator, PDA, rent shortfall,
payer balance, and whether migration is required; it exits non-zero on any
incompatibility. A read-only Devnet run confirmed `migration_required: true`
(865 B, shortfall 162,560 lamports, payer funded). `release_manifest.ts` records
the exact artifact/IDL hashes and the ordered migration steps.
