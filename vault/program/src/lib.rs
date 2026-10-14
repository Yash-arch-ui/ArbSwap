#![allow(unexpected_cfgs)] // Anchor macros emit `cfg(target_os="solana")`

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};
use arb_math::{walk_ladder, Level as MathLevel, Side as MathSide};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

declare_id!("2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm");

const LEVELS: usize = 6;
const ACTIVE: u8 = 0;
const PAUSED: u8 = 1;
const WIND_DOWN: u8 = 2;
/// Hard cap on the outermost ladder offset, in bps, independent of the keeper
/// payload (F-04). With the anchor binding below, no executed level can sit
/// further than `max_spread_bps + this` from the oracle price.
const MAX_LEVEL_OFFSET_BPS: u32 = 500;
const BPS_DENOM: u32 = 10_000;
/// Timelock between `set_params` and `apply_params` (F-17): ~1 day at 400 ms.
const TIMELOCK_SLOTS: u64 = 216_000;
/// S2-37: upper bound on the tunable `expiry_slots` (≈2.5 min at 0.248 s/slot).
/// Bounds the window in which a committed quote can be filled; the 2 s oracle
/// rule is still enforced at commit (the swap itself does not re-check age).
const MAX_EXPIRY_SLOTS: u64 = 600;
/// p2-T4: the permissionless breaker trips when the stored oracle publish time
/// is older than this multiple of `max_staleness_seconds`. Stored state only.
const STALENESS_TRIP_MULTIPLE: i64 = 2;
/// S2-11: max age (slots) of a staged quote before `commit_quote` rejects it.
const MAX_STAGE_AGE_SLOTS: u64 = 25;
/// S2-21A: allocated account lengths for `QuoteState`. `LEGACY` is the pre-S2-19
/// layout (no appended `keeper` field); `CURRENT` appends a 32-byte `keeper`.
/// These must match the `InitializeVault` `space` expression exactly.
const LEGACY_QUOTE_STATE_LEN: usize = 865;
const CURRENT_QUOTE_STATE_LEN: usize = 897;

#[program]
pub mod arbswap {
    use super::*;

    /// One-time deployer bootstrap. Claims the program admin role so a
    /// subsequent `initialize_vault` cannot be front-run for a mint pair
    /// (the vault PDA is derived from the mints alone).
    pub fn initialize_program(ctx: Context<InitializeProgram>) -> Result<()> {
        ctx.accounts.program_config.admin = ctx.accounts.admin.key();
        ctx.accounts.program_config.bump = ctx.bumps.program_config;
        emit!(ProgramInitialized {
            admin: ctx.accounts.admin.key()
        });
        Ok(())
    }

    pub fn initialize_vault(ctx: Context<InitializeVault>, params: InitParams) -> Result<()> {
        require!(
            ctx.accounts.program_config.admin == ctx.accounts.admin.key(),
            ErrorCode::Unauthorized
        );
        require!(
            params.base_mint != params.quote_mint,
            ErrorCode::InvalidMint
        );
        require!(params.min_liquidity > 0, ErrorCode::InvalidParams);
        require!(
            (params.insurance_bps as u32)
                .saturating_add(params.keeper_bps as u32)
                .saturating_add(params.protocol_bps as u32)
                <= 10_000,
            ErrorCode::InvalidParams
        );
        require!(
            params.weights_bps.iter().map(|v| *v as u64).sum::<u64>() == 10_000,
            ErrorCode::InvalidWeights
        );
        require!(
            params.offsets_bps.windows(2).all(|w| w[0] < w[1]),
            ErrorCode::InvalidLadder
        );
        require!(
            params.expiry_slots > params.grace_slots,
            ErrorCode::InvalidParams
        );
        require!(
            params.min_spread_bps <= params.max_spread_bps,
            ErrorCode::InvalidParams
        );
        // Spec §5.16: u_max is capped at 0.8 of reserves.
        require!(
            params.utilization_max_bps <= 8_000,
            ErrorCode::InvalidParams
        );
        let vault = &mut ctx.accounts.vault;
        vault.admin = ctx.accounts.admin.key();
        vault.base_mint = params.base_mint;
        vault.quote_mint = params.quote_mint;
        vault.base_reserve = ctx.accounts.base_reserve.key();
        vault.quote_reserve = ctx.accounts.quote_reserve.key();
        vault.share_mint = ctx.accounts.share_mint.key();
        vault.share_lock = ctx.accounts.share_lock.key();
        vault.total_shares = 0;
        vault.insurance_base = 0;
        vault.insurance_quote = 0;
        vault.keeper_base = 0;
        vault.keeper_quote = 0;
        vault.protocol_base = 0;
        vault.protocol_quote = 0;
        vault.status = ACTIVE;
        vault.epoch = 0;
        vault.epoch_start = Clock::get()?.slot;
        vault.bump = ctx.bumps.vault;

        let config = &mut ctx.accounts.config;
        config.admin = vault.admin;
        config.keeper = params.keeper;
        config.treasury = params.treasury;
        config.fee_bps = params.fee_bps;
        config.insurance_bps = params.insurance_bps;
        config.keeper_bps = params.keeper_bps;
        config.protocol_bps = params.protocol_bps;
        config.min_liquidity = params.min_liquidity;
        config.warmup_slots = params.warmup_slots;
        config.epoch_slots = params.epoch_slots;
        config.grace_slots = params.grace_slots;
        config.expiry_slots = params.expiry_slots;
        config.max_staleness_seconds = params.max_staleness_seconds;
        config.pyth_feed_id = params.pyth_feed_id;
        config.max_conf_bps = params.max_conf_bps;
        config.max_anchor_step_bps = params.max_anchor_step_bps;
        config.max_spread_step_bps = params.max_spread_step_bps;
        config.min_spread_bps = params.min_spread_bps;
        config.max_spread_bps = params.max_spread_bps;
        config.max_quote_size = params.max_quote_size;
        config.max_inventory_bps = params.max_inventory_bps;
        config.utilization_max_bps = params.utilization_max_bps;
        config.min_bond = params.min_bond;
        config.unbond_cooldown_slots = params.unbond_cooldown_slots;
        config.max_update_slot_age = params.max_update_slot_age;
        config.edge_window_slots = params.edge_window_slots;
        config.max_edge_loss_bps = params.max_edge_loss_bps;
        config.max_anchor_dev_bps = params.max_anchor_dev_bps;
        config.flow_window_slots = params.flow_window_slots;
        config.max_window_flow_bps = params.max_window_flow_bps;
        config.pending_admin = Pubkey::default();
        config.admin_activate_slot = 0;
        config.bump = ctx.bumps.config;

        ctx.accounts.quote_state.bump = ctx.bumps.quote_state;
        ctx.accounts.quote_state.version = 0;
        ctx.accounts.quote_state.update_slot = 0;
        ctx.accounts.quote_state.expiry_slot = 0;
        ctx.accounts.quote_state.window_start_slot = 0;
        ctx.accounts.quote_state.window_base_sold = 0;
        ctx.accounts.quote_state.window_base_bought = 0;
        ctx.accounts.quote_state.flow_n = 0;
        ctx.accounts.quote_state.ask_levels = [Level::default(); LEVELS];
        ctx.accounts.quote_state.bid_levels = [Level::default(); LEVELS];
        ctx.accounts.quote_state.keeper = Pubkey::default();
        emit!(VaultInitialized {
            slot: Clock::get()?.slot,
            vault: vault.key()
        });
        Ok(())
    }

