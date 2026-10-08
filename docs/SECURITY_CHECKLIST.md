# SECURITY_CHECKLIST.md

Phase 2 (on-chain program) account-binding and instruction audit.

**Status: same-agent self-review, NOT an independent audit.** The operative claim
is: **"no known issues in self-review; independent audit pending."** Do not write
"exploit-free", "audited", or "as complete as Uniswap".

Test names below are LiteSVM tests in `vault/program/tests/`.

Account validation in Anchor happens before the instruction body
(`try_accounts`), so every "substitution rejected" test proves the binding fires
at the account layer.

Legend for bindings: **PDA** = seeds constraint; **addr** = `address = vault.*`;
**own** = token `owner`/`mint` constraint; **has_one** = stored-key equality
(equivalent, expressed as `address`/seed here); **body** = checked in the handler.

## 1. Account-binding table (every account of every instruction)

| Instruction | Account | Binding | Negative test |
|---|---|---|---|
| `initialize_program` | `admin` | Signer | — |
| | `program_config` | PDA `[b"program"]`, `init` | `initialize_program_is_one_time` |
| | `system_program` | program id | — |
| `initialize_vault` | `admin` | Signer + body `program_config.admin == admin` | `a_non_admin_cannot_initialize_a_vault`, `only_the_program_admin_can_initialize_a_vault` |
| | `program_config` | PDA `[b"program"]` | (above) |
| | `vault` | PDA `[b"vault", base_mint, quote_mint]`, `init` | derives from the mint pair, so a squatter cannot pre-empt |
| | `config` | PDA `[b"config", vault]` | — |
| | `quote_state` | PDA `[b"quote", vault]` | — |
| | `base_mint` | `address = params.base_mint` | `initialize_vault` param checks |
| | `quote_mint` | `address = params.quote_mint` | (above) |
| | `base_reserve`/`quote_reserve` | `init`, `token::mint = *_mint`, `token::authority = vault` | — |
| | `share_mint` | `init`, `mint::authority = vault` | — |
| | `share_lock` | `init`, `token::mint = share_mint`, `token::authority = vault` | — |
| `deposit` | `user` | Signer | — |
| | `vault` | (bound via `config`/reserve addresses below) | `swap_rejects_a_config_from_another_vault` pattern |
| | `config` | PDA `[b"config", vault]` | — |
| | `base_reserve`/`quote_reserve` | `address = vault.*` | `swap_rejects_a_reserve_from_another_vault` |
| | `share_mint` | `address = vault.share_mint` | `claim_withdraw_rejects_a_foreign_share_mint` |
| | `share_lock` | `address = vault.share_lock` | `claim_withdraw_rejects_a_foreign_share_lock` |
| | `user_base`/`user_quote` | `mint == vault.*`, `owner == user` | `request_withdraw_rejects_a_foreign_share_account` |
| | `user_shares` | `mint == vault.share_mint`, `owner == user` | (above) |
| | `deposit_ticket` | PDA `[b"dep", vault, user]`, `init_if_needed` | `request_withdraw_rejects_a_deposit_ticket_from_another_vault` |
| `request_withdraw` | `user` | Signer | — |
| | `vault` | (bound via `share_lock`/tickets below) | — |
| | `share_lock` | `address = vault.share_lock` | `claim_withdraw_rejects_a_foreign_share_lock` |
| | `deposit_ticket` | PDA `[b"dep", vault, user]` | `request_withdraw_rejects_a_deposit_ticket_from_another_vault` |
| | `user_shares` | `owner == user`, `mint == vault.share_mint` | `request_withdraw_rejects_a_foreign_share_account` |
| | `withdraw_ticket` | PDA `[b"wd", vault, user]`, `init_if_needed` | `claim_withdraw_rejects_a_ticket_from_another_vault` |
| `claim_withdraw` | `user` | Signer | — |
| | `vault` | (bound via reserve/mint/lock/ticket below) | — |
| | `base_reserve`/`quote_reserve` | `address = vault.*` | `swap_rejects_a_reserve_from_another_vault` |
| | `share_mint` | `address = vault.share_mint` | `claim_withdraw_rejects_a_foreign_share_mint` |
| | `share_lock` | `address = vault.share_lock` | `claim_withdraw_rejects_a_foreign_share_lock` |
| | `withdraw_ticket` | PDA `[b"wd", vault, user]` + `owner == user` (**fixed p2-T1**) | `claim_withdraw_rejects_a_ticket_from_another_vault` |
| | `user_base`/`user_quote` | `owner == user`, `mint == vault.*` | (owner/mint constraints) |
| `crank_epoch` | `vault` | mut | — |
| | `config` | PDA `[b"config", vault]` | — |
| `update_quote` | `keeper` | Signer + body `keeper == config.keeper`; bond when `min_bond > 0` | `keeper_can_be_rotated_via_the_timelock`, `update_quote_requires_a_keeper_bond` |
| | `vault` | (bound via `config`/`quote_state`) | — |
| | `config` | PDA `[b"config", vault]` | `swap_rejects_a_config_from_another_vault` |
| | `quote_state` | PDA `[b"quote", vault]` | — |
| | `price_update` | `Account<PriceUpdateV2>` (owner = Pyth receiver) + feed/freshness/price/conf checks | `pyth_account_owner_must_be_the_receiver_program`, `pyth_verification_rejects_untrusted_or_stale_updates`, `anchor_far_from_the_oracle_is_rejected` |
| | `keeper_bond` | `UncheckedAccount`; PDA + amount verified only when `min_bond > 0` | `update_quote_requires_a_keeper_bond` |
| `swap` | `trader` | Signer | — |
| | `vault` | (bound via `config`/`quote_state`/reserves) | — |
| | `config` | PDA `[b"config", vault]` | `swap_rejects_a_config_from_another_vault` |
| | `quote_state` | PDA `[b"quote", vault]` | — |
| | `base_reserve`/`quote_reserve` | `address = vault.*` | `swap_rejects_a_reserve_from_another_vault` |
| | `trader_base`/`trader_quote` | `owner == trader`, `mint == vault.*` | (owner/mint constraints) |
| `trip_breaker` | `vault` | mut | — |
| | `quote_state` | PDA `[b"quote", vault]` | state-only breaker design (p2-T4) |
| `reset_breaker` | `admin` | Signer + body `admin == vault.admin` | `admin_only_controls_reject_non_admins` |
| | `vault` | mut | — |
| `wind_down` | `admin` | Signer + body `admin == vault.admin` | `wind_down_is_admin_only_and_pauses_quotes` |
| | `vault` | mut | — |
| `set_params` | `admin` | Signer + body `admin == vault.admin` | `admin_only_controls_reject_non_admins` |
| | `vault` | PDA `[b"vault", base_mint, quote_mint]` | — |
| | `pending_config` | PDA `[b"pending", vault]`, `init_if_needed` | — |
| `apply_params` | `admin` | Signer + body admin/pending-admin + timelock | `params_change_is_timelocked` |
| | `vault` | PDA `[b"vault", ...]` | — |
| | `config` | PDA `[b"config", vault]` | — |
| | `pending_config` | PDA `[b"pending", vault]` | — |
| `bond_keeper` | `keeper` | Signer | — |
| | `vault` | mut | — |
| | `quote_mint` | `address = vault.quote_mint` | — |
| | `keeper_quote` | `owner == keeper`, `mint == vault.quote_mint` | — |
| | `bond_vault` | PDA `[b"bond", vault]`, `token::authority = vault` | `slash_keeper_rejects_a_bond_vault_from_another_vault` |
| | `keeper_bond` | PDA `[b"keeper", vault, keeper]` | `slash_keeper_rejects_a_bond_from_another_vault` |
| `slash_keeper` | `admin` | Signer + body `admin == vault.admin` | `admin_only_controls_reject_non_admins` |
| | `vault` | mut | — |
| | `quote_reserve` | `address = vault.quote_reserve` | — |
| | `keeper` | `UncheckedAccount` (only derives the bond PDA) | — |
| | `keeper_bond` | PDA `[b"keeper", vault, keeper]` | `slash_keeper_rejects_a_bond_from_another_vault` |
| | `bond_vault` | PDA `[b"bond", vault]` | `slash_keeper_rejects_a_bond_vault_from_another_vault` |
| `claim_keeper_reward` | `keeper` | Signer + body `keeper == config.keeper` | — |
| | `vault` | (bound via `config`/reserves) | — |
| | `config` | PDA `[b"config", vault]` | — |
| | `base_reserve`/`quote_reserve` | `address = vault.*` | — |
| | `keeper_base`/`keeper_quote` | `owner == keeper`, `mint == vault.*` | — |
| `propose_fee_claim` | `admin` | Signer + body `admin == vault.admin`; `kind != Insurance` | `insurance_bucket_cannot_be_claimed_to_treasury` |
| | `vault` | PDA `[b"vault", ...]` | — |
| | `pending_claim` | PDA `[b"claim", vault]`, `init_if_needed` | — |
| `execute_fee_claim` | `admin` | Signer + body admin/pending-admin + timelock | `fee_claim_is_timelocked_and_pays_only_the_fixed_treasury` |
| | `vault`, `config` | PDA-bound | — |
| | `base_reserve`/`quote_reserve` | `address = vault.*` | — |
| | `treasury_base`/`treasury_quote` | `owner == config.treasury`, `mint == vault.*` | `execute_fee_claim_rejects_a_non_treasury_destination` |

