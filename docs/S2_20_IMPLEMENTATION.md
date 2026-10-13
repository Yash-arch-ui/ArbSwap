# S2-20 — Permissionless keepers, quote attribution, and reward routing (local)

Status: **local code + tests only. Not deployed. No transactions.**
Supersedes the S2-19 direction; see `docs/PROGRESS.md` for history and
`docs/DECENTRALIZATION_AUDIT.md` for the S2-17 audit.

Deployed program (`2mwpYHpZ…hyiNm`) and all live accounts remain unchanged.

## 1. Permissionless quote maintenance (implemented)

`require_keeper_authorized` (`vault/program/src/lib.rs`) and the inlined check in
`update_quote` no longer treat `config.keeper` as a single-wallet allowlist:

- `min_bond == 0` ⇒ **any valid signer** may `update_quote` / `stage_quote` /
  `commit_quote`. The on-chain quote validation *is* the authorization.
- `min_bond > 0` ⇒ **any keeper meeting the on-chain bond requirement** may
  quote. The allowlist branch was removed; the bonded path is unchanged.

No quote path has a hidden `config.keeper` restriction. Every keeper passes the
identical oracle / normalization / freshness / confidence / spread / ladder /
inventory / capacity / slot / version / pending-quote / replay checks.

Tests: `permissionless_quote_maintenance_by_non_configured_keeper`,
`two_independent_keepers_stage_without_interference`, the rewritten
`pyth_verification_rejects_untrusted_or_stale_updates`,
`stage_quote_rejects_malformed_payloads`, and the bonded-mode
`permissionless_bonded_keeper_may_quote_when_min_bond_is_set`.

## 2. Immutable keeper eligibility (implemented)

`min_bond` and `keeper` were **removed from `ParamsUpdate`**. `apply_params` no
longer writes `config.min_bond` or `config.keeper`; eligibility is fixed at
`initialize_vault`. An administrator can therefore never re-introduce a
single-wallet allowlist or an exclusionary bond threshold. `config.keeper`
remains in the account (layout compatibility) but confers no privilege.

Test: `params_update_cannot_change_keeper_eligibility` asserts `config.keeper`
and `config.min_bond` are unchanged after a (fee-only) parameter update.

## 3. Quote attribution + reward routing (implemented)

The keeper share (`keeper_bps` of each swap fee) is credited to the keeper that
authored the quote the swap consumed.

- `QuoteState` gains an appended `keeper: Pubkey` field recording the author of
  the committed quote. It is set in both `update_quote` and `commit_quote`.
- New `KeeperReward` PDA `[b"reward", vault, keeper]` = `{ keeper, base, quote,
  bump }`. It is created lazily by `swap` (`init_if_needed`, payer = trader) and
  credited the keeper's share.
- `swap` verifies `keeper_reward.keeper == quote_state.keeper` before crediting,
  so fees cannot be routed to a keeper that did not author the active quote.
- `claim_keeper_reward` now claims **only the signer's own** reward PDA (the
  `config.keeper` equality check was removed). The claim is capped by the vault's
  aggregate `keeper_*` buckets, so LP/protocol principal can never be drained.
- The vault aggregate `keeper_base/keeper_quote` buckets are still updated
  exactly as before, so reserve-exclusion / capacity math is unchanged and the
  aggregate equals the sum of per-keeper attributions.

Why `keeper` lives in `QuoteState` (not a separate `QuoteKeeper` PDA): the staged
commit transaction (`Pyth push + commit_quote`) is measured at ~1180 B with ~52 B
headroom under the 1232 B packet limit. Adding two new accounts to `commit_quote`
would exceed the limit. Appending a field to `QuoteState` adds **zero** accounts
to `commit_quote`/`update_quote`, and `swap` adds only the reward PDA (+system
program), which fits comfortably.

Tests: `keeper_attribution_is_isolated_across_two_keepers` (A's share is not
accessible to B, replacing the quote does not move A's accrual, the aggregate
equals A+B), and the existing `keeper_reward_claim_pays_only_accrued_and_zeroes_it`.

Fee math is untouched: the same `keeper_bps` split is computed; only the
destination (per-keeper PDA) and entitlement check changed.

## 4. Account layout / migration (required before deployment)

| Account | Change | Migration |
|---|---|---|
| `QuoteState` | `+ keeper: Pubkey` appended; allocated space `865 → 897` | **Required.** The deployed 865-byte quote_state cannot be deserialized by the new program. A one-time migration must realloc it to 897 bytes and zero-initialise `keeper` (the quote is already expired, so this is safe). Implemented layout; migration instruction not yet written. |
| `Config` | unchanged (`min_bond`/`keeper` kept, now non-tunable) | none |
| `PendingConfig` | `ParamsUpdate` shrank (removed `min_bond`/`keeper`) | transient; any in-flight proposal must be re-proposed after upgrade. `SetParams` space is over-allocated, which is harmless. |
| `KeeperReward` | new PDA | none (created lazily) |

`QuoteState` uses `space = … + 32` at init. `account_spaces_match_serialized_sizes`
passes.

## 5. Client / IDL updates (implemented)

- IDL regenerated (`target/idl/arbswap.json` → `app/src/idl/arbswap.json`;
  `KeeperReward`, `keeper_reward`, `QuoteState.keeper`).
- Frontend `app/src/chain/program.ts`: `OnChainQuote.keeper` decoded; `swap`
  derives and passes `keeperReward` + `systemProgram`.
- Keeper TS `scripts/devnet/keeper_live.ts`: `simulateSwap` passes the reward PDA
  (QuoteState.keeper at offset 845) + system program; commit/stage account lists
  are unchanged (they never needed the reward PDA).
- `scripts/devnet/swap_preflight.ts`: same.
- Analytics `simulation/analytics/onchain_accounts.py`: decodes the appended
  `keeper` (append-only, existing offsets unchanged).

## 6. Verification (all local, no transactions)

- `cargo test --workspace`: green — program lifecycle **90**, recovery **8**,
  oracle **3**, security **3**, breaker **2**, fixtures **1**, math **+4**,
  keeper **44**.
- `cargo fmt --all --check`: clean.
- Analytics `pytest`: **34 passed**.
- `yarn test` **29**, `yarn lint` clean, `yarn build` clean.
- Keeper TS `tsc --noEmit`: clean (a pre-existing dead-branch warning in
  `swap_preflight.ts:62` is unrelated).
- SBF artifact rebuilt locally for LiteSVM; **not deployed**.

## 7. Remaining blockers before a Devnet multi-keeper test

1. **QuoteState migration instruction** (realloc 865→897, zero `keeper`) — the
   exact missing prerequisite; must be written, reviewed, and deployed with the
   program, then applied once before the new program can read the vault.
2. Deployment (separately authorised) and a **second independent funded keeper
   wallet** for the live two-keeper failure-injection test.
3. Freshness remains provider-sensitive on a single public RPC (S2-17).
4. Slashing remains admin-discretionary (`slash_keeper`); no objective slashing
   criteria were introduced (per the task's prohibition on inventing them).