    /// S2-21A: permissionless, one-time layout upgrade of a legacy `QuoteState`
    /// (865 B, no appended `keeper`) to the current layout (897 B). Only the
    /// account allocation and the appended `keeper` field change: every existing
    /// quote field is preserved byte-for-byte. The appended field is set to the
    /// unattributed sentinel (`Pubkey::default()`); a legacy quote has no
    /// cryptographically established author, so it must never be attributed to
    /// `config.keeper` and can never generate keeper rewards. Any payer may fund
    /// the rent shortfall and invoke this; it grants no control over the vault,
    /// quote contents, reserves, shares, or fee accounting.
    pub fn migrate_quote_state(ctx: Context<MigrateQuoteState>) -> Result<()> {
        let account = ctx.accounts.quote_state.to_account_info();
        require!(
            account.owner.to_bytes() == crate::ID.to_bytes(),
            ErrorCode::InvalidAccountOwner
        );
        let rent = Rent::get()?;
        let required = rent.minimum_balance(CURRENT_QUOTE_STATE_LEN);

        // Inspect + validate the existing bytes without ever deserialising the
        // shorter legacy account into the larger current struct.
        let state = {
            let data = account.try_borrow_data()?;
            require!(
                data.starts_with(<QuoteState as anchor_lang::Discriminator>::DISCRIMINATOR),
                ErrorCode::InvalidAccountDiscriminator
            );
            if data.len() == CURRENT_QUOTE_STATE_LEN {
                // Already migrated: idempotent no-op (do not resize/rewrite).
                return Ok(());
            }
            require!(
                data.len() == LEGACY_QUOTE_STATE_LEN,
                ErrorCode::UnsupportedAccountLength
            );
            let legacy = LegacyQuoteState::deserialize(&mut &data[8..])?;
            legacy.into_current()
        };

        // Fund only the rent shortfall for the larger account, from the payer.
        if required > account.lamports() {
            let shortfall = required - account.lamports();
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: account.clone(),
                    },
                ),
                shortfall,
            )?;
        }

        // Grow the account (zero-extending the new tail), then write the current
        // serialization (discriminator + preserved fields + keeper).
        account.resize(CURRENT_QUOTE_STATE_LEN)?;
        let mut buf = Vec::with_capacity(CURRENT_QUOTE_STATE_LEN);
        state.try_serialize(&mut buf)?;
        let mut data = account.try_borrow_mut_data()?;
        data[..buf.len()].copy_from_slice(&buf);
        emit!(QuoteStateMigrated {
            slot: Clock::get()?.slot,
            from_len: LEGACY_QUOTE_STATE_LEN as u64,
            to_len: CURRENT_QUOTE_STATE_LEN as u64,
        });
        Ok(())
    }

    pub fn deposit(
        ctx: Context<Deposit>,
        base_amount: u64,
        quote_amount: u64,
        min_shares: u64,
    ) -> Result<()> {
        require!(ctx.accounts.vault.status == ACTIVE, ErrorCode::Paused);
        require!(
            base_amount > 0 && quote_amount > 0,
            ErrorCode::InvalidAmount
        );
        let total_shares = ctx.accounts.vault.total_shares;
        // Reserves available to LPs: the fee buckets are excluded from share math.
        let base_net = ctx
            .accounts
            .base_reserve
            .amount
            .saturating_sub(ctx.accounts.vault.insurance_base)
            .saturating_sub(ctx.accounts.vault.keeper_base)
            .saturating_sub(ctx.accounts.vault.protocol_base);
        let quote_net = ctx
            .accounts
            .quote_reserve
            .amount
            .saturating_sub(ctx.accounts.vault.insurance_quote)
            .saturating_sub(ctx.accounts.vault.keeper_quote)
            .saturating_sub(ctx.accounts.vault.protocol_quote);
        require!(
            total_shares == 0 || (base_net > 0 && quote_net > 0),
            ErrorCode::InvalidParams
        );
        let shares = if total_shares == 0 {
            let root = integer_sqrt(
                (base_amount as u128)
                    .checked_mul(quote_amount as u128)
                    .ok_or(ErrorCode::MathOverflow)?,
            )
            .checked_sub(ctx.accounts.config.min_liquidity as u128)
            .ok_or(ErrorCode::InvalidAmount)? as u64;
            require!(root > 0, ErrorCode::InvalidAmount);
            let lock = ctx.accounts.config.min_liquidity;
            if lock > 0 {
                let bump = [ctx.accounts.vault.bump];
                let seeds: &[&[u8]] = &[
                    b"vault",
                    ctx.accounts.vault.base_mint.as_ref(),
                    ctx.accounts.vault.quote_mint.as_ref(),
                    &bump,
                ];
                token::mint_to(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        MintTo {
                            mint: ctx.accounts.share_mint.to_account_info(),
                            to: ctx.accounts.share_lock.to_account_info(),
                            authority: ctx.accounts.vault.to_account_info(),
                        },
                        &[seeds],
                    ),
                    lock,
                )?;
            }
            root
        } else {
            let by_base = (base_amount as u128)
                .checked_mul(total_shares as u128)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_div(base_net as u128)
                .ok_or(ErrorCode::MathOverflow)?;
            let by_quote = (quote_amount as u128)
                .checked_mul(total_shares as u128)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_div(quote_net as u128)
                .ok_or(ErrorCode::MathOverflow)?;
            by_base.min(by_quote) as u64
        };
        require!(shares >= min_shares, ErrorCode::SlippageExceeded);
        // F-11: never mint zero shares. A donation-inflation attacker who bloats
        // a reserve cannot make a subsequent deposit succeed with 0 shares; the
        // transaction reverts and the depositor keeps their tokens.
        require!(shares > 0, ErrorCode::InvalidAmount);
        // Pull only what the minted shares are worth; the imbalanced remainder
        // stays with the depositor instead of being donated to the pool
        // (audit F-10).
        let (pull_base, pull_quote) = if total_shares == 0 {
            (base_amount, quote_amount)
        } else {
            let needed_base = ceil_div_u128(shares as u128 * base_net as u128, total_shares as u128)
                .min(base_amount as u128) as u64;
            let needed_quote =
                ceil_div_u128(shares as u128 * quote_net as u128, total_shares as u128)
                    .min(quote_amount as u128) as u64;
            require!(
                needed_base > 0 && needed_quote > 0,
                ErrorCode::InvalidAmount
            );
            (needed_base, needed_quote)
        };
        token::transfer(ctx.accounts.base_transfer_ctx(), pull_base)?;
        token::transfer(ctx.accounts.quote_transfer_ctx(), pull_quote)?;
        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[
            b"vault",
            ctx.accounts.vault.base_mint.as_ref(),
            ctx.accounts.vault.quote_mint.as_ref(),
            &bump,
        ];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.user_shares.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            shares,
        )?;
        // Every deposit grows the supply. The first deposit additionally counts
        // the permanently locked minimum-liquidity shares. (Previously this ran
        // only when `total_shares == 0`, so later deposits minted shares that
        // the supply never recorded.)
        let locked = if total_shares == 0 {
            ctx.accounts.config.min_liquidity
        } else {
            0
        };
        ctx.accounts.vault.total_shares = total_shares
            .checked_add(shares)
            .and_then(|value| value.checked_add(locked))
            .ok_or(ErrorCode::MathOverflow)?;
        let ticket = &mut ctx.accounts.deposit_ticket;
        ticket.owner = ctx.accounts.user.key();
        ticket.shares = shares;
        ticket.activate_slot = Clock::get()?
            .slot
            .checked_add(ctx.accounts.config.warmup_slots)
            .ok_or(ErrorCode::MathOverflow)?;
        ticket.bump = ctx.bumps.deposit_ticket;
        emit!(DepositEvent {
            slot: Clock::get()?.slot,
            shares,
            base_amount: pull_base,
            quote_amount: pull_quote
        });
        Ok(())
    }

    pub fn request_withdraw(ctx: Context<RequestWithdraw>, shares: u64) -> Result<()> {
        require!(
            shares > 0 && shares <= ctx.accounts.user_shares.amount,
            ErrorCode::InvalidAmount
        );
        require!(
            Clock::get()?.slot >= ctx.accounts.deposit_ticket.activate_slot,
            ErrorCode::WarmupNotElapsed
        );
        token::transfer(ctx.accounts.queue_transfer_ctx(), shares)?;
        let ticket = &mut ctx.accounts.withdraw_ticket;
        ticket.owner = ctx.accounts.user.key();
        ticket.shares = shares;
        ticket.epoch = ctx
            .accounts
            .vault
            .epoch
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;
        ticket.bump = ctx.bumps.withdraw_ticket;
        emit!(WithdrawRequested {
            slot: Clock::get()?.slot,
            shares,
            epoch: ticket.epoch
        });
        Ok(())
    }

    pub fn crank_epoch(ctx: Context<CrankEpoch>) -> Result<()> {
        let now = Clock::get()?.slot;
        require!(
            now >= ctx
                .accounts
                .vault
                .epoch_start
                .checked_add(ctx.accounts.config.epoch_slots)
                .ok_or(ErrorCode::MathOverflow)?,
            ErrorCode::EpochNotReached
        );
        ctx.accounts.vault.epoch = ctx
            .accounts
            .vault
            .epoch
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;
        ctx.accounts.vault.epoch_start = now;
        Ok(())
    }

    pub fn claim_withdraw(ctx: Context<ClaimWithdraw>) -> Result<()> {
        require!(
            ctx.accounts.withdraw_ticket.epoch <= ctx.accounts.vault.epoch,
            ErrorCode::EpochNotReached
        );
        let total = ctx.accounts.vault.total_shares;
        require!(total > 0, ErrorCode::MathOverflow);
        let shares = ctx.accounts.withdraw_ticket.shares as u128;
        require!(shares > 0, ErrorCode::InvalidAmount);
        let base_available = ctx
            .accounts
            .base_reserve
            .amount
            .saturating_sub(ctx.accounts.vault.insurance_base)
            .saturating_sub(ctx.accounts.vault.keeper_base)
            .saturating_sub(ctx.accounts.vault.protocol_base);
        let quote_available = ctx
            .accounts
            .quote_reserve
            .amount
            .saturating_sub(ctx.accounts.vault.insurance_quote)
            .saturating_sub(ctx.accounts.vault.keeper_quote)
            .saturating_sub(ctx.accounts.vault.protocol_quote);
        let base_out = shares
            .checked_mul(base_available as u128)
            .ok_or(ErrorCode::MathOverflow)?
            / total as u128;
        let quote_out = shares
            .checked_mul(quote_available as u128)
            .ok_or(ErrorCode::MathOverflow)?
            / total as u128;
        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[
            b"vault",
            ctx.accounts.vault.base_mint.as_ref(),
            ctx.accounts.vault.quote_mint.as_ref(),
            &bump,
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.base_reserve.to_account_info(),
                    to: ctx.accounts.user_base.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            base_out as u64,
        )?;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.quote_reserve.to_account_info(),
                    to: ctx.accounts.user_quote.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            quote_out as u64,
        )?;
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    from: ctx.accounts.share_lock.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            ctx.accounts.withdraw_ticket.shares,
        )?;
        ctx.accounts.vault.total_shares = total
            .checked_sub(ctx.accounts.withdraw_ticket.shares)
            .ok_or(ErrorCode::MathOverflow)?;
        // Mark the ticket claimed so the same shares cannot be withdrawn twice;
        // the reusable ticket can then queue a new request (audit F-10).
        ctx.accounts.withdraw_ticket.shares = 0;
        emit!(WithdrawClaimed {
            slot: Clock::get()?.slot,
            shares: ctx.accounts.withdraw_ticket.shares,
            base_amount: base_out as u64,
            quote_amount: quote_out as u64
        });
        Ok(())
    }

    pub fn update_quote(ctx: Context<UpdateQuote>, update: QuoteUpdate) -> Result<()> {
        require!(ctx.accounts.vault.status == ACTIVE, ErrorCode::Paused);
        // M7 open keeper network: when a minimum bond is configured, quoting is
        // **permissionless** — any bond-qualified keeper may update (the bond and
        // the monotonic-slot guard below make updates accountable and
        // first-writer-per-slot). The allowlist is the MVP path only
        // (`min_bond == 0`).
        // S2-19: quote maintenance is permissionless. With `min_bond == 0` any
        // valid signer may quote; with `min_bond > 0` any keeper meeting the
        // on-chain bond requirement may quote. There is no single-keeper
        // allowlist. The D-07 bond check below still applies when bonded.
        // (The allowlist equality check against `config.keeper` was removed.)
        if ctx.accounts.config.min_bond > 0 {
            let (expected, _) = Pubkey::find_program_address(
                &[
                    b"keeper",
                    ctx.accounts.vault.key().as_ref(),
                    ctx.accounts.keeper.key().as_ref(),
                ],
                &crate::ID,
            );
            require!(
                ctx.accounts.keeper_bond.key() == expected,
                ErrorCode::NotBonded
            );
            let data = ctx
                .accounts
                .keeper_bond
                .try_borrow_data()
                .map_err(|_| error!(ErrorCode::NotBonded))?;
            let bond = KeeperBond::try_deserialize(&mut &data[..])
                .map_err(|_| error!(ErrorCode::NotBonded))?;
            // p2-T5: while an unbond is pending, the effective bond is
            // `bond - unbond_amount`, so a keeper that is releasing its stake
            // can no longer quote once the effective bond falls below the
            // configured minimum (quoting deactivates).
            require!(
                bond.keeper == ctx.accounts.keeper.key()
                    && bond.bond.saturating_sub(bond.unbond_amount) >= ctx.accounts.config.min_bond,
                ErrorCode::NotBonded
            );
        }
        let clock = Clock::get()?;
        // Item 2 decision: keep `<= clock.slot`, NOT `== clock.slot`. A keeper
        // observes the oracle at slot X and the transaction lands at X+k due to
        // network/landing delay (the simulator models this explicitly, see
        // `costs.landing_delay`). Requiring equality would reject every
        // realistically-landed update. Backdating within the window is harmless:
        // quote expiry and freshness are evaluated against the *actual* clock at
        // swap/verify time, not against `update_slot`, so a stale `update_slot`
        // buys the keeper nothing and the monotonic `> stored` guard prevents
        // reusing an old slot to overwrite a newer quote.
        require!(
            update.update_slot > ctx.accounts.quote_state.update_slot
                && update.update_slot <= clock.slot,
            ErrorCode::NonMonotonicSlot
        );
        // p2-T8: bound how stale the keeper's observed slot may be, so a quote
        // cannot be built on an arbitrarily old price observation.
        require!(
            clock.slot.saturating_sub(update.update_slot)
                <= ctx.accounts.config.max_update_slot_age as u64,
            ErrorCode::UpdateSlotTooOld
        );
        let oracle_price = validate_quote_update(
            &ctx.accounts.config,
            &ctx.accounts.quote_state,
            &update,
            &ctx.accounts.price_update,
            ctx.accounts.base_reserve.amount,
            ctx.accounts.quote_reserve.amount,
            &ctx.accounts.vault,
            ctx.accounts.base_mint.decimals,
            ctx.accounts.quote_mint.decimals,
            &clock,
        )?;
        let _version = apply_quote_update(
            &mut ctx.accounts.quote_state,
            &ctx.accounts.config,
            &update,
            oracle_price,
            &clock,
        )?;
        // S2-19: record the keeper that authored this quote version.
        set_quote_author(&mut ctx.accounts.quote_state, ctx.accounts.keeper.key());
        Ok(())
    }
    /// S2-11: stage a quote into the `PendingQuote` PDA without touching the
    /// active `QuoteState`. The staged payload is only ever applied by
    /// `commit_quote`, which runs in the same transaction as the fresh Pyth
    /// price update, so the oracle write and the quote commit are atomic.
    pub fn stage_quote(ctx: Context<StageQuote>, update: QuoteUpdate, nonce: u64) -> Result<()> {
        require!(ctx.accounts.vault.status == ACTIVE, ErrorCode::Paused);
        require_keeper_authorized(
            &ctx.accounts.config,
            &ctx.accounts.keeper.key(),
            &ctx.accounts.vault.key(),
            &ctx.accounts.keeper_bond.to_account_info(),
        )?;
        let clock = Clock::get()?;
        let pq = &mut ctx.accounts.pending_quote;
        // Monotonic nonce: a new stage must supersede the last committed one, so
        // a consumed (committed) payload can never be replayed.
        require!(nonce > pq.committed_nonce, ErrorCode::StalePendingQuote);
        // Oracle-independent shape checks (cheap, fail-fast). The authoritative
        // oracle/ladder/inventory/capacity checks run at `commit_quote`.
        require!(update.oracle_publish_time >= 0, ErrorCode::InvalidPrice);
        require!(
            update.weights_bps.iter().map(|v| *v as u64).sum::<u64>() == 10_000,
            ErrorCode::InvalidWeights
        );
        require!(
            update.offsets_bps.windows(2).all(|w| w[0] < w[1])
                && update.offsets_bps[LEVELS - 1] <= MAX_LEVEL_OFFSET_BPS,
            ErrorCode::InvalidLadder
        );
        require!(
            update
                .ask_levels
                .iter()
                .chain(update.bid_levels.iter())
                .all(|l| l.sqrt_lo > 0 && l.sqrt_lo < l.sqrt_hi && l.liquidity > 0),
            ErrorCode::InvalidLadder
        );
        pq.vault = ctx.accounts.vault.key();
        pq.keeper = ctx.accounts.keeper.key();
        pq.nonce = nonce;
        pq.pending = 1;
        pq.stage_slot = clock.slot;
        pq.base_reserve_at_stage = ctx.accounts.base_reserve.amount;
        pq.quote_reserve_at_stage = ctx.accounts.quote_reserve.amount;
        pq.insurance_base = ctx.accounts.vault.insurance_base;
        pq.insurance_quote = ctx.accounts.vault.insurance_quote;
        pq.keeper_base = ctx.accounts.vault.keeper_base;
        pq.keeper_quote = ctx.accounts.vault.keeper_quote;
        pq.protocol_base = ctx.accounts.vault.protocol_base;
        pq.protocol_quote = ctx.accounts.vault.protocol_quote;
        pq.quote_version_at_stage = ctx.accounts.quote_state.version;
        pq.quote_update_slot_at_stage = ctx.accounts.quote_state.update_slot;
        pq.bump = ctx.bumps.pending_quote;
        pq.update = update;
        emit!(QuoteStaged {
            slot: clock.slot,
            nonce,
            oracle_publish_time: update.oracle_publish_time,
            update_slot: update.update_slot,
        });
        Ok(())
    }

    /// S2-11: commit a staged quote against the `PriceUpdateV2` account written
    /// by the Pyth instruction that precedes this instruction in the same
    /// transaction. Every oracle, mint-normalization, anchor, ladder, inventory,
    /// flow and capacity guard is re-applied here; nothing is trusted from
    /// staging beyond the payload itself. Any failure leaves the active quote
    /// unchanged (transaction atomicity).
    pub fn commit_quote(ctx: Context<CommitQuote>, nonce: u64) -> Result<()> {
        require!(ctx.accounts.vault.status == ACTIVE, ErrorCode::Paused);
        require_keeper_authorized(
            &ctx.accounts.config,
            &ctx.accounts.keeper.key(),
            &ctx.accounts.vault.key(),
            &ctx.accounts.keeper_bond.to_account_info(),
        )?;
        let clock = Clock::get()?;
        let pq = &mut ctx.accounts.pending_quote;
        require!(pq.pending == 1, ErrorCode::NoPendingQuote);
        require!(
            pq.vault == ctx.accounts.vault.key() && pq.keeper == ctx.accounts.keeper.key(),
            ErrorCode::NotKeeper
        );
        require!(
            pq.nonce == nonce && nonce > pq.committed_nonce,
            ErrorCode::StalePendingQuote
        );
        require!(
            clock.slot.saturating_sub(pq.stage_slot) <= MAX_STAGE_AGE_SLOTS,
            ErrorCode::StalePendingQuote
        );
        // Reject if quote-relevant vault/reserve state moved between staging and
        // commit: the depth the keeper sized against must still be available and
        // the active quote version/update-slot must be unchanged.
        require!(
            pq.base_reserve_at_stage == ctx.accounts.base_reserve.amount
                && pq.quote_reserve_at_stage == ctx.accounts.quote_reserve.amount
                && pq.insurance_base == ctx.accounts.vault.insurance_base
                && pq.insurance_quote == ctx.accounts.vault.insurance_quote
                && pq.keeper_base == ctx.accounts.vault.keeper_base
                && pq.keeper_quote == ctx.accounts.vault.keeper_quote
                && pq.protocol_base == ctx.accounts.vault.protocol_base
                && pq.protocol_quote == ctx.accounts.vault.protocol_quote
                && pq.quote_version_at_stage == ctx.accounts.quote_state.version
                && pq.quote_update_slot_at_stage == ctx.accounts.quote_state.update_slot,
            ErrorCode::StagedStateChanged
        );
        let update = pq.update;
        require!(
            update.update_slot > ctx.accounts.quote_state.update_slot
                && update.update_slot <= clock.slot,
            ErrorCode::NonMonotonicSlot
        );
        require!(
            clock.slot.saturating_sub(update.update_slot)
                <= ctx.accounts.config.max_update_slot_age as u64,
            ErrorCode::UpdateSlotTooOld
        );
        let oracle_price = validate_quote_update(
            &ctx.accounts.config,
            &ctx.accounts.quote_state,
            &update,
            &ctx.accounts.price_update,
            ctx.accounts.base_reserve.amount,
            ctx.accounts.quote_reserve.amount,
            &ctx.accounts.vault,
            ctx.accounts.base_mint.decimals,
            ctx.accounts.quote_mint.decimals,
            &clock,
        )?;
        let version = apply_quote_update(
            &mut ctx.accounts.quote_state,
            &ctx.accounts.config,
            &update,
            oracle_price,
            &clock,
        )?;
        // S2-19: record the keeper that authored this committed quote version.
        set_quote_author(&mut ctx.accounts.quote_state, ctx.accounts.keeper.key());
        // Consume the staged record only after the quote is applied, so a failed
        // commit leaves it intact for a retry while a consumed nonce cannot replay.
        pq.pending = 0;
        pq.committed_nonce = nonce;
        emit!(QuoteCommitted {
            slot: clock.slot,
            version,
            nonce
        });
        Ok(())
    }

    pub fn swap(
        ctx: Context<Swap>,
        side: SwapSide,
        amount_in: u64,
        min_out: u64,
        min_version: u64,
    ) -> Result<()> {
        require!(ctx.accounts.vault.status == ACTIVE, ErrorCode::Paused);
        let clock = Clock::get()?;
        let quote_version = ctx.accounts.quote_state.version;
        require!(quote_version >= min_version, ErrorCode::VersionTooOld);
        require!(
            clock.slot < ctx.accounts.quote_state.expiry_slot,
            ErrorCode::QuoteExpired
        );
        // S2-21A: a migrated legacy quote has no verified author. It must not be
        // swapped against (that could accrue unclaimable rewards and enable an
        // unattributed quote); a newly committed, attributed quote is required.
        require!(
            ctx.accounts.quote_state.keeper != Pubkey::default(),
            ErrorCode::UnattributedQuote
        );
        // S2-19: the reward PDA seeds bind this account to `quote_state.keeper`
        // (the author of the active quote). Initialise its metadata on first use
        // so a freshly-created account accrues to the correct keeper, then
        // re-assert the binding explicitly.
        if ctx.accounts.keeper_reward.keeper == Pubkey::default() {
            ctx.accounts.keeper_reward.keeper = ctx.accounts.quote_state.keeper;
            ctx.accounts.keeper_reward.bump = ctx.bumps.keeper_reward;
        }
        require!(
            ctx.accounts.keeper_reward.keeper == ctx.accounts.quote_state.keeper,
            ErrorCode::QuoteAttributionMismatch
        );
        require!(
            amount_in > 0 && amount_in <= ctx.accounts.config.max_quote_size,
            ErrorCode::CapacityExceeded
        );
        let fee = arb_math::fee_amount(amount_in as u128, ctx.accounts.config.fee_bps as u128)
            .map_err(|_| error!(ErrorCode::MathOverflow))? as u64;
        let net = amount_in.checked_sub(fee).ok_or(ErrorCode::MathOverflow)?;
        // h1: the vault trades against the side-specific ladder. A trader buying
        // base lifts the ask ladder; a trader selling base hits the bid ladder.
        let (side_levels, math_side) = match side {
            SwapSide::BuyBase => (&ctx.accounts.quote_state.ask_levels, MathSide::Ask),
            SwapSide::SellBase => (&ctx.accounts.quote_state.bid_levels, MathSide::Bid),
        };
        let levels: Vec<MathLevel> = side_levels
            .iter()
            .map(|l| MathLevel {
                sqrt_lo: l.sqrt_lo,
                sqrt_hi: l.sqrt_hi,
                liquidity: l.liquidity,
            })
            .collect();
        let result = walk_ladder(&levels, math_side, net as u128)
            .map_err(|_| error!(ErrorCode::MathOverflow))?;
        require!(result.remaining == 0, ErrorCode::CapacityExceeded);
        let out = result.out as u64;
        require!(out >= min_out, ErrorCode::SlippageExceeded);
        // Item 1a: bound a compromised keeper with a per-window cumulative
        // one-sided flow cap. The window rolls over on the slot clock, NOT on
        // update_quote, so a keeper cannot reset the cap by re-quoting.
        let window = ctx.accounts.config.flow_window_slots;
        if window > 0
            && clock.slot
                >= ctx
                    .accounts
                    .quote_state
                    .window_start_slot
                    .saturating_add(window)
        {
            ctx.accounts.quote_state.window_start_slot = clock.slot;
            ctx.accounts.quote_state.window_base_sold = 0;
            ctx.accounts.quote_state.window_base_bought = 0;
        }
        let flow_cap = arb_math::mul_div_floor(
            ctx.accounts.base_reserve.amount as u128,
            ctx.accounts.config.max_window_flow_bps as u128,
            BPS_DENOM as u128,
        )
        .unwrap_or(0) as u64;
        let (base_sold, base_bought) = match side {
            SwapSide::BuyBase => (out, 0u64),
            SwapSide::SellBase => (0u64, net),
        };
        ctx.accounts.quote_state.window_base_sold = ctx
            .accounts
            .quote_state
            .window_base_sold
            .checked_add(base_sold)
            .ok_or(ErrorCode::MathOverflow)?;
        ctx.accounts.quote_state.window_base_bought = ctx
            .accounts
            .quote_state
            .window_base_bought
            .checked_add(base_bought)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(
            ctx.accounts.quote_state.window_base_sold <= flow_cap
                && ctx.accounts.quote_state.window_base_bought <= flow_cap,
            ErrorCode::FlowCapExceeded
        );
        // Spec §5.9: maintain the signed net-base-sold accumulator since the last
        // quote update (positive = the vault sold base on net). Reset in
        // `update_quote`; readable by the keeper/indexer for flow-aware pricing.
        match side {
            SwapSide::BuyBase => {
                ctx.accounts.quote_state.flow_n =
                    ctx.accounts.quote_state.flow_n.saturating_add(out as i128);
            }
            SwapSide::SellBase => {
                ctx.accounts.quote_state.flow_n =
                    ctx.accounts.quote_state.flow_n.saturating_sub(net as i128);
            }
        }
        let insurance =
            (fee as u128).saturating_mul(ctx.accounts.config.insurance_bps as u128) / 10_000;
        let keeper = (fee as u128).saturating_mul(ctx.accounts.config.keeper_bps as u128) / 10_000;
        let protocol =
            (fee as u128).saturating_mul(ctx.accounts.config.protocol_bps as u128) / 10_000;
        match side {
            SwapSide::BuyBase => {
                token::transfer(ctx.accounts.quote_transfer_ctx(), amount_in)?;
                let bump = [ctx.accounts.vault.bump];
                let seeds: &[&[u8]] = &[
                    b"vault",
                    ctx.accounts.vault.base_mint.as_ref(),
                    ctx.accounts.vault.quote_mint.as_ref(),
                    &bump,
                ];
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        Transfer {
                            from: ctx.accounts.base_reserve.to_account_info(),
                            to: ctx.accounts.trader_base.to_account_info(),
                            authority: ctx.accounts.vault.to_account_info(),
                        },
                        &[seeds],
                    ),
                    out,
                )?;
                ctx.accounts.vault.insurance_quote = ctx
                    .accounts
                    .vault
                    .insurance_quote
                    .checked_add(insurance as u64)
                    .ok_or(ErrorCode::MathOverflow)?;
                ctx.accounts.vault.keeper_quote = ctx
                    .accounts
                    .vault
                    .keeper_quote
                    .checked_add(keeper as u64)
                    .ok_or(ErrorCode::MathOverflow)?;
                ctx.accounts.keeper_reward.quote = ctx
                    .accounts
                    .keeper_reward
                    .quote
                    .checked_add(keeper as u64)
                    .ok_or(ErrorCode::MathOverflow)?;
                ctx.accounts.vault.protocol_quote = ctx
                    .accounts
                    .vault
                    .protocol_quote
                    .checked_add(protocol as u64)
                    .ok_or(ErrorCode::MathOverflow)?;
            }
            SwapSide::SellBase => {
                token::transfer(ctx.accounts.base_transfer_ctx(), amount_in)?;
                let bump = [ctx.accounts.vault.bump];
                let seeds: &[&[u8]] = &[
                    b"vault",
                    ctx.accounts.vault.base_mint.as_ref(),
                    ctx.accounts.vault.quote_mint.as_ref(),
                    &bump,
                ];
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        Transfer {
                            from: ctx.accounts.quote_reserve.to_account_info(),
                            to: ctx.accounts.trader_quote.to_account_info(),
                            authority: ctx.accounts.vault.to_account_info(),
                        },
                        &[seeds],
                    ),
                    out,
                )?;
                ctx.accounts.vault.insurance_base = ctx
                    .accounts
                    .vault
                    .insurance_base
                    .checked_add(insurance as u64)
                    .ok_or(ErrorCode::MathOverflow)?;
                ctx.accounts.vault.keeper_base = ctx
                    .accounts
                    .vault
                    .keeper_base
                    .checked_add(keeper as u64)
                    .ok_or(ErrorCode::MathOverflow)?;
                ctx.accounts.keeper_reward.base = ctx
                    .accounts
                    .keeper_reward
                    .base
                    .checked_add(keeper as u64)
                    .ok_or(ErrorCode::MathOverflow)?;
                ctx.accounts.vault.protocol_base = ctx
                    .accounts
                    .vault
                    .protocol_base
                    .checked_add(protocol as u64)
                    .ok_or(ErrorCode::MathOverflow)?;
            }
        }
        // h3: realized execution edge vs the stored verified oracle. Positive
        // means the vault traded better than the oracle mid; the running sum is
        // checked against a fraction of the available value each swap.
        let oracle = ctx.accounts.quote_state.oracle_price;
        let edge: i128 = match side {
            SwapSide::BuyBase => {
                let out_value = ((out as u128).saturating_mul(oracle) >> 64) as i128;
                (amount_in as i128).saturating_sub(out_value)
            }
            SwapSide::SellBase => {
                let in_value = ((amount_in as u128).saturating_mul(oracle) >> 64) as i128;
                in_value.saturating_sub(out as i128)
            }
        };
        let edge_window = ctx.accounts.config.edge_window_slots;
        if ctx.accounts.quote_state.edge_window_start_slot == 0 {
            // First swap after initialization starts the window.
            ctx.accounts.quote_state.edge_window_start_slot = clock.slot;
        } else if edge_window > 0
            && clock.slot
                >= ctx
                    .accounts
                    .quote_state
                    .edge_window_start_slot
                    .saturating_add(edge_window)
        {
            ctx.accounts.quote_state.edge_window_start_slot = clock.slot;
            ctx.accounts.quote_state.realized_edge = 0;
        }
        ctx.accounts.quote_state.realized_edge =
            ctx.accounts.quote_state.realized_edge.saturating_add(edge);
        let avail_base = ctx
            .accounts
            .base_reserve
            .amount
            .saturating_sub(ctx.accounts.vault.insurance_base)
            .saturating_sub(ctx.accounts.vault.keeper_base)
            .saturating_sub(ctx.accounts.vault.protocol_base) as u128;
        let avail_quote = ctx
            .accounts
            .quote_reserve
            .amount
            .saturating_sub(ctx.accounts.vault.insurance_quote)
            .saturating_sub(ctx.accounts.vault.keeper_quote)
            .saturating_sub(ctx.accounts.vault.protocol_quote) as u128;
        let available_value =
            ((avail_base.saturating_mul(oracle)) >> 64).saturating_add(avail_quote);
        let loss_bound =
            available_value.saturating_mul(ctx.accounts.config.max_edge_loss_bps as u128) / 10_000;
        if ctx.accounts.quote_state.realized_edge < -(loss_bound as i128) {
            ctx.accounts.vault.status = PAUSED;
            emit!(EdgeBreakerTripped {
                slot: clock.slot,
                realized_edge: ctx.accounts.quote_state.realized_edge,
                bound: loss_bound
            });
        }
        emit!(SwapEvent {
            slot: clock.slot,
            version: quote_version,
            side,
            amount_in,
            amount_out: out,
            fee
        });
        Ok(())
    }

    pub fn trip_breaker(ctx: Context<TripBreaker>) -> Result<()> {
        require!(
            ctx.accounts.vault.status == ACTIVE,
            ErrorCode::InvalidStatus
        );
        let clock = Clock::get()?;
        // p2-T4: the permissionless breaker is deliberately **state-only**. It
        // never reads a caller-supplied oracle account: an attacker could
        // otherwise present an old-but-valid `PriceUpdateV2` for the same feed
        // and pause the vault (griefing). It may trip on (a) an expired stored
        // quote, or (b) a stored oracle publish time that is far older than
        // `max_staleness_seconds` × `STALENESS_TRIP_MULTIPLE`.
        let quote = &ctx.accounts.quote_state;
        require!(quote.version > 0, ErrorCode::BreakerConditionNotMet);
        let expired = clock.slot >= quote.expiry_slot;
        let max_staleness = ctx.accounts.config.max_staleness_seconds;
        let stale = max_staleness > 0
            && quote.oracle_publish_time > 0
            && clock.unix_timestamp > quote.oracle_publish_time
            && clock
                .unix_timestamp
                .saturating_sub(quote.oracle_publish_time)
                > max_staleness.saturating_mul(STALENESS_TRIP_MULTIPLE);
        require!(expired || stale, ErrorCode::BreakerConditionNotMet);
        ctx.accounts.vault.status = PAUSED;
        emit!(BreakerTripped { slot: clock.slot });
        Ok(())
    }
    pub fn reset_breaker(ctx: Context<ResetBreaker>) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.vault.admin,
            ErrorCode::Unauthorized
        );
        require!(
            ctx.accounts.vault.status == PAUSED,
            ErrorCode::InvalidStatus
        );
        ctx.accounts.vault.status = ACTIVE;
        emit!(BreakerReset {
            slot: Clock::get()?.slot
        });
        Ok(())
    }
    pub fn wind_down(ctx: Context<WindDown>) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.vault.admin,
            ErrorCode::Unauthorized
        );
        ctx.accounts.vault.status = WIND_DOWN;
        Ok(())
    }

    /// F-17: admin proposes tunable parameters. They take effect only after
    /// `apply_params` and at least `TIMELOCK_SLOTS` slots later.
    pub fn set_params(ctx: Context<SetParams>, params: ParamsUpdate) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.vault.admin,
            ErrorCode::Unauthorized
        );
        require!(
            (params.insurance_bps as u32 + params.keeper_bps as u32 + params.protocol_bps as u32)
                <= 10_000,
            ErrorCode::InvalidParams
        );
        // S2-37: `expiry_slots` is now tunable; bound it at proposal time too.
        require!(
            params.expiry_slots > ctx.accounts.config.grace_slots,
            ErrorCode::InvalidParams
        );
        require!(
            params.expiry_slots <= MAX_EXPIRY_SLOTS,
            ErrorCode::InvalidParams
        );
        let now = Clock::get()?.slot;
        let pending = &mut ctx.accounts.pending_config;
        pending.admin = ctx.accounts.admin.key();
        pending.activate_slot = now.saturating_add(TIMELOCK_SLOTS);
        pending.params = params;
        pending.bump = ctx.bumps.pending_config;
        emit!(ParamsProposed {
            slot: now,
            activate_slot: pending.activate_slot
        });
        Ok(())
    }

    /// Applies a previously proposed parameter set once the timelock elapsed.
    pub fn apply_params(ctx: Context<ApplyParams>) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.vault.admin
                && ctx.accounts.pending_config.admin == ctx.accounts.admin.key(),
            ErrorCode::Unauthorized
        );
        require!(
            Clock::get()?.slot >= ctx.accounts.pending_config.activate_slot,
            ErrorCode::TimelockNotElapsed
        );
        let update = ctx.accounts.pending_config.params;
        require!(
            update.min_spread_bps <= update.max_spread_bps,
            ErrorCode::InvalidParams
        );
        require!(
            update.utilization_max_bps <= 8_000,
            ErrorCode::InvalidParams
        );
        // S2-37: re-validate the tunable expiry window at application time.
        require!(
            update.expiry_slots > ctx.accounts.config.grace_slots,
            ErrorCode::InvalidParams
        );
        require!(
            update.expiry_slots <= MAX_EXPIRY_SLOTS,
            ErrorCode::InvalidParams
        );
        let config = &mut ctx.accounts.config;
        config.fee_bps = update.fee_bps;
        config.insurance_bps = update.insurance_bps;
        config.keeper_bps = update.keeper_bps;
        config.protocol_bps = update.protocol_bps;
        config.max_staleness_seconds = update.max_staleness_seconds;
        config.max_conf_bps = update.max_conf_bps;
        config.max_anchor_step_bps = update.max_anchor_step_bps;
        config.max_spread_step_bps = update.max_spread_step_bps;
        config.min_spread_bps = update.min_spread_bps;
        config.max_spread_bps = update.max_spread_bps;
        config.max_quote_size = update.max_quote_size;
        config.max_inventory_bps = update.max_inventory_bps;
        config.utilization_max_bps = update.utilization_max_bps;
        // S2-19: `config.min_bond` and `config.keeper` are deliberately NOT
        // applied here (they are not in `ParamsUpdate`). Keeper eligibility is
        // immutable after initialization — the admin cannot turn quoting into a
        // single-wallet allowlist or raise the bond to exclude everyone.
        config.unbond_cooldown_slots = update.unbond_cooldown_slots;
        config.max_update_slot_age = update.max_update_slot_age;
        config.edge_window_slots = update.edge_window_slots;
        config.max_edge_loss_bps = update.max_edge_loss_bps;
        config.max_anchor_dev_bps = update.max_anchor_dev_bps;
        config.flow_window_slots = update.flow_window_slots;
        config.max_window_flow_bps = update.max_window_flow_bps;
        // S2-37: the only newly tunable field (`expiry_slots`); everything else
        // in `apply_params` is unchanged.
        config.expiry_slots = update.expiry_slots;
        ctx.accounts.pending_config.activate_slot = u64::MAX;
        emit!(ParamsApplied {
            slot: Clock::get()?.slot
        });
        Ok(())
    }

    /// B4: the current admin proposes a successor. It takes effect only when the
    /// successor signs `accept_admin`, at least `TIMELOCK_SLOTS` later. The old
    /// admin cannot be locked out by a typo: acceptance is required.
    pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.vault.admin,
            ErrorCode::Unauthorized
        );
        require!(new_admin != Pubkey::default(), ErrorCode::InvalidParams);
        let now = Clock::get()?.slot;
        let config = &mut ctx.accounts.config;
        config.pending_admin = new_admin;
        config.admin_activate_slot = now.saturating_add(TIMELOCK_SLOTS);
        emit!(AdminProposed {
            slot: now,
            new_admin,
            activate_slot: config.admin_activate_slot,
        });
        Ok(())
    }

    /// B4: the proposed successor accepts; the timelock must have elapsed.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        require!(
            ctx.accounts.config.pending_admin != Pubkey::default()
                && ctx.accounts.new_admin.key() == ctx.accounts.config.pending_admin,
            ErrorCode::Unauthorized
        );
        let now = Clock::get()?.slot;
        require!(
            now >= ctx.accounts.config.admin_activate_slot,
            ErrorCode::TimelockNotElapsed
        );
        ctx.accounts.vault.admin = ctx.accounts.new_admin.key();
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.new_admin.key();
        config.pending_admin = Pubkey::default();
        config.admin_activate_slot = 0;
        emit!(AdminChanged {
            slot: now,
            new_admin: ctx.accounts.new_admin.key(),
        });
        Ok(())
    }

    /// B4: the current admin cancels a pending rotation.
    pub fn cancel_admin(ctx: Context<CancelAdmin>) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.vault.admin,
            ErrorCode::Unauthorized
        );
        let config = &mut ctx.accounts.config;
        require!(
            config.pending_admin != Pubkey::default(),
            ErrorCode::NoPendingAdmin
        );
        config.pending_admin = Pubkey::default();
        config.admin_activate_slot = 0;
        Ok(())
    }

    /// T3.4: the keeper locks a bond in the quote token. The bond is held in a
    /// vault-owned PDA token account, so no external key can move it.
    pub fn bond_keeper(ctx: Context<BondKeeper>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        token::transfer(ctx.accounts.fund_bond_ctx(), amount)?;
        let bond = &mut ctx.accounts.keeper_bond;
        bond.keeper = ctx.accounts.keeper.key();
        bond.bond = bond
            .bond
            .checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        bond.bump = ctx.bumps.keeper_bond;
        emit!(KeeperBonded {
            keeper: bond.keeper,
            amount,
            total: bond.bond
        });
        Ok(())
    }

    /// p2-T5: two-phase keeper unbond. The first call queues `amount` and starts
    /// the cooldown; a second call after the cooldown releases the queued amount
    /// (capped at the remaining bond, so a slash during the cooldown reduces the
    /// payout). The admin may slash at any time; rewards stay claimable.
    pub fn unbond_keeper(ctx: Context<UnbondKeeper>, amount: u64) -> Result<()> {
        let clock = Clock::get()?;
        let bond = &mut ctx.accounts.keeper_bond;
        if bond.unbond_ready_slot == 0 {
            require!(
                amount > 0 && amount <= bond.bond,
                ErrorCode::InsufficientBond
            );
            bond.unbond_amount = amount;
            bond.unbond_ready_slot = clock
                .slot
                .checked_add(ctx.accounts.config.unbond_cooldown_slots)
                .ok_or(ErrorCode::MathOverflow)?;
        } else {
            require!(
                clock.slot >= bond.unbond_ready_slot,
                ErrorCode::TimelockNotElapsed
            );
            // h4: the release call must name exactly the queued amount, so a
            // caller cannot silently release a different (larger) stake.
            require!(amount == bond.unbond_amount, ErrorCode::InvalidAmount);
            let release = bond.unbond_amount.min(bond.bond);
            if release > 0 {
                let bump = [ctx.accounts.vault.bump];
                let seeds: &[&[u8]] = &[
                    b"vault",
                    ctx.accounts.vault.base_mint.as_ref(),
                    ctx.accounts.vault.quote_mint.as_ref(),
                    &bump,
                ];
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        Transfer {
                            from: ctx.accounts.bond_vault.to_account_info(),
                            to: ctx.accounts.keeper_quote.to_account_info(),
                            authority: ctx.accounts.vault.to_account_info(),
                        },
                        &[seeds],
                    ),
                    release,
                )?;
            }
            bond.bond = bond.bond.saturating_sub(release);
            bond.unbond_amount = 0;
            bond.unbond_ready_slot = 0;
            emit!(KeeperUnbonded {
                keeper: bond.keeper,
                amount: release
            });
        }
        Ok(())
    }

    /// T3.4: admin slashes the bond; the slashed tokens go to the quote reserve
    /// and are booked to the insurance bucket. Never to the admin.
    pub fn slash_keeper(ctx: Context<SlashKeeper>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.vault.admin,
            ErrorCode::Unauthorized
        );
        require!(
            amount > 0 && amount <= ctx.accounts.keeper_bond.bond,
            ErrorCode::InsufficientBond
        );
        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[
            b"vault",
            ctx.accounts.vault.base_mint.as_ref(),
            ctx.accounts.vault.quote_mint.as_ref(),
            &bump,
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.bond_vault.to_account_info(),
                    to: ctx.accounts.quote_reserve.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        let bond = &mut ctx.accounts.keeper_bond;
        bond.bond -= amount;
        bond.slashed = bond
            .slashed
            .checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        ctx.accounts.vault.insurance_quote = ctx
            .accounts
            .vault
            .insurance_quote
            .checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        emit!(KeeperSlashed {
            keeper: bond.keeper,
            amount
        });
        Ok(())
    }

    /// T3.4: the configured keeper claims exactly the accrued reward buckets.
    /// Only the keeper can claim, only the `keeper_*` buckets move, and they are
    /// zeroed, so no vault principal can ever be drained.
    pub fn claim_keeper_reward(ctx: Context<ClaimKeeperReward>) -> Result<()> {
        // S2-19: rewards are per-keeper. The signer claims only their own
        // attributed accrual; `config.keeper` no longer confers any exclusive
        // entitlement. The aggregate vault keeper buckets still track the total
        // outstanding and cap the claim, so LP/protocol principal cannot drain.
        require!(
            ctx.accounts.keeper_reward.keeper == ctx.accounts.keeper.key(),
            ErrorCode::NotKeeper
        );
        let base_reward = ctx
            .accounts
            .keeper_reward
            .base
            .min(ctx.accounts.vault.keeper_base);
        let quote_reward = ctx
            .accounts
            .keeper_reward
            .quote
            .min(ctx.accounts.vault.keeper_quote);
        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[
            b"vault",
            ctx.accounts.vault.base_mint.as_ref(),
            ctx.accounts.vault.quote_mint.as_ref(),
            &bump,
        ];
        if base_reward > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.base_reserve.to_account_info(),
                        to: ctx.accounts.keeper_base.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[seeds],
                ),
                base_reward,
            )?;
        }
        if quote_reward > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.quote_reserve.to_account_info(),
                        to: ctx.accounts.keeper_quote.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[seeds],
                ),
                quote_reward,
            )?;
        }
        let vault = &mut ctx.accounts.vault;
        vault.keeper_base = vault.keeper_base.saturating_sub(base_reward);
        vault.keeper_quote = vault.keeper_quote.saturating_sub(quote_reward);
        let reward = &mut ctx.accounts.keeper_reward;
        reward.base = reward.base.saturating_sub(base_reward);
        reward.quote = reward.quote.saturating_sub(quote_reward);
        emit!(RewardClaimed {
            keeper: ctx.accounts.keeper.key(),
            base: base_reward,
            quote: quote_reward
        });
        Ok(())
    }

    /// Item 5: admin proposes a timelocked claim of the insurance or protocol
    /// fee bucket. Nothing moves yet; `execute_fee_claim` releases it only after
    /// `TIMELOCK_SLOTS` and only to the fixed `config.treasury`.
    pub fn propose_fee_claim(ctx: Context<ProposeFeeClaim>, kind: FeeKind) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.vault.admin,
            ErrorCode::Unauthorized
        );
        // Item 1c: the insurance bucket is NOT claimable to the treasury. It is
        // the loss buffer; only protocol fees may be withdrawn. (A separate
        // governance rule for using the buffer to compensate LPs is design-only;
        // see docs/SECURITY_CHECKLIST.md.)
        require!(kind == FeeKind::Protocol, ErrorCode::InsuranceNotClaimable);
        let now = Clock::get()?.slot;
        let pending = &mut ctx.accounts.pending_claim;
        pending.admin = ctx.accounts.admin.key();
        pending.kind = kind;
        pending.activate_slot = now.saturating_add(TIMELOCK_SLOTS);
        pending.bump = ctx.bumps.pending_claim;
        emit!(FeeClaimProposed {
            slot: now,
            activate_slot: pending.activate_slot
        });
        Ok(())
    }

    /// Item 5: releases a previously proposed fee claim once the timelock
    /// elapsed. Moves **only** the requested LP-excluded bucket, and only to the
    /// fixed `config.treasury` token accounts. LP reserves are never touched.
    pub fn execute_fee_claim(ctx: Context<ExecuteFeeClaim>) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.vault.admin
                && ctx.accounts.pending_claim.admin == ctx.accounts.admin.key(),
            ErrorCode::Unauthorized
        );
        require!(
            Clock::get()?.slot >= ctx.accounts.pending_claim.activate_slot,
            ErrorCode::TimelockNotElapsed
        );
        let (base_amt, quote_amt) = match ctx.accounts.pending_claim.kind {
            FeeKind::Insurance => (
                ctx.accounts.vault.insurance_base,
                ctx.accounts.vault.insurance_quote,
            ),
            FeeKind::Protocol => (
                ctx.accounts.vault.protocol_base,
                ctx.accounts.vault.protocol_quote,
            ),
        };
        require!(base_amt > 0 || quote_amt > 0, ErrorCode::InvalidAmount);
        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[
            b"vault",
            ctx.accounts.vault.base_mint.as_ref(),
            ctx.accounts.vault.quote_mint.as_ref(),
            &bump,
        ];
        if base_amt > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.base_reserve.to_account_info(),
                        to: ctx.accounts.treasury_base.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[seeds],
                ),
                base_amt,
            )?;
        }
        if quote_amt > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.quote_reserve.to_account_info(),
                        to: ctx.accounts.treasury_quote.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[seeds],
                ),
                quote_amt,
            )?;
        }
        match ctx.accounts.pending_claim.kind {
            FeeKind::Insurance => {
                ctx.accounts.vault.insurance_base = 0;
                ctx.accounts.vault.insurance_quote = 0;
            }
            FeeKind::Protocol => {
                ctx.accounts.vault.protocol_base = 0;
                ctx.accounts.vault.protocol_quote = 0;
            }
        }
        // Consume the proposal so it cannot be replayed.
        ctx.accounts.pending_claim.activate_slot = u64::MAX;
        emit!(FeeClaimed {
            slot: Clock::get()?.slot,
            kind: ctx.accounts.pending_claim.kind,
            base_amount: base_amt,
            quote_amount: quote_amt
        });
        Ok(())
    }
}