**Audit result:** the only unbound account found was `ClaimWithdraw.withdraw_ticket`
(P2-F01), fixed in commit `p2-T1`. Every other account is bound by PDA seeds,
`address`, or mint/owner constraints.

## 2. Per-instruction checks (signer / owner / PDA / math)

- **Signers:** every authority account is `Signer` (`admin`, `user`, `keeper`,
  `trader`); `trip_breaker` and `crank_epoch` are intentionally permissionless.
- **Owner checks:** every token account is `Account<TokenAccount>` (owner = token
  program) or `Mint`; the Pyth account is `Account<PriceUpdateV2>` (owner = Pyth
  receiver program, enforced by Anchor).
- **Token-2022:** rejected via `Program<Token>`; `token_2022_accounts_are_rejected`.
- **PDA/canonical bumps:** seeds use Anchor bump verification; no attacker-supplied
  PDA. Withdraw/deposit tickets, keeper bonds, pending config/claim are seeded.
- **Math:** all arithmetic checked; `arb_math` fixed-point; rounding favors the
  vault; golden + property tests in `vault/math`.
- **CPI:** token program only; no arbitrary CPI; no `remaining_accounts`.

## 3. Compute units (LiteSVM, program instruction only)

Measured on this branch; re-measured in `measure_instruction_compute_units`
(run with `-- --nocapture`). Full before/after table is in
`docs/AUDIT_FULL.md`; the reconciled table is in `TARGETIDEATASKS_P2.md`.

Measured with `measure_instruction_compute_units` (bonded path) after p2-T3:

| Instruction | CU |
|---|---|
| `update_quote` | 64,713 (capacity maths dominates; was ~18–29k) |
| `update_quote` (wide-conf rejected) | 15,048 |
| `swap` | 72,828 |
| `trip_breaker` | ~7–10k |
| `deposit` | 46,477 |
| `request_withdraw` | 24,420 |
| `claim_withdraw` | 24,158 |
| `crank_epoch` | 5,157 |
| `bond_keeper` / `slash_keeper` / `claim_keeper_reward` | 26,409 / 15,507 / 13,967 |

`update_quote` now exceeds the keeper's former 60k limit, so
`MAX_UPDATE_COMPUTE_UNITS` was raised to 80,000. All instructions remain inside
the 200,000 CU transaction default.