/// The only oracle-independent keeper authorization rule, shared by every
/// quote-writing instruction. The MVP allowlist is used when `min_bond == 0`;
/// otherwise the keeper must hold a bonded PDA meeting the configured minimum
/// (net of any pending unbond).
fn require_keeper_authorized(
    config: &Config,
    keeper: &Pubkey,
    vault_key: &Pubkey,
    keeper_bond: &AccountInfo,
) -> Result<()> {
    if config.min_bond == 0 {
        // S2-19: with no bond threshold, quote maintenance is permissionless.
        // The on-chain quote validation is the authorization; there is no
        // allowlist. Any valid signer whose quote passes the same checks may
        // stage/commit. (This replaces the former `keeper == config.keeper`
        // equality gate.)
        return Ok(());
    }
    let (expected, _) = Pubkey::find_program_address(
        &[b"keeper", vault_key.as_ref(), keeper.as_ref()],
        &crate::ID,
    );
    require!(keeper_bond.key() == expected, ErrorCode::NotBonded);
    let data = keeper_bond
        .try_borrow_data()
        .map_err(|_| error!(ErrorCode::NotBonded))?;
    let bond =
        KeeperBond::try_deserialize(&mut &data[..]).map_err(|_| error!(ErrorCode::NotBonded))?;
    require!(
        bond.keeper == *keeper && bond.bond.saturating_sub(bond.unbond_amount) >= config.min_bond,
        ErrorCode::NotBonded
    );
    Ok(())
}

/// Shared oracle + ladder + inventory + capacity validation for a quote payload.
///
/// This is the single, authoritative body used by both `update_quote` and
/// `commit_quote`; it returns the verified, normalized oracle price (Q64) the
/// ladder was bound against. Any failure rejects the quote.
/// S2-18: true when the committed quote is eligible for a step-guard-free
/// re-anchor. It is derived purely from the on-chain clock and committed state
/// (never caller input): no prior quote exists, the stored quote is expired at
/// the current slot, or its stored oracle publish time is older than
/// `max_staleness_seconds`. While the quote is live this returns false, so a
/// keeper cannot request recovery early to evade the normal step guard.
fn quote_reanchor_eligible(config: &Config, quote_state: &QuoteState, clock: &Clock) -> bool {
    if quote_state.version == 0 || quote_state.anchor_sqrt_price == 0 {
        return true;
    }
    if clock.slot >= quote_state.expiry_slot {
        return true;
    }
    config.max_staleness_seconds > 0
        && quote_state.oracle_publish_time > 0
        && clock
            .unix_timestamp
            .saturating_sub(quote_state.oracle_publish_time)
            > config.max_staleness_seconds
}

#[allow(clippy::too_many_arguments)]
fn validate_quote_update(
    config: &Config,
    quote_state: &QuoteState,
    update: &QuoteUpdate,
    price_update: &PriceUpdateV2,
    base_reserve_amount: u64,
    quote_reserve_amount: u64,
    vault: &Vault,
    base_decimals: u8,
    quote_decimals: u8,
    clock: &Clock,
) -> Result<u128> {
    require!(update.oracle_publish_time >= 0, ErrorCode::InvalidPrice);
    let feed = config.pyth_feed_id;
    require!(config.max_staleness_seconds >= 0, ErrorCode::InvalidOracle);
    let price = price_update
        .get_price_no_older_than(clock, config.max_staleness_seconds as u64, &feed)
        .map_err(|_| error!(ErrorCode::InvalidOracle))?;
    require!(
        price.price > 0 && price.publish_time == update.oracle_publish_time,
        ErrorCode::InvalidOracle
    );
    let pyth_price_q64 =
        pyth_price_q64(price.price, price.exponent).ok_or(ErrorCode::InvalidOracle)?;
    // B1: the executable token-unit price is derived here from the verified
    // Pyth value and the vault's own (address-bound) mint decimals. The
    // keeper must submit exactly this normalized value; it cannot choose an
    // arbitrary scaling that merely passes the comparison.
    let expected_oracle_price =
        normalize_pyth_price_q64(pyth_price_q64, base_decimals, quote_decimals)
            .ok_or(ErrorCode::InvalidOracle)?;
    // S2-9: `oracle_price` is no longer in the payload — it was fully
    // determined by the verified Pyth value and the mint decimals, and the
    // program now uses its own normalized value directly (strictly stronger
    // than trusting a keeper-supplied field that had to equal it anyway).
    let oracle_price = expected_oracle_price;
    require!(oracle_price > 0, ErrorCode::InvalidPrice);
    let decoded_conf_bps = ((price.conf as u128)
        .saturating_mul(10_000)
        .saturating_add(price.price as u128 - 1)
        / price.price as u128) as u32;
    require!(
        decoded_conf_bps <= config.max_conf_bps && update.oracle_conf_bps == decoded_conf_bps,
        ErrorCode::WideConfidence
    );
    require!(
        update.half_spread_bps >= config.min_spread_bps
            && update.half_spread_bps <= config.max_spread_bps,
        ErrorCode::SpreadOutOfBounds
    );
    // Honest-execution §7.3: bound the per-update spread *step* (not only the
    // absolute band) so a keeper cannot jump the spread in a single update.
    // `0` disables the step guard (used by tests and the permissive default).
    if quote_state.version > 0 && config.max_spread_step_bps > 0 {
        let spread_step = update.half_spread_bps.abs_diff(quote_state.half_spread_bps);
        require!(
            spread_step <= config.max_spread_step_bps,
            ErrorCode::SpreadStepTooLarge
        );
    }
    // S2-18: the per-update anchor step bound applies only while the committed
    // quote is still live. Once it is genuinely expired or its stored oracle is
    // stale, a keeper may re-anchor directly to the verified Pyth price; the
    // oracle-deviation bound below (and every other check) still applies. This
    // removes the deadlock that could otherwise occur when a market gap exceeds
    // `step + dev` while the keeper was offline, without weakening the normal
    // path or allowing an early bypass, and without touching any quote math.
    if !quote_reanchor_eligible(config, quote_state, clock) && quote_state.anchor_sqrt_price > 0 {
        let old = quote_state.anchor_sqrt_price;
        let diff = update.anchor_sqrt_price.abs_diff(old);
        require!(
            diff.saturating_mul(10_000) <= old.saturating_mul(config.max_anchor_step_bps as u128),
            ErrorCode::AnchorStepTooLarge
        );
    }
    require!(
        update.weights_bps.iter().map(|v| *v as u64).sum::<u64>() == 10_000,
        ErrorCode::InvalidWeights
    );
    require!(
        update.offsets_bps.windows(2).all(|w| w[0] < w[1]),
        ErrorCode::InvalidLadder
    );
    require!(
        update
            .ask_levels
            .iter()
            .chain(update.bid_levels.iter())
            .all(|l| l.sqrt_lo > 0 && l.sqrt_lo < l.sqrt_hi && l.liquidity > 0),
        ErrorCode::InvalidLadder
    );
    // F-04: bind the executed ladder to the oracle anchor so a compromised
    // or buggy keeper cannot quote arbitrarily bad prices. Every level's
    // implied price must lie inside the anchor widened by the declared
    // spread, the directional add-on and the outermost offset, and the
    // reservation must stay within `max_inventory_bps` of the anchor.
    require!(
        update.offsets_bps[LEVELS - 1] <= MAX_LEVEL_OFFSET_BPS,
        ErrorCode::InvalidLadder
    );
    let anchor_price =
        arb_math::price_from_sqrt(update.anchor_sqrt_price).map_err(|_| ErrorCode::InvalidPrice)?;
    require!(anchor_price > 0, ErrorCode::InvalidPrice);
    // Item 2: bind the anchor to the **verified** Pyth price, not only to the
    // previous anchor. `update.oracle_price` is the Q64 price already proven
    // == the Pyth payload above. Without this, a keeper could (over steps, or
    // on the first update where the previous anchor is 0) quote far from the
    // oracle. `max_anchor_dev_bps` is the max |anchor - oracle|/oracle.
    //
    // Item 1b worst-case loss bound. A keeper that posts an anchor `d`
    // (fraction) away from the oracle exposes the ladder depth, capped at
    // `u = utilization_max` of reserves, to a pick-off worth ~`d`:
    //     loss_per_update <= u * d * V          (V = vault value)
    // With u = 0.5 and the recommended default d = 100 bps:
    //     loss_per_update <= 0.5 * 0.01 * V = 0.005 V   (0.5% of V per update)
    // and the per-window loss is additionally bounded by the flow cap (1a).
    // `oracle_price` (the verified, normalized Q64 token-unit price) is
    // bound above from the Pyth account; no payload field is trusted here.
    let anchor_dev = anchor_price.abs_diff(oracle_price);
    require!(
        anchor_dev.saturating_mul(BPS_DENOM as u128)
            <= oracle_price.saturating_mul(config.max_anchor_dev_bps as u128),
        ErrorCode::AnchorTooFarFromOracle
    );
    let outer = update.offsets_bps[LEVELS - 1];
    let ask_band = update
        .half_spread_bps
        .saturating_add(update.ask_extra_bps)
        .saturating_add(outer)
        .min(MAX_LEVEL_OFFSET_BPS);
    let bid_band = update
        .half_spread_bps
        .saturating_add(update.bid_extra_bps)
        .saturating_add(outer)
        .min(MAX_LEVEL_OFFSET_BPS);
    let reservation =
        arb_math::price_from_sqrt(update.p_res_sqrt).map_err(|_| ErrorCode::InvalidPrice)?;
    // The reservation is itself bounded to the verified anchor band, so
    // binding the ladder to the reservation (the ladder's true centre, per
    // spec §5.7) still bounds every level relative to the oracle through
    // `max_inventory_bps`. This is required for a two-sided ladder: a bid
    // level can sit below the anchor whenever the reservation is skewed down.
    let inventory = config.max_inventory_bps.min(BPS_DENOM - 1);
    let res_upper = arb_math::mul_div_ceil(
        anchor_price,
        (BPS_DENOM + inventory) as u128,
        BPS_DENOM as u128,
    )
    .ok_or(ErrorCode::MathOverflow)?;
    let res_lower = arb_math::mul_div_floor(
        anchor_price,
        (BPS_DENOM - inventory) as u128,
        BPS_DENOM as u128,
    )
    .ok_or(ErrorCode::MathOverflow)?;
    require!(
        reservation <= res_upper && reservation >= res_lower,
        ErrorCode::InventoryOutOfBounds
    );
    let upper = arb_math::mul_div_ceil(
        reservation,
        (BPS_DENOM + ask_band) as u128,
        BPS_DENOM as u128,
    )
    .ok_or(ErrorCode::MathOverflow)?;
    let lower = arb_math::mul_div_floor(
        reservation,
        (BPS_DENOM - bid_band.min(BPS_DENOM - 1)) as u128,
        BPS_DENOM as u128,
    )
    .ok_or(ErrorCode::MathOverflow)?;
    // 0.01 bps of slack absorbs the `sqrt_q64`/`price_from_sqrt` round-trip
    // (a few ulps) so an exactly-at-the-edge level is not spuriously
    // rejected. It is far below the 1 bps parameter granularity and does not
    // materially widen the band.
    let band_epsilon = reservation / 1_000_000;
    for level in update.ask_levels.iter().chain(update.bid_levels.iter()) {
        let lo = arb_math::price_from_sqrt(level.sqrt_lo).map_err(|_| ErrorCode::InvalidPrice)?;
        let hi = arb_math::price_from_sqrt(level.sqrt_hi).map_err(|_| ErrorCode::InvalidPrice)?;
        require!(
            lo.saturating_add(band_epsilon) >= lower && hi <= upper.saturating_add(band_epsilon),
            ErrorCode::LevelOutOfBounds
        );
    }
    // p2-T3 / P2-F03 / h1: bound the quoted depth to the *available* reserves
    // so a compromised keeper cannot publish phantom depth. The **ask** side
    // pays out base, so its base capacity is bounded by the available base;
    // the **bid** side pays out quote, so its quote capacity is bounded by
    // the available quote. Capacity uses the same floor rounding as
    // `arb-math`; the fee buckets are liabilities and are excluded.
    let mut ask_base_capacity = 0u128;
    for level in update.ask_levels.iter() {
        // S2-9: the ask base capacity is computed on-chain from the level's
        // liquidity and sqrt bounds (the same U256 division the bid side
        // already uses), so the payload no longer carries keeper-supplied
        // inverse square roots. Exact floor; the utilization cap can only
        // reject, never wrongly accept.
        let math_level = MathLevel {
            sqrt_lo: level.sqrt_lo,
            sqrt_hi: level.sqrt_hi,
            liquidity: level.liquidity,
        };
        ask_base_capacity = ask_base_capacity
            .checked_add(
                math_level
                    .base_capacity()
                    .map_err(|_| error!(ErrorCode::MathOverflow))?,
            )
            .ok_or(ErrorCode::MathOverflow)?;
    }
    let mut bid_quote_capacity = 0u128;
    for level in update.bid_levels.iter() {
        let math_level = MathLevel {
            sqrt_lo: level.sqrt_lo,
            sqrt_hi: level.sqrt_hi,
            liquidity: level.liquidity,
        };
        bid_quote_capacity = bid_quote_capacity
            .checked_add(
                math_level
                    .quote_capacity()
                    .map_err(|_| error!(ErrorCode::MathOverflow))?,
            )
            .ok_or(ErrorCode::MathOverflow)?;
    }
    let available_base = base_reserve_amount
        .saturating_sub(vault.insurance_base)
        .saturating_sub(vault.keeper_base)
        .saturating_sub(vault.protocol_base) as u128;
    let available_quote = quote_reserve_amount
        .saturating_sub(vault.insurance_quote)
        .saturating_sub(vault.keeper_quote)
        .saturating_sub(vault.protocol_quote) as u128;
    let utilization = config.utilization_max_bps as u128;
    require!(
        ask_base_capacity.saturating_mul(BPS_DENOM as u128)
            <= available_base.saturating_mul(utilization),
        ErrorCode::UtilizationExceeded
    );
    require!(
        bid_quote_capacity.saturating_mul(BPS_DENOM as u128)
            <= available_quote.saturating_mul(utilization),
        ErrorCode::UtilizationExceeded
    );
    Ok(oracle_price)
}

/// Apply an already-validated quote to the active `QuoteState`: bumps the
/// version, resets the flow accumulator, stores the ladder and emits the event.
fn apply_quote_update(
    quote_state: &mut QuoteState,
    config: &Config,
    update: &QuoteUpdate,
    oracle_price: u128,
    clock: &Clock,
) -> Result<u64> {
    let quote = quote_state;
    quote.version = quote
        .version
        .checked_add(1)
        .ok_or(ErrorCode::MathOverflow)?;
    let version = quote.version;
    quote.update_slot = update.update_slot;
    // Spec §5.9: the flow accumulator resets on every quote update.
    quote.flow_n = 0;
    quote.expiry_slot = clock
        .slot
        .checked_add(config.expiry_slots)
        .ok_or(ErrorCode::MathOverflow)?;
    quote.anchor_sqrt_price = update.anchor_sqrt_price;
    quote.p_res_sqrt = update.p_res_sqrt;
    quote.half_spread_bps = update.half_spread_bps;
    quote.ask_extra_bps = update.ask_extra_bps;
    quote.bid_extra_bps = update.bid_extra_bps;
    quote.depth_mult_bps = update.depth_mult_bps.min(10_000);
    quote.oracle_publish_time = update.oracle_publish_time;
    quote.oracle_conf_bps = update.oracle_conf_bps;
    // h3: store the verified oracle for the swap-time edge measurement. The
    // realized-edge window is rolled by the slot clock at swap time, NOT on
    // every re-quote (so re-quoting cannot reset the loss tracker).
    quote.oracle_price = oracle_price;
    for i in 0..LEVELS {
        quote.ask_levels[i] = Level {
            sqrt_lo: update.ask_levels[i].sqrt_lo,
            sqrt_hi: update.ask_levels[i].sqrt_hi,
            liquidity: update.ask_levels[i].liquidity,
            offset_bps: update.offsets_bps[i],
            weight_bps: update.weights_bps[i],
        };
        quote.bid_levels[i] = Level {
            sqrt_lo: update.bid_levels[i].sqrt_lo,
            sqrt_hi: update.bid_levels[i].sqrt_hi,
            liquidity: update.bid_levels[i].liquidity,
            offset_bps: update.offsets_bps[i],
            weight_bps: update.weights_bps[i],
        };
    }
    emit!(QuoteUpdated {
        slot: clock.slot,
        version,
        anchor_sqrt_price: update.anchor_sqrt_price,
        depth_mult_bps: update.depth_mult_bps.min(10_000)
    });
    Ok(version)
}

/// S2-19: bind a committed quote's authoring keeper. Kept as a small helper so
/// both the direct and staged update paths set it identically.
fn set_quote_author(quote_state: &mut QuoteState, keeper: Pubkey) {
    quote_state.keeper = keeper;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct ParamsUpdate {
    pub fee_bps: u16,
    pub insurance_bps: u16,
    pub keeper_bps: u16,
    pub protocol_bps: u16,
    pub max_staleness_seconds: i64,
    pub max_conf_bps: u32,
    pub max_anchor_step_bps: u32,
    /// Spec §7.3: max change in `half_spread_bps` per update (step guard).
    pub max_spread_step_bps: u32,
    pub min_spread_bps: u32,
    pub max_spread_bps: u32,
    pub max_quote_size: u64,
    pub max_inventory_bps: u32,
    pub utilization_max_bps: u32,
    /// S2-19: `min_bond` is NOT tunable. Keeper-eligibility policy is fixed at
    /// vault initialization so an administrator can never re-introduce a
    /// single-wallet allowlist or an exclusionary bond threshold after the fact.
    /// (The `min_bond` and `keeper` fields were removed from this struct.)
    /// p2-T5: cooldown before a keeper's unbond releases (slots).
    pub unbond_cooldown_slots: u64,
    /// p2-T8: max age (slots) of the stored `update_slot` at update time.
    pub max_update_slot_age: u32,
    /// h3: realized-edge loss window (slots) and threshold (bps of available value).
    pub edge_window_slots: u64,
    pub max_edge_loss_bps: u32,
    /// Max |anchor - oracle| / oracle in bps (Item 2).
    pub max_anchor_dev_bps: u32,
    /// Item 1a: cumulative one-sided flow window, in slots.
    pub flow_window_slots: u64,
    /// Item 1a: max one-sided base flow per window, in bps of base reserve.
    pub max_window_flow_bps: u32,
    /// S2-37: committed-quote validity window (slots). Bounded by
    /// `MAX_EXPIRY_SLOTS` and required to exceed `grace_slots`.
    pub expiry_slots: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct InitParams {
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub keeper: Pubkey,
    /// Item 5: fixed destination for timelocked fee claims.
    pub treasury: Pubkey,
    pub pyth_feed_id: [u8; 32],
    pub fee_bps: u16,
    pub insurance_bps: u16,
    pub keeper_bps: u16,
    pub protocol_bps: u16,
    pub min_liquidity: u64,
    pub warmup_slots: u64,
    pub epoch_slots: u64,
    pub grace_slots: u64,
    pub expiry_slots: u64,
    pub max_staleness_seconds: i64,
    pub max_conf_bps: u32,
    pub max_anchor_step_bps: u32,
    /// Spec §7.3: max change in `half_spread_bps` per update (step guard).
    pub max_spread_step_bps: u32,
    pub min_spread_bps: u32,
    pub max_spread_bps: u32,
    pub max_quote_size: u64,
    pub max_inventory_bps: u32,
    pub utilization_max_bps: u32,
    pub min_bond: u64,
    pub unbond_cooldown_slots: u64,
    /// p2-T8: max age (slots) of the stored `update_slot` at update time.
    pub max_update_slot_age: u32,
    /// h3: realized-edge loss window (slots) and threshold (bps of available value).
    pub edge_window_slots: u64,
    pub max_edge_loss_bps: u32,
    pub max_anchor_dev_bps: u32,
    pub flow_window_slots: u64,
    pub max_window_flow_bps: u32,
    pub offsets_bps: [u32; LEVELS],
    pub weights_bps: [u32; LEVELS],
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct LevelUpdate {
    pub sqrt_lo: u128,
    pub sqrt_hi: u128,
    pub liquidity: u128,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct QuoteUpdate {
    pub update_slot: u64,
    pub oracle_publish_time: i64,
    pub oracle_conf_bps: u32,
    pub anchor_sqrt_price: u128,
    pub p_res_sqrt: u128,
    pub half_spread_bps: u32,
    pub ask_extra_bps: u32,
    pub bid_extra_bps: u32,
    pub depth_mult_bps: u32,
    pub offsets_bps: [u32; LEVELS],
    pub weights_bps: [u32; LEVELS],
    pub ask_levels: [LevelUpdate; LEVELS],
    pub bid_levels: [LevelUpdate; LEVELS],
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum SwapSide {
    BuyBase,
    SellBase,
}

/// Item 5: the LP-excluded fee bucket a timelocked treasury claim targets.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum FeeKind {
    Insurance,
    Protocol,
}

#[account]
pub struct Vault {
    pub admin: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_reserve: Pubkey,
    pub quote_reserve: Pubkey,
    pub share_mint: Pubkey,
    pub share_lock: Pubkey,
    pub total_shares: u64,
    pub insurance_base: u64,
    pub insurance_quote: u64,
    pub keeper_base: u64,
    pub keeper_quote: u64,
    pub protocol_base: u64,
    pub protocol_quote: u64,
    pub epoch: u64,
    pub epoch_start: u64,
    pub status: u8,
    pub bump: u8,
}
#[account]
pub struct Config {
    pub admin: Pubkey,
    pub keeper: Pubkey,
    /// Item 5: the fixed destination for timelocked fee claims. Set once at
    /// init; a claim can only ever send insurance/protocol fees here.
    pub treasury: Pubkey,
    pub pyth_feed_id: [u8; 32],
    pub fee_bps: u16,
    pub insurance_bps: u16,
    pub keeper_bps: u16,
    pub protocol_bps: u16,
    pub min_liquidity: u64,
    pub warmup_slots: u64,
    pub epoch_slots: u64,
    pub grace_slots: u64,
    pub expiry_slots: u64,
    pub max_staleness_seconds: i64,
    pub max_conf_bps: u32,
    pub max_anchor_step_bps: u32,
    /// Spec §7.3: max change in `half_spread_bps` per update (step guard).
    pub max_spread_step_bps: u32,
    pub min_spread_bps: u32,
    pub max_spread_bps: u32,
    pub max_quote_size: u64,
    pub max_inventory_bps: u32,
    pub utilization_max_bps: u32,
    pub min_bond: u64,
    pub unbond_cooldown_slots: u64,
    /// p2-T8: max age (slots) of the stored `update_slot` at update time.
    pub max_update_slot_age: u32,
    /// h3: realized-edge loss window (slots) and threshold (bps of available value).
    pub edge_window_slots: u64,
    pub max_edge_loss_bps: u32,
    pub max_anchor_dev_bps: u32,
    /// Item 1a: flow window length (slots) and one-sided cap (bps of base reserve).
    pub flow_window_slots: u64,
    pub max_window_flow_bps: u32,
    /// B4: timelocked admin rotation. `pending_admin` is the proposed successor
    /// (default = none); it must sign `accept_admin` after `admin_activate_slot`.
    pub pending_admin: Pubkey,
    pub admin_activate_slot: u64,
    pub bump: u8,
}
/// Pending timelocked parameter change (F-17), seeded `[b"pending", vault]`.
#[account]
pub struct PendingConfig {
    pub admin: Pubkey,
    pub activate_slot: u64,
    pub params: ParamsUpdate,
    pub bump: u8,
}
/// Item 5: a pending timelocked treasury fee claim, seeded `[b"claim", vault]`.
#[account]
pub struct PendingClaim {
    pub admin: Pubkey,
    pub kind: FeeKind,
    pub activate_slot: u64,
    pub bump: u8,
}
/// Singleton program admin, seeded `[b"program"]` (set once at deploy).
#[account]
pub struct ProgramConfig {
    pub admin: Pubkey,
    pub bump: u8,
}
/// Keeper bond (T3.4), seeded `[b"keeper", vault, keeper]`.
#[account]
pub struct KeeperBond {
    pub keeper: Pubkey,
    pub bond: u64,
    pub slashed: u64,
    /// p2-T5: amount queued for release by `unbond_keeper`, and the slot it
    /// becomes releasable. `unbond_ready_slot == 0` means no unbond is pending.
    pub unbond_amount: u64,
    pub unbond_ready_slot: u64,
    pub bump: u8,
}
#[account]
pub struct QuoteState {
    pub version: u64,
    pub update_slot: u64,
    pub expiry_slot: u64,
    pub anchor_sqrt_price: u128,
    pub p_res_sqrt: u128,
    pub half_spread_bps: u32,
    pub ask_extra_bps: u32,
    pub bid_extra_bps: u32,
    /// Indexer hint only: the keeper's depth throttle for this quote. The
    /// on-chain depth control is the per-level `liquidity` plus the
    /// `utilization_max_bps` capacity bound, not this field (p2-T8).
    pub depth_mult_bps: u32,
    /// Item 1a: cumulative one-sided base flow within the current window.
    pub window_start_slot: u64,
    pub window_base_sold: u64,
    pub window_base_bought: u64,
    pub oracle_publish_time: i64,
    pub oracle_conf_bps: u32,
    /// h3: the verified oracle price (Q64) stored at `update_quote`; the swap
    /// measures the vault's realized execution edge against it.
    pub oracle_price: u128,
    /// h3: rolling realized-edge tracker (quote atoms; positive = vault gained).
    pub edge_window_start_slot: u64,
    pub realized_edge: i128,
    /// Spec §5.9: signed net base sold since the last `update_quote`
    /// (positive = the vault sold base on net); reset to 0 on every update.
    pub flow_n: i128,
    pub ask_levels: [Level; LEVELS],
    pub bid_levels: [Level; LEVELS],
    pub bump: u8,
    /// S2-19: the keeper that authored the currently committed quote. Appended
    /// (additive, migration-only) so existing field offsets are preserved. It
    /// binds the keeper fee share to the quote version that a swap consumes.
    pub keeper: Pubkey,
}

/// S2-21A: exact serialization of the pre-S2-19 `QuoteState` (no appended
/// `keeper`). Plain `AnchorSerialize/Deserialize` (no `#[account]`), so it
/// carries no discriminator; `migrate_quote_state` verifies the `QuoteState`
/// discriminator and deserializes this struct from the body.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct LegacyQuoteState {
    pub version: u64,
    pub update_slot: u64,
    pub expiry_slot: u64,
    pub anchor_sqrt_price: u128,
    pub p_res_sqrt: u128,
    pub half_spread_bps: u32,
    pub ask_extra_bps: u32,
    pub bid_extra_bps: u32,
    pub depth_mult_bps: u32,
    pub window_start_slot: u64,
    pub window_base_sold: u64,
    pub window_base_bought: u64,
    pub oracle_publish_time: i64,
    pub oracle_conf_bps: u32,
    pub oracle_price: u128,
    pub edge_window_start_slot: u64,
    pub realized_edge: i128,
    pub flow_n: i128,
    pub ask_levels: [Level; LEVELS],
    pub bid_levels: [Level; LEVELS],
    pub bump: u8,
}

impl LegacyQuoteState {
    /// Promote to the current layout, preserving every legacy field and setting
    /// the appended `keeper` to the unattributed sentinel. A legacy quote has no
    /// verified author, so it is never attributed to `config.keeper`.
    fn into_current(self) -> QuoteState {
        QuoteState {
            version: self.version,
            update_slot: self.update_slot,
            expiry_slot: self.expiry_slot,
            anchor_sqrt_price: self.anchor_sqrt_price,
            p_res_sqrt: self.p_res_sqrt,
            half_spread_bps: self.half_spread_bps,
            ask_extra_bps: self.ask_extra_bps,
            bid_extra_bps: self.bid_extra_bps,
            depth_mult_bps: self.depth_mult_bps,
            window_start_slot: self.window_start_slot,
            window_base_sold: self.window_base_sold,
            window_base_bought: self.window_base_bought,
            oracle_publish_time: self.oracle_publish_time,
            oracle_conf_bps: self.oracle_conf_bps,
            oracle_price: self.oracle_price,
            edge_window_start_slot: self.edge_window_start_slot,
            realized_edge: self.realized_edge,
            flow_n: self.flow_n,
            ask_levels: self.ask_levels,
            bid_levels: self.bid_levels,
            bump: self.bump,
            keeper: Pubkey::default(),
        }
    }
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct Level {
    pub offset_bps: u32,
    pub weight_bps: u32,
    pub sqrt_lo: u128,
    pub sqrt_hi: u128,
    pub liquidity: u128,
}
/// S2-11: a staged quote bound to the canonical vault and authorized keeper,
/// seeded `[b"pending_quote", vault, keeper]`. It never affects the active
/// `QuoteState` until `commit_quote` succeeds in the same transaction as the
/// fresh Pyth price update.
#[account]
pub struct PendingQuote {
    pub vault: Pubkey,
    pub keeper: Pubkey,
    /// Monotonic staged nonce; must exceed `committed_nonce`.
    pub nonce: u64,
    /// Highest nonce ever committed; makes a committed payload unreplayable.
    pub committed_nonce: u64,
    /// 1 while a payload is staged and unconsumed.
    pub pending: u8,
    pub stage_slot: u64,
    /// Snapshots of quote-relevant state at staging time (change detection).
    pub base_reserve_at_stage: u64,
    pub quote_reserve_at_stage: u64,
    pub insurance_base: u64,
    pub insurance_quote: u64,
    pub keeper_base: u64,
    pub keeper_quote: u64,
    pub protocol_base: u64,
    pub protocol_quote: u64,
    pub quote_version_at_stage: u64,
    pub quote_update_slot_at_stage: u64,
    pub bump: u8,
    pub update: QuoteUpdate,
}
/// S2-19: per-keeper claimable reward. Credited at swap time to the author of
/// the quote used by that swap (the keeper recorded in `QuoteState.keeper`).
/// Bookkeeping only — the tokens stay in the vault reserves exactly as before
/// and move only at claim, so the fee split and reserve accounting are
/// unchanged.
#[account]
pub struct KeeperReward {
    pub keeper: Pubkey,
    pub base: u64,
    pub quote: u64,
    pub bump: u8,
}
#[account]
pub struct DepositTicket {
    pub owner: Pubkey,
    pub shares: u64,
    pub activate_slot: u64,
    pub bump: u8,
}
#[account]
pub struct WithdrawTicket {
    pub owner: Pubkey,
    pub shares: u64,
    pub epoch: u64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(params: InitParams)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds=[b"program"], bump = program_config.bump)]
    pub program_config: Account<'info, ProgramConfig>,
    #[account(seeds = [b"vault", params.base_mint.as_ref(), params.quote_mint.as_ref()], bump, init, payer = admin, space = 8 + 32*7 + 8*9 + 2)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds = [b"config", vault.key().as_ref()], bump, init, payer = admin, space = 8 + 32*4 + 2*4 + 8*8 + 4*6 + 8 + 4 + 1 + 4 + 4 + 8 + 4 + 8 + 4 + 32 + 8 + 4)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"quote", vault.key().as_ref()], bump, init, payer = admin, space = 8 + 8*6 + 16*2 + 4*5 + 16 + 8 + 4 + 16 + 8 + 16 + (4+4+16+16+16)*LEVELS + (4+4+16+16+16)*LEVELS + 1 + 16 + 32)]
    pub quote_state: Box<Account<'info, QuoteState>>,
    #[account(address = params.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = params.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = admin, token::mint = base_mint, token::authority = vault)]
    pub base_reserve: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = admin, token::mint = quote_mint, token::authority = vault)]
    pub quote_reserve: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = admin, mint::decimals = 9, mint::authority = vault)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = admin, token::mint = share_mint, token::authority = vault)]
    pub share_lock: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds=[b"config", vault.key().as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, address = vault.base_reserve)]
    pub base_reserve: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = vault.quote_reserve)]
    pub quote_reserve: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = vault.share_mint)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = vault.share_lock)]
    pub share_lock: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_base.mint == vault.base_mint, constraint = user_base.owner == user.key())]
    pub user_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_quote.mint == vault.quote_mint, constraint = user_quote.owner == user.key())]
    pub user_quote: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_shares.mint == vault.share_mint, constraint = user_shares.owner == user.key())]
    pub user_shares: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer=user, space=8+32+8+8+1, seeds=[b"dep", vault.key().as_ref(), user.key().as_ref()], bump)]
    pub deposit_ticket: Account<'info, DepositTicket>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
impl<'info> Deposit<'info> {
    fn base_transfer_ctx(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.key(),
            Transfer {
                from: self.user_base.to_account_info(),
                to: self.base_reserve.to_account_info(),
                authority: self.user.to_account_info(),
            },
        )
    }
    fn quote_transfer_ctx(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.key(),
            Transfer {
                from: self.user_quote.to_account_info(),
                to: self.quote_reserve.to_account_info(),
                authority: self.user.to_account_info(),
            },
        )
    }
}

#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address=vault.share_lock)]
    pub share_lock: Box<Account<'info, TokenAccount>>,
    #[account(seeds=[b"dep",vault.key().as_ref(),user.key().as_ref()],bump=deposit_ticket.bump)]
    pub deposit_ticket: Box<Account<'info, DepositTicket>>,
    #[account(mut, constraint=user_shares.owner==user.key(), constraint=user_shares.mint==vault.share_mint)]
    pub user_shares: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer=user, space=8+32+8+8+1, seeds=[b"wd", vault.key().as_ref(), user.key().as_ref()], bump)]
    pub withdraw_ticket: Box<Account<'info, WithdrawTicket>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
impl<'info> RequestWithdraw<'info> {
    fn queue_transfer_ctx(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.key(),
            Transfer {
                from: self.user_shares.to_account_info(),
                to: self.share_lock.to_account_info(),
                authority: self.user.to_account_info(),
            },
        )
    }
}

#[derive(Accounts)]
pub struct CrankEpoch<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    #[account(seeds=[b"config",vault.key().as_ref()],bump=config.bump)]
    pub config: Account<'info, Config>,
}
#[derive(Accounts)]
pub struct ClaimWithdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address=vault.base_reserve)]
    pub base_reserve: Box<Account<'info, TokenAccount>>,
    #[account(mut,address=vault.quote_reserve)]
    pub quote_reserve: Box<Account<'info, TokenAccount>>,
    #[account(mut,address=vault.share_mint)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut,address=vault.share_lock)]
    pub share_lock: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds=[b"wd", vault.key().as_ref(), user.key().as_ref()],
        bump=withdraw_ticket.bump,
        constraint=withdraw_ticket.owner==user.key()
    )]
    pub withdraw_ticket: Box<Account<'info, WithdrawTicket>>,
    #[account(mut,constraint=user_base.owner==user.key(),constraint=user_base.mint==vault.base_mint)]
    pub user_base: Box<Account<'info, TokenAccount>>,
    #[account(mut,constraint=user_quote.owner==user.key(),constraint=user_quote.mint==vault.quote_mint)]
    pub user_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateQuote<'info> {
    pub keeper: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds=[b"config",vault.key().as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut,seeds=[b"quote",vault.key().as_ref()],bump=quote_state.bump)]
    pub quote_state: Box<Account<'info, QuoteState>>,
    pub price_update: Box<Account<'info, PriceUpdateV2>>,
    /// CHECK: the keeper bond PDA. The context does **not** validate it (no
    /// `seeds`), so the MVP allowlist path pays no PDA-derivation CU; the body
    /// checks the PDA and the bonded amount only when `min_bond > 0`.
    pub keeper_bond: UncheckedAccount<'info>,
    /// The vault's token reserves, read to bound the quoted depth to the
    /// *available* reserves (net of the fee buckets). Bound by address.
    #[account(address = vault.base_reserve)]
    pub base_reserve: Box<Account<'info, TokenAccount>>,
    #[account(address = vault.quote_reserve)]
    pub quote_reserve: Box<Account<'info, TokenAccount>>,
    /// B1: the vault's base and quote mints, bound by address, so the program
    /// derives the expected token-unit price from the verified Pyth value and
    /// the *real* mint decimals instead of trusting a scaled keeper number.
    #[account(address = vault.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = vault.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
}
/// S2-11: accounts for staging a quote into the `PendingQuote` PDA. The record
/// is created on first use and reused thereafter (`init_if_needed`).
#[derive(Accounts)]
pub struct StageQuote<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds=[b"config",vault.key().as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds=[b"quote",vault.key().as_ref()],bump=quote_state.bump)]
    pub quote_state: Box<Account<'info, QuoteState>>,
    #[account(
        init_if_needed,
        payer=keeper,
        space=8 + 64 + 13*8 + 2 + 692,
        seeds=[b"pending_quote",vault.key().as_ref(),keeper.key().as_ref()],
        bump
    )]
    pub pending_quote: Box<Account<'info, PendingQuote>>,
    #[account(address=vault.base_reserve)]
    pub base_reserve: Box<Account<'info, TokenAccount>>,
    #[account(address=vault.quote_reserve)]
    pub quote_reserve: Box<Account<'info, TokenAccount>>,
    /// CHECK: the keeper bond PDA. Unvalidated in the context (no `seeds`) so the
    /// MVP allowlist path pays no PDA-derivation CU; the body checks it only when
    /// `min_bond > 0`.
    pub keeper_bond: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
/// S2-11: accounts for committing a staged quote. The `price_update` account must
/// be the one written by the Pyth instruction preceding this instruction in the
/// same transaction.
#[derive(Accounts)]
pub struct CommitQuote<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds=[b"config",vault.key().as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut,seeds=[b"quote",vault.key().as_ref()],bump=quote_state.bump)]
    pub quote_state: Box<Account<'info, QuoteState>>,
    #[account(mut, seeds=[b"pending_quote",vault.key().as_ref(),keeper.key().as_ref()], bump=pending_quote.bump)]
    pub pending_quote: Box<Account<'info, PendingQuote>>,
    pub price_update: Box<Account<'info, PriceUpdateV2>>,
    #[account(address = vault.base_reserve)]
    pub base_reserve: Box<Account<'info, TokenAccount>>,
    #[account(address = vault.quote_reserve)]
    pub quote_reserve: Box<Account<'info, TokenAccount>>,
    /// CHECK: see `UpdateQuote::keeper_bond`.
    pub keeper_bond: UncheckedAccount<'info>,
    #[account(address = vault.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = vault.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
}
#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds=[b"config",vault.key().as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut,seeds=[b"quote",vault.key().as_ref()],bump=quote_state.bump)]
    pub quote_state: Box<Account<'info, QuoteState>>,
    #[account(mut,address=vault.base_reserve)]
    pub base_reserve: Box<Account<'info, TokenAccount>>,
    #[account(mut,address=vault.quote_reserve)]
    pub quote_reserve: Box<Account<'info, TokenAccount>>,
    #[account(mut,constraint=trader_base.owner==trader.key(),constraint=trader_base.mint==vault.base_mint)]
    pub trader_base: Box<Account<'info, TokenAccount>>,
    #[account(mut,constraint=trader_quote.owner==trader.key(),constraint=trader_quote.mint==vault.quote_mint)]
    pub trader_quote: Box<Account<'info, TokenAccount>>,
    /// S2-19: the reward account of the keeper attributed to the active quote
    /// (`quote_state.keeper`). Declared after the vault-token bindings so a
    /// mis-bound reserve/config still fails on its own account. Created lazily
    /// (trader pays) only when the quote was committed through the legacy direct
    /// path; the normal staged path creates it in `stage_quote` (keeper pays).
    #[account(init_if_needed, payer=trader, space=8+32+8+8+1, seeds=[b"reward", vault.key().as_ref(), quote_state.keeper.as_ref()], bump)]
    pub keeper_reward: Box<Account<'info, KeeperReward>>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}
impl<'info> Swap<'info> {
    fn base_transfer_ctx(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.key(),
            Transfer {
                from: self.trader_base.to_account_info(),
                to: self.base_reserve.to_account_info(),
                authority: self.trader.to_account_info(),
            },
        )
    }
    fn quote_transfer_ctx(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.key(),
            Transfer {
                from: self.trader_quote.to_account_info(),
                to: self.quote_reserve.to_account_info(),
                authority: self.trader.to_account_info(),
            },
        )
    }
}
#[derive(Accounts)]
pub struct TripBreaker<'info> {
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds=[b"config",vault.key().as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds=[b"quote",vault.key().as_ref()], bump)]
    pub quote_state: Box<Account<'info, QuoteState>>,
}
#[derive(Accounts)]
pub struct ResetBreaker<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub vault: Account<'info, Vault>,
}
#[derive(Accounts)]
pub struct WindDown<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct BondKeeper<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(address = vault.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, constraint = keeper_quote.owner == keeper.key(), constraint = keeper_quote.mint == vault.quote_mint)]
    pub keeper_quote: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = keeper, token::mint = quote_mint, token::authority = vault, seeds=[b"bond", vault.key().as_ref()], bump)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = keeper, space = 8 + 32 + 8 + 8 + 8 + 8 + 1, seeds=[b"keeper", vault.key().as_ref(), keeper.key().as_ref()], bump)]
    pub keeper_bond: Account<'info, KeeperBond>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
impl<'info> BondKeeper<'info> {
    fn fund_bond_ctx(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.key(),
            Transfer {
                from: self.keeper_quote.to_account_info(),
                to: self.bond_vault.to_account_info(),
                authority: self.keeper.to_account_info(),
            },
        )
    }
}

#[derive(Accounts)]
pub struct UnbondKeeper<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds=[b"config",vault.key().as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(address = vault.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, constraint = keeper_quote.owner == keeper.key(), constraint = keeper_quote.mint == vault.quote_mint)]
    pub keeper_quote: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds=[b"bond", vault.key().as_ref()], bump)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds=[b"keeper", vault.key().as_ref(), keeper.key().as_ref()], bump=keeper_bond.bump)]
    pub keeper_bond: Box<Account<'info, KeeperBond>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SlashKeeper<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address = vault.quote_reserve)]
    pub quote_reserve: Box<Account<'info, TokenAccount>>,
    /// CHECK: the bonded keeper, only used to derive the bond PDA.
    pub keeper: UncheckedAccount<'info>,
    #[account(mut, seeds=[b"keeper", vault.key().as_ref(), keeper.key().as_ref()], bump=keeper_bond.bump)]
    pub keeper_bond: Box<Account<'info, KeeperBond>>,
    #[account(mut, seeds=[b"bond", vault.key().as_ref()], bump)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimKeeperReward<'info> {
    pub keeper: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    /// S2-19: the signer's own reward account. Rewards are per-keeper, so no
    /// keeper can claim another keeper's accrual, and `config.keeper` no longer
    /// confers any exclusive reward entitlement.
    #[account(mut, seeds=[b"reward", vault.key().as_ref(), keeper.key().as_ref()], bump=keeper_reward.bump)]
    pub keeper_reward: Box<Account<'info, KeeperReward>>,
    #[account(mut, address=vault.base_reserve)]
    pub base_reserve: Box<Account<'info, TokenAccount>>,
    #[account(mut, address=vault.quote_reserve)]
    pub quote_reserve: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint=keeper_base.owner==keeper.key(), constraint=keeper_base.mint==vault.base_mint)]
    pub keeper_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint=keeper_quote.owner==keeper.key(), constraint=keeper_quote.mint==vault.quote_mint)]
    pub keeper_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MigrateQuoteState<'info> {
    /// Funds any rent shortfall for the larger account. May be any signer.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds=[b"vault", vault.base_mint.as_ref(), vault.quote_mint.as_ref()], bump=vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: validated in the handler — program-owned, the canonical QuoteState
    /// PDA for `vault` (enforced by the `seeds`/`bump` constraint), the correct
    /// `QuoteState` discriminator, and a supported legacy length. It is an
    /// `UncheckedAccount` because the legacy bytes cannot be deserialized into
    /// the larger current `QuoteState` struct.
    #[account(mut, seeds=[b"quote", vault.key().as_ref()], bump)]
    pub quote_state: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeProgram<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + 32 + 1, seeds=[b"program"], bump)]
    pub program_config: Account<'info, ProgramConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetParams<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds=[b"vault", vault.base_mint.as_ref(), vault.quote_mint.as_ref()], bump=vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds=[b"config", vault.key().as_ref()], bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    // S2-37: ParamsUpdate grew by one u64 (`expiry_slots`): 8 disc + 32 admin +
    // 8 activate_slot + 100 params + 1 bump.
    #[account(init_if_needed, payer=admin, space=8+32+8+100+1, seeds=[b"pending", vault.key().as_ref()], bump)]
    pub pending_config: Box<Account<'info, PendingConfig>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApplyParams<'info> {
    pub admin: Signer<'info>,
    #[account(seeds=[b"vault", vault.base_mint.as_ref(), vault.quote_mint.as_ref()], bump=vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds=[b"config", vault.key().as_ref()], bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds=[b"pending", vault.key().as_ref()], bump=pending_config.bump)]
    pub pending_config: Box<Account<'info, PendingConfig>>,
}

/// B4: the current admin proposes a successor (timelocked).
#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(seeds=[b"vault", vault.base_mint.as_ref(), vault.quote_mint.as_ref()], bump=vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds=[b"config", vault.key().as_ref()], bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
}

/// B4: the proposed successor accepts (must sign; timelock elapsed).
#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut)]
    pub new_admin: Signer<'info>,
    #[account(mut, seeds=[b"vault", vault.base_mint.as_ref(), vault.quote_mint.as_ref()], bump=vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds=[b"config", vault.key().as_ref()], bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
}

/// B4: the current admin cancels a pending rotation.
#[derive(Accounts)]
pub struct CancelAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(seeds=[b"vault", vault.base_mint.as_ref(), vault.quote_mint.as_ref()], bump=vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds=[b"config", vault.key().as_ref()], bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
}

/// Item 5: create/refresh a timelocked treasury fee-claim proposal.
#[derive(Accounts)]
pub struct ProposeFeeClaim<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds=[b"vault", vault.base_mint.as_ref(), vault.quote_mint.as_ref()], bump=vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(init_if_needed, payer=admin, space=8+32+1+8+1, seeds=[b"claim", vault.key().as_ref()], bump)]
    pub pending_claim: Box<Account<'info, PendingClaim>>,
    pub system_program: Program<'info, System>,
}

/// Item 5: execute a timelocked claim to the **fixed** `config.treasury`.
#[derive(Accounts)]
pub struct ExecuteFeeClaim<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds=[b"config", vault.key().as_ref()], bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds=[b"claim", vault.key().as_ref()], bump=pending_claim.bump)]
    pub pending_claim: Box<Account<'info, PendingClaim>>,
    #[account(mut, address=vault.base_reserve)]
    pub base_reserve: Box<Account<'info, TokenAccount>>,
    #[account(mut, address=vault.quote_reserve)]
    pub quote_reserve: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint=treasury_base.owner==config.treasury, constraint=treasury_base.mint==vault.base_mint)]
    pub treasury_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint=treasury_quote.owner==config.treasury, constraint=treasury_quote.mint==vault.quote_mint)]
    pub treasury_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Ceiling division for share maths; returns 0 when the denominator is 0.
fn ceil_div_u128(numerator: u128, denominator: u128) -> u128 {
    if denominator == 0 {
        return 0;
    }
    numerator / denominator + u128::from(!numerator.is_multiple_of(denominator))
}

fn integer_sqrt(n: u128) -> u128 {
    let mut lo = 0;
    let mut hi = 1u128 << 64;
    while lo + 1 < hi {
        let mid = (lo + hi) / 2;
        if mid <= n / mid {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

fn pyth_price_q64(price: i64, exponent: i32) -> Option<u128> {
    let positive = u128::try_from(price).ok()?;
    if exponent >= 0 {
        positive
            .checked_mul(10u128.checked_pow(exponent as u32)?)?
            .checked_mul(1u128 << 64)
    } else {
        positive
            .checked_mul(1u128 << 64)?
            .checked_div(10u128.checked_pow((-exponent) as u32)?)
    }
}

/// B1: normalize a *human* Q64 oracle price (`quote per base`, e.g. USDC per
/// SOL) into the executable **token-unit** price `quote-atoms per base-atom`,
/// using the vault's own mint decimals. This is the single, deterministic
/// definition of the stored/consumed price and mirrors the keeper's
/// `normalize_price_q64` exactly (integer; floor on division).
///
/// It is computed on-chain from the already-verified Pyth value, so a keeper
/// cannot pick an arbitrary scaled number that happens to pass the check.
fn normalize_pyth_price_q64(
    price_q64: u128,
    base_decimals: u8,
    quote_decimals: u8,
) -> Option<u128> {
    if base_decimals == quote_decimals {
        return Some(price_q64);
    }
    if quote_decimals > base_decimals {
        price_q64.checked_mul(10u128.checked_pow((quote_decimals - base_decimals) as u32)?)
    } else {
        Some(price_q64 / 10u128.checked_pow((base_decimals - quote_decimals) as u32)?)
    }
}

#[event]
pub struct VaultInitialized {
    pub slot: u64,
    pub vault: Pubkey,
}
/// S2-21A: a legacy `QuoteState` account was migrated to the current layout.
#[event]
pub struct QuoteStateMigrated {
    pub slot: u64,
    pub from_len: u64,
    pub to_len: u64,
}
#[event]
pub struct DepositEvent {
    pub slot: u64,
    pub shares: u64,
    pub base_amount: u64,
    pub quote_amount: u64,
}
#[event]
pub struct WithdrawRequested {
    pub slot: u64,
    pub shares: u64,
    pub epoch: u64,
}
#[event]
pub struct WithdrawClaimed {
    pub slot: u64,
    pub shares: u64,
    pub base_amount: u64,
    pub quote_amount: u64,
}
#[event]
pub struct QuoteUpdated {
    pub slot: u64,
    pub version: u64,
    pub anchor_sqrt_price: u128,
    pub depth_mult_bps: u32,
}
/// S2-11: a quote payload was staged (active quote unchanged).
#[event]
pub struct QuoteStaged {
    pub slot: u64,
    pub nonce: u64,
    pub oracle_publish_time: i64,
    pub update_slot: u64,
}
/// S2-11: a staged quote was committed and the active quote advanced.
#[event]
pub struct QuoteCommitted {
    pub slot: u64,
    pub version: u64,
    pub nonce: u64,
}
#[event]
pub struct SwapEvent {
    pub slot: u64,
    pub version: u64,
    pub side: SwapSide,
    pub amount_in: u64,
    pub amount_out: u64,
    pub fee: u64,
}
#[event]
pub struct BreakerTripped {
    pub slot: u64,
}

/// h3: the realized-edge breaker paused the vault.
#[event]
pub struct EdgeBreakerTripped {
    pub slot: u64,
    pub realized_edge: i128,
    pub bound: u128,
}
#[event]
pub struct BreakerReset {
    pub slot: u64,
}

#[event]
pub struct ParamsProposed {
    pub slot: u64,
    pub activate_slot: u64,
}

#[event]
pub struct ParamsApplied {
    pub slot: u64,
}

/// B4: admin rotation proposed (timelocked).
#[event]
pub struct AdminProposed {
    pub slot: u64,
    pub new_admin: Pubkey,
    pub activate_slot: u64,
}

/// B4: admin rotation accepted; the new admin is active.
#[event]
pub struct AdminChanged {
    pub slot: u64,
    pub new_admin: Pubkey,
}

#[event]
pub struct ProgramInitialized {
    pub admin: Pubkey,
}

#[event]
pub struct KeeperBonded {
    pub keeper: Pubkey,
    pub amount: u64,
    pub total: u64,
}

#[event]
pub struct KeeperSlashed {
    pub keeper: Pubkey,
    pub amount: u64,
}

#[event]
pub struct KeeperUnbonded {
    pub keeper: Pubkey,
    pub amount: u64,
}

#[event]
pub struct RewardClaimed {
    pub keeper: Pubkey,
    pub base: u64,
    pub quote: u64,
}

#[event]
pub struct FeeClaimProposed {
    pub slot: u64,
    pub activate_slot: u64,
}

#[event]
pub struct FeeClaimed {
    pub slot: u64,
    pub kind: FeeKind,
    pub base_amount: u64,
    pub quote_amount: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("No pending admin rotation")]
    NoPendingAdmin,
    #[msg("Invalid mint")]
    InvalidMint,
    #[msg("Invalid params")]
    InvalidParams,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Invalid weights")]
    InvalidWeights,
    #[msg("Invalid ladder")]
    InvalidLadder,
    #[msg("Level outside the anchor band")]
    LevelOutOfBounds,
    #[msg("Reservation outside the inventory band")]
    InventoryOutOfBounds,
    #[msg("Invalid price")]
    InvalidPrice,
    #[msg("Invalid status")]
    InvalidStatus,
    #[msg("Breaker condition not met")]
    BreakerConditionNotMet,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Paused")]
    Paused,
    #[msg("Warmup not elapsed")]
    WarmupNotElapsed,
    #[msg("Invalid oracle account or verification")]
    InvalidOracle,
    #[msg("Oracle price mismatch")]
    OraclePriceMismatch,
    #[msg("Stale oracle")]
    StaleOracle,
    #[msg("Wide confidence")]
    WideConfidence,
    #[msg("Anchor step too large")]
    AnchorStepTooLarge,
    #[msg("Anchor too far from the verified oracle price")]
    AnchorTooFarFromOracle,
    #[msg("Cumulative one-sided flow cap exceeded for this window")]
    FlowCapExceeded,
    #[msg("Quoted ladder depth exceeds the utilization cap of the available reserves")]
    UtilizationExceeded,
    #[msg("The insurance buffer cannot be claimed to the treasury")]
    InsuranceNotClaimable,
    #[msg("Timelock has not elapsed")]
    TimelockNotElapsed,
    #[msg("Insufficient keeper bond")]
    InsufficientBond,
    #[msg("Keeper is not bonded")]
    NotBonded,
    #[msg("Spread out of bounds")]
    SpreadOutOfBounds,
    #[msg("Half-spread changed by more than the per-update step bound")]
    SpreadStepTooLarge,
    #[msg("Keeper-supplied inverse square root under-estimates 1/sqrt")]
    InvalidInverseSqrt,
    #[msg("Quote expired")]
    QuoteExpired,
    #[msg("Version too old")]
    VersionTooOld,
    #[msg("Slippage exceeded")]
    SlippageExceeded,
    #[msg("Capacity exceeded")]
    CapacityExceeded,
    #[msg("Epoch not reached")]
    EpochNotReached,
    #[msg("Not keeper")]
    NotKeeper,
    #[msg("Non-monotonic slot")]
    NonMonotonicSlot,
    #[msg("Update slot is older than the configured maximum age")]
    UpdateSlotTooOld,
    #[msg("No staged quote to commit")]
    NoPendingQuote,
    #[msg("Staged quote is stale, replayed, or superseded")]
    StalePendingQuote,
    #[msg("Quote-relevant vault state changed between staging and commit")]
    StagedStateChanged,
    #[msg("Quote attribution does not match the active quote version")]
    QuoteAttributionMismatch,
    #[msg("Quote has no verified keeper attribution")]
    UnattributedQuote,
    #[msg("Account is not owned by this program")]
    InvalidAccountOwner,
    #[msg("Incorrect account discriminator")]
    InvalidAccountDiscriminator,
    #[msg("Unsupported account length for this operation")]
    UnsupportedAccountLength,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_sqrt_is_floored() {
        assert_eq!(integer_sqrt(0), 0);
        assert_eq!(integer_sqrt(1), 1);
        assert_eq!(integer_sqrt(15), 3);
        assert_eq!(integer_sqrt(16), 4);
    }

    #[test]
    fn default_level_is_rejected_by_quote_validation_shape() {
        let level = Level::default();
        assert!(level.sqrt_lo == 0 || level.sqrt_lo >= level.sqrt_hi || level.liquidity == 0);
    }

    #[test]
    fn pyth_decimal_conversion_uses_q64_floor() {
        let q64 = pyth_price_q64(150, -0).unwrap();
        assert_eq!(q64, 150u128 << 64);
        let q64_fraction = pyth_price_q64(15000, -2).unwrap();
        assert_eq!(q64_fraction, 150u128 << 64);
    }
}
