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
/// Also used for the volatility-parameter proposal/apply flow. Public so an
/// integration test can assert the on-chain activation slot against the real
/// constant instead of a hard-coded duplicate.
pub const TIMELOCK_SLOTS: u64 = 216_000;
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
/// On-chain volatility: the vault-bound `[b"vol", vault]` PDA holds both the
/// EWMA/jump observation state and the risk parameters, so the feature needs no
/// `Config` layout migration. The math is `arb_math::volatility`, shared
/// bit-for-bit with the keeper (see `docs/VOLATILITY_MATH_SPEC.md`).
const VOL_SEED: &[u8] = b"vol";
/// Seed of the timelocked pending volatility-parameter PDA `[b"vol_pending", vault]`.
const VOL_PENDING_SEED: &[u8] = b"vol_pending";
/// Bound on the EWMA time-normalisation steps (mirrors the shared module).
const VOL_MAX_EWMA_STEPS: u32 = arb_math::volatility::MAX_EWMA_STEPS;
/// Allocated byte length of the `VolatilityState` account (excluding the
/// 8-byte discriminator): 32 + 16*4 + 8*6 + 2 + 4*5 + 1.
const VOLATILITY_STATE_LEN: usize = 32 + 16 * 4 + 8 * 6 + 2 + 4 * 5 + 1;
/// Allocated byte length of `PendingVolatilityParams` (excluding the 8-byte
/// discriminator): admin 32 + activate_slot 8 + params (4*3 + 16 + 8 + 4*2 + 8)
/// + enabled 1 + bump 1.
const PENDING_VOLATILITY_LEN: usize = 32 + 8 + (4 * 3 + 16 + 8 + 4 * 2 + 8) + 1 + 1;

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

    /// One-time creation of the vault-bound volatility PDA. Admin only. An
    /// all-zero `params` payload selects `DEFAULT_VOLATILITY_PARAMS`.
    pub fn initialize_volatility(
        ctx: Context<InitializeVolatility>,
        params: VolatilityParams,
    ) -> Result<()> {
        require!(
            ctx.accounts.vault.admin == ctx.accounts.admin.key(),
            ErrorCode::Unauthorized
        );
        let params = if params == VolatilityParams::default() {
            DEFAULT_VOLATILITY_PARAMS
        } else {
            params
        };
        validate_volatility_params(&params)?;
        let vs = &mut ctx.accounts.volatility_state;
        vs.vault = ctx.accounts.vault.key();
        vs.short_ewma_q64 = 0;
        vs.medium_ewma_q64 = 0;
        vs.last_price_q64 = 0;
        vs.last_publish_time = 0;
        vs.last_observation_slot = 0;
        vs.observation_nonce = 0;
        vs.jump_detected = false;
        vs.jump_until_slot = 0;
        vs.short_lambda_bps = params.short_lambda_bps;
        vs.medium_lambda_bps = params.medium_lambda_bps;
        vs.jump_multiple = params.jump_multiple;
        vs.max_sigma_q64 = params.max_sigma_q64;
        vs.jump_cooldown_slots = params.jump_cooldown_slots;
        vs.vol_spread_coeff_bps = params.vol_spread_coeff_bps;
        vs.vol_depth_coeff_bps = params.vol_depth_coeff_bps;
        vs.max_observation_age_slots = params.max_observation_age_slots;
        // Fail closed: a freshly created PDA never enforces. Activation is a
        // separate, timelocked `apply_volatility_params` step.
        vs.enabled = false;
        vs.bump = ctx.bumps.volatility_state;
        emit!(VolatilityInitialized {
            slot: Clock::get()?.slot,
            vault: vs.vault,
        });
        Ok(())
    }

    /// Admin-only, timelocked proposal of the volatility risk parameters and the
    /// activation switch. Nothing changes until `apply_volatility_params` runs
    /// at least `TIMELOCK_SLOTS` later, so an activation or a loosening of the
    /// guards is announced and observable before it takes effect.
    pub fn propose_volatility_params(
        ctx: Context<ProposeVolatilityParams>,
        params: VolatilityParams,
        enabled: bool,
    ) -> Result<()> {
        require!(
            ctx.accounts.vault.admin == ctx.accounts.admin.key(),
            ErrorCode::Unauthorized
        );
        validate_volatility_params(&params)?;
        let now = Clock::get()?.slot;
        let pending = &mut ctx.accounts.pending_volatility;
        pending.admin = ctx.accounts.admin.key();
        pending.activate_slot = now.saturating_add(TIMELOCK_SLOTS);
        pending.params = params;
        pending.enabled = enabled;
        pending.bump = ctx.bumps.pending_volatility;
        emit!(VolatilityParamsProposed {
            slot: now,
            vault: ctx.accounts.vault.key(),
            enabled,
            activate_slot: pending.activate_slot,
        });
        Ok(())
    }

    /// Admin-only application of a proposed volatility change once the timelock
    /// elapsed. Re-validates the payload and, when the proposal enables
    /// enforcement, requires at least one verified observation so the guards
    /// activate against a real baseline rather than a zero one.
    pub fn apply_volatility_params(ctx: Context<ApplyVolatilityParams>) -> Result<()> {
        require!(
            ctx.accounts.vault.admin == ctx.accounts.admin.key()
                && ctx.accounts.pending_volatility.admin == ctx.accounts.admin.key(),
            ErrorCode::Unauthorized
        );
        require!(
            Clock::get()?.slot >= ctx.accounts.pending_volatility.activate_slot,
            ErrorCode::TimelockNotElapsed
        );
        let params = ctx.accounts.pending_volatility.params;
        let enabled = ctx.accounts.pending_volatility.enabled;
        validate_volatility_params(&params)?;
        let vs = &mut ctx.accounts.volatility_state;
        if enabled {
            require!(vs.last_price_q64 > 0, ErrorCode::VolatilityNotReady);
        }
        vs.short_lambda_bps = params.short_lambda_bps;
        vs.medium_lambda_bps = params.medium_lambda_bps;
        vs.jump_multiple = params.jump_multiple;
        vs.max_sigma_q64 = params.max_sigma_q64;
        vs.jump_cooldown_slots = params.jump_cooldown_slots;
        vs.vol_spread_coeff_bps = params.vol_spread_coeff_bps;
        vs.vol_depth_coeff_bps = params.vol_depth_coeff_bps;
        vs.max_observation_age_slots = params.max_observation_age_slots;
        vs.enabled = enabled;
        // Disarm the proposal so it cannot be applied twice.
        ctx.accounts.pending_volatility.activate_slot = u64::MAX;
        emit!(VolatilityParamsApplied {
            slot: Clock::get()?.slot,
            vault: vs.vault,
            enabled,
        });
        Ok(())
    }

    /// Permissionless: advance the vault's EWMA volatility and jump state from a
    /// verified, fresh, feed-matching Pyth update. Rejects an older or repeated
    /// `publish_time`, so state is monotonic and cannot be replayed. Grants the
    /// observer no authority over the vault or the configured parameters.
    pub fn observe_volatility(ctx: Context<ObserveVolatility>) -> Result<()> {
        let clock = Clock::get()?;
        let config = &ctx.accounts.config;
        let vs = &mut ctx.accounts.volatility_state;
        require!(config.max_staleness_seconds >= 0, ErrorCode::InvalidOracle);
        let feed = config.pyth_feed_id;
        let price = ctx
            .accounts
            .price_update
            .get_price_no_older_than(&clock, config.max_staleness_seconds as u64, &feed)
            .map_err(|_| error!(ErrorCode::InvalidOracle))?;
        require!(
            price.price > 0 && price.publish_time > 0,
            ErrorCode::InvalidPrice
        );
        require!(
            price.publish_time > vs.last_publish_time,
            ErrorCode::StaleVolatilityObservation
        );
        let decoded_conf_bps = ((price.conf as u128)
            .saturating_mul(10_000)
            .saturating_add(price.price as u128 - 1)
            / price.price as u128) as u32;
        require!(
            decoded_conf_bps <= config.max_conf_bps,
            ErrorCode::WideConfidence
        );
        let pyth_q64 =
            pyth_price_q64(price.price, price.exponent).ok_or(ErrorCode::InvalidOracle)?;
        let normalized = normalize_pyth_price_q64(
            pyth_q64,
            ctx.accounts.base_mint.decimals,
            ctx.accounts.quote_mint.decimals,
        )
        .ok_or(ErrorCode::InvalidOracle)?;
        require!(normalized > 0, ErrorCode::InvalidPrice);

        let dt_millis = if vs.last_publish_time == 0 {
            0
        } else {
            ((price.publish_time - vs.last_publish_time) as u64).saturating_mul(1_000)
        };
        let previous = arb_math::volatility::VolatilityState {
            variance_short_q64: vs.short_ewma_q64,
            variance_medium_q64: vs.medium_ewma_q64,
            last_price_q64: vs.last_price_q64,
            jump: vs.jump_detected,
        };
        let next = arb_math::volatility::update_with_dt(
            previous,
            normalized,
            dt_millis,
            vs.short_lambda_bps,
            vs.medium_lambda_bps,
            vs.jump_multiple as u128,
            VOL_MAX_EWMA_STEPS,
        )
        .map_err(|_| error!(ErrorCode::MathOverflow))?;

        vs.short_ewma_q64 = next.variance_short_q64;
        vs.medium_ewma_q64 = next.variance_medium_q64;
        vs.last_price_q64 = next.last_price_q64;
        vs.jump_detected = next.jump;
        if next.jump {
            vs.jump_until_slot = clock.slot.saturating_add(vs.jump_cooldown_slots);
        }
        vs.last_publish_time = price.publish_time;
        vs.last_observation_slot = clock.slot;
        vs.observation_nonce = vs.observation_nonce.saturating_add(1);
        emit!(VolatilityObserved {
            slot: clock.slot,
            publish_time: price.publish_time,
            short_ewma_q64: vs.short_ewma_q64,
            medium_ewma_q64: vs.medium_ewma_q64,
            jump: vs.jump_detected,
            nonce: vs.observation_nonce,
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

    /// Single-token deposit. The user enters with one token; the vault converts
    /// the unwanted leg against its own committed ladder and deposits both legs.
    /// Shares use the existing proportional rule priced at the post-swap net
    /// reserves; only the input token is pulled. Same fee, spread, flow cap and
    /// edge breaker as `swap`. See `docs/SINGLE_SIDED_DESIGN.md`.
    pub fn deposit_single(
        ctx: Context<DepositSingle>,
        side: SwapSide,
        amount_in: u64,
        min_shares: u64,
        min_swap_out: u64,
    ) -> Result<()> {
        require!(ctx.accounts.vault.status == ACTIVE, ErrorCode::Paused);
        let clock = Clock::get()?;
        require!(
            clock.slot < ctx.accounts.quote_state.expiry_slot,
            ErrorCode::QuoteExpired
        );
        require!(
            ctx.accounts.quote_state.keeper != Pubkey::default(),
            ErrorCode::UnattributedQuote
        );
        let keeper = ctx.accounts.quote_state.keeper;
        if ctx.accounts.keeper_reward.keeper == Pubkey::default() {
            ctx.accounts.keeper_reward.keeper = keeper;
            ctx.accounts.keeper_reward.bump = ctx.bumps.keeper_reward;
        }
        require!(
            ctx.accounts.keeper_reward.keeper == keeper,
            ErrorCode::QuoteAttributionMismatch
        );
        require!(
            amount_in > 0 && amount_in <= ctx.accounts.config.max_quote_size,
            ErrorCode::CapacityExceeded
        );
        // The internal conversion needs an existing, funded pool and ladder.
        let total_shares = ctx.accounts.vault.total_shares;
        require!(total_shares > 0, ErrorCode::InvalidParams);
        let base_reserve_before = ctx.accounts.base_reserve.amount;
        let base_net = base_reserve_before
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
        require!(base_net > 0 && quote_net > 0, ErrorCode::InvalidParams);

        let plan = solve_deposit_single(
            &ctx.accounts.config,
            &ctx.accounts.quote_state,
            side,
            amount_in,
            base_net,
            quote_net,
            total_shares,
        )?;
        require!(plan.db > 0 && plan.dq > 0, ErrorCode::InvalidAmount);
        require!(plan.swap_out > 0, ErrorCode::InvalidAmount);
        require!(plan.shares > 0, ErrorCode::InvalidAmount);
        require!(plan.shares >= min_shares, ErrorCode::SlippageExceeded);
        require!(plan.swap_out >= min_swap_out, ErrorCode::SlippageExceeded);

        // Pull the full input once. The swapped notional and its fee stay in the
        // reserve (fee to the buckets); the remainder is the deposit notional.
        match side {
            SwapSide::SellBase => token::transfer(ctx.accounts.base_transfer_ctx(), amount_in)?,
            SwapSide::BuyBase => token::transfer(ctx.accounts.quote_transfer_ctx(), amount_in)?,
        }
        credit_fee_buckets(
            &mut ctx.accounts.vault,
            &mut ctx.accounts.keeper_reward,
            side,
            plan.fee,
            &ctx.accounts.config,
        )?;
        apply_flow_cap(
            &ctx.accounts.config,
            &mut ctx.accounts.quote_state,
            clock.slot,
            base_reserve_before,
            side,
            plan.s - plan.fee,
            plan.swap_out,
        )?;
        // h3: the same realized-edge tracker as `swap`; avail reserves are read
        // after the input transfer.
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
        apply_edge(
            &ctx.accounts.config,
            &mut ctx.accounts.quote_state,
            &mut ctx.accounts.vault,
            clock.slot,
            side,
            plan.s,
            plan.swap_out,
            avail_base,
            avail_quote,
        );

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
            plan.shares,
        )?;
        ctx.accounts.vault.total_shares = total_shares
            .checked_add(plan.shares)
            .ok_or(ErrorCode::MathOverflow)?;
        let ticket = &mut ctx.accounts.deposit_ticket;
        ticket.owner = ctx.accounts.user.key();
        ticket.shares = plan.shares;
        ticket.activate_slot = clock
            .slot
            .checked_add(ctx.accounts.config.warmup_slots)
            .ok_or(ErrorCode::MathOverflow)?;
        ticket.bump = ctx.bumps.deposit_ticket;
        emit!(DepositSingleEvent {
            slot: clock.slot,
            version: ctx.accounts.quote_state.version,
            side,
            amount_in,
            swap_in: plan.s,
            swap_out: plan.swap_out,
            fee: plan.fee,
            base_deposited: plan.db,
            quote_deposited: plan.dq,
            shares: plan.shares,
        });
        Ok(())
    }

    /// Single-token withdrawal. Reuses `claim_withdraw`'s pro-rata floors and
    /// ticket/burn semantics, then converts the unwanted leg against the vault's
    /// committed ladder and pays out only `side`. Requires a fresh attributed
    /// quote; the normal `claim_withdraw` still works with an expired quote.
    pub fn claim_withdraw_single(
        ctx: Context<ClaimWithdrawSingle>,
        side: SwapSide,
        min_out: u64,
    ) -> Result<()> {
        require!(ctx.accounts.vault.status == ACTIVE, ErrorCode::Paused);
        let clock = Clock::get()?;
        require!(
            clock.slot < ctx.accounts.quote_state.expiry_slot,
            ErrorCode::QuoteExpired
        );
        require!(
            ctx.accounts.quote_state.keeper != Pubkey::default(),
            ErrorCode::UnattributedQuote
        );
        let keeper = ctx.accounts.quote_state.keeper;
        if ctx.accounts.keeper_reward.keeper == Pubkey::default() {
            ctx.accounts.keeper_reward.keeper = keeper;
            ctx.accounts.keeper_reward.bump = ctx.bumps.keeper_reward;
        }
        require!(
            ctx.accounts.keeper_reward.keeper == keeper,
            ErrorCode::QuoteAttributionMismatch
        );

        require!(
            ctx.accounts.withdraw_ticket.epoch <= ctx.accounts.vault.epoch,
            ErrorCode::EpochNotReached
        );
        let total = ctx.accounts.vault.total_shares;
        require!(total > 0, ErrorCode::MathOverflow);
        let shares = ctx.accounts.withdraw_ticket.shares as u128;
        require!(shares > 0, ErrorCode::InvalidAmount);
        let base_reserve_before = ctx.accounts.base_reserve.amount;
        let base_available = base_reserve_before
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
        let base_out = (shares * base_available as u128 / total as u128) as u64;
        let quote_out = (shares * quote_available as u128 / total as u128) as u64;

        // `side` names the payout token: `BuyBase` pays base out (converting the
        // unwanted quote), `SellBase` pays quote out (converting base).
        let unwanted = match side {
            SwapSide::BuyBase => quote_out,
            SwapSide::SellBase => base_out,
        };
        let (fee, swap_net) = charge_fee(unwanted, ctx.accounts.config.fee_bps)?;
        let converted = if swap_net > 0 {
            walk_committed_ladder(&ctx.accounts.quote_state, side, swap_net)?
        } else {
            0
        };
        let payout = match side {
            SwapSide::BuyBase => base_out
                .checked_add(converted)
                .ok_or(ErrorCode::MathOverflow)?,
            SwapSide::SellBase => quote_out
                .checked_add(converted)
                .ok_or(ErrorCode::MathOverflow)?,
        };
        let payout_available = match side {
            SwapSide::BuyBase => base_available,
            SwapSide::SellBase => quote_available,
        };
        require!(payout <= payout_available, ErrorCode::CapacityExceeded);
        require!(payout >= min_out, ErrorCode::SlippageExceeded);

        credit_fee_buckets(
            &mut ctx.accounts.vault,
            &mut ctx.accounts.keeper_reward,
            side,
            fee,
            &ctx.accounts.config,
        )?;
        apply_flow_cap(
            &ctx.accounts.config,
            &mut ctx.accounts.quote_state,
            clock.slot,
            base_reserve_before,
            side,
            swap_net,
            converted,
        )?;
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
        apply_edge(
            &ctx.accounts.config,
            &mut ctx.accounts.quote_state,
            &mut ctx.accounts.vault,
            clock.slot,
            side,
            unwanted,
            converted,
            avail_base,
            avail_quote,
        );

        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[
            b"vault",
            ctx.accounts.vault.base_mint.as_ref(),
            ctx.accounts.vault.quote_mint.as_ref(),
            &bump,
        ];
        match side {
            SwapSide::BuyBase => token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.base_reserve.to_account_info(),
                        to: ctx.accounts.user_base.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[seeds],
                ),
                payout,
            )?,
            SwapSide::SellBase => token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.quote_reserve.to_account_info(),
                        to: ctx.accounts.user_quote.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[seeds],
                ),
                payout,
            )?,
        }
        let burned = ctx.accounts.withdraw_ticket.shares;
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
            burned,
        )?;
        ctx.accounts.vault.total_shares =
            total.checked_sub(burned).ok_or(ErrorCode::MathOverflow)?;
        ctx.accounts.withdraw_ticket.shares = 0;
        emit!(WithdrawSingleEvent {
            slot: clock.slot,
            version: ctx.accounts.quote_state.version,
            side,
            shares: burned,
            base_out,
            quote_out,
            swap_in: unwanted,
            swap_out: converted,
            fee,
            payout,
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
            &ctx.accounts.volatility_state,
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
        // Fail-fast volatility guard: staging must not accept a payload the
        // commit would reject once enforcement is enabled.
        validate_volatility_guard(
            &ctx.accounts.config,
            &update,
            &ctx.accounts.volatility_state,
            &clock,
        )?;
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
            &ctx.accounts.volatility_state,
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
        let (fee, net) = charge_fee(amount_in, ctx.accounts.config.fee_bps)?;
        // h1: the vault trades against the side-specific ladder. A trader buying
        // base lifts the ask ladder; a trader selling base hits the bid ladder.
        let out = walk_committed_ladder(&ctx.accounts.quote_state, side, net)?;
        require!(out >= min_out, ErrorCode::SlippageExceeded);
        // Item 1a / Spec §5.9: roll the one-sided flow window, enforce the
        // cumulative cap, and maintain the signed net-base-sold accumulator.
        apply_flow_cap(
            &ctx.accounts.config,
            &mut ctx.accounts.quote_state,
            clock.slot,
            ctx.accounts.base_reserve.amount,
            side,
            net,
            out,
        )?;
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
            }
        }
        credit_fee_buckets(
            &mut ctx.accounts.vault,
            &mut ctx.accounts.keeper_reward,
            side,
            fee,
            &ctx.accounts.config,
        )?;
        // h3: realized execution edge vs the stored verified oracle. Positive
        // means the vault traded better than the oracle mid; the running sum is
        // checked against a fraction of the available value each swap.
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
        apply_edge(
            &ctx.accounts.config,
            &mut ctx.accounts.quote_state,
            &mut ctx.accounts.vault,
            clock.slot,
            side,
            amount_in,
            out,
            avail_base,
            avail_quote,
        );
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

/// On-chain volatility guard, applied to every quote path (update, stage,
/// commit). While `vs.enabled` is `false` the guard is a no-op, so a vault that
/// has initialized but not activated the PDA behaves exactly as before. Once
/// enabled it **fails closed**: a missing baseline or a stale observation is
/// rejected, the sigma kill-switch is enforced, and the spread floor / depth
/// cap are derived from the on-chain sigma (multiplied during an active jump).
fn validate_volatility_guard(
    config: &Config,
    update: &QuoteUpdate,
    vs: &VolatilityState,
    clock: &Clock,
) -> Result<()> {
    volatility_guard_core(config.min_spread_bps, update, vs, clock.slot)
}

/// Pure core of the volatility guard (no `Config`), split out so the spread
/// floor, depth cap, kill-switch, and fail-closed freshness rules are unit
/// testable without constructing a full `Config`.
fn volatility_guard_core(
    min_spread_bps: u32,
    update: &QuoteUpdate,
    vs: &VolatilityState,
    slot: u64,
) -> Result<()> {
    if !vs.enabled {
        return Ok(());
    }
    require!(vs.last_price_q64 > 0, ErrorCode::StaleVolatilityObservation);
    require!(
        slot.saturating_sub(vs.last_observation_slot) <= vs.max_observation_age_slots,
        ErrorCode::StaleVolatilityObservation
    );
    let sigma = arb_math::fixed::sqrt_q64(vs.short_ewma_q64)
        .map_err(|_| error!(ErrorCode::MathOverflow))?;
    // Kill-switch: quote nothing above the configured sigma ceiling.
    require!(sigma <= vs.max_sigma_q64, ErrorCode::VolatilityTooHigh);
    let sigma_bps = sigma.saturating_mul(BPS_DENOM as u128) / (1u128 << 64);
    let jump_active = vs.jump_detected || slot < vs.jump_until_slot;
    let mult = if jump_active {
        vs.jump_multiple as u128
    } else {
        1
    };
    let effective_bps = sigma_bps.saturating_mul(mult);
    // Spread floor grows with sigma (and is multiplied during an active jump),
    // never dropping below the configured static minimum.
    let vol_floor = mul_bps_ceil(effective_bps, vs.vol_spread_coeff_bps as u128);
    let floor = (min_spread_bps as u128).max(vol_floor);
    require!(
        (update.half_spread_bps as u128) >= floor,
        ErrorCode::VolatilitySpreadTooLow
    );
    // Depth cap shrinks with sigma: a higher volatility regime permits a smaller
    // depth multiplier.
    let depth_cut = mul_bps_ceil(effective_bps, vs.vol_depth_coeff_bps as u128);
    let cap = (BPS_DENOM as u128).saturating_sub(depth_cut.min(BPS_DENOM as u128));
    require!(
        (update.depth_mult_bps as u128) <= cap,
        ErrorCode::DepthAboveVolatility
    );
    Ok(())
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
    volatility: &VolatilityState,
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
    // On-chain volatility enforcement (fail closed once enabled).
    validate_volatility_guard(config, update, volatility, clock)?;
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
/// On-chain EWMA volatility, jump detector and risk parameters, seeded
/// `[b"vol", vault]` and initialized once by the vault admin. `short_ewma_q64`
/// and `medium_ewma_q64` store the `arb_math::volatility` per-second variances
/// (Q64.64); `last_price_q64` is the normalized token-unit price of the last
/// verified observation. Any signer may advance this account through
/// `observe_volatility`, but no observer gains authority over the vault or the
/// configured parameters.
#[account]
pub struct VolatilityState {
    pub vault: Pubkey,
    pub short_ewma_q64: u128,
    pub medium_ewma_q64: u128,
    pub last_price_q64: u128,
    pub last_publish_time: i64,
    pub last_observation_slot: u64,
    pub observation_nonce: u64,
    pub jump_detected: bool,
    /// Slot at which an active jump's configured cooldown ends (`0` = none).
    pub jump_until_slot: u64,
    pub short_lambda_bps: u32,
    pub medium_lambda_bps: u32,
    pub jump_multiple: u32,
    pub max_sigma_q64: u128,
    pub jump_cooldown_slots: u64,
    pub vol_spread_coeff_bps: u32,
    pub vol_depth_coeff_bps: u32,
    pub max_observation_age_slots: u64,
    /// Fail-closed activation switch. `false` until the admin applies a
    /// timelocked activation; while `false` the quote path behaves exactly as
    /// it did before this feature existed. Once `true`, every quote update,
    /// stage, and commit must supply this PDA and pass the volatility guards.
    pub enabled: bool,
    pub bump: u8,
}

/// Parameter payload for the vault-bound volatility PDA. Admin gated, validated,
/// and stored entirely in the PDA (no `Config` change). Applied only through the
/// timelocked `propose_volatility_params` / `apply_volatility_params` flow.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq)]
pub struct VolatilityParams {
    pub short_lambda_bps: u32,
    pub medium_lambda_bps: u32,
    pub jump_multiple: u32,
    pub max_sigma_q64: u128,
    pub jump_cooldown_slots: u64,
    pub vol_spread_coeff_bps: u32,
    pub vol_depth_coeff_bps: u32,
    pub max_observation_age_slots: u64,
}

/// Conservative defaults used by `initialize_volatility` when the caller passes
/// the all-zero payload (a convenience for local/dev flows).
pub const DEFAULT_VOLATILITY_PARAMS: VolatilityParams = VolatilityParams {
    short_lambda_bps: 9_400,
    medium_lambda_bps: 9_900,
    jump_multiple: 4,
    max_sigma_q64: 1u128 << 60,
    jump_cooldown_slots: 1_800,
    vol_spread_coeff_bps: 1_000,
    vol_depth_coeff_bps: 2_000,
    max_observation_age_slots: 3_600,
};

/// Timelocked pending volatility-parameter change, seeded `[b"vol_pending",
/// vault]`. Mirrors the `PendingConfig` flow (F-17): the admin proposes, and the
/// change applies only via `apply_volatility_params` at least `TIMELOCK_SLOTS`
/// slots later. `enabled` is part of the payload, so activation itself is
/// timelocked and observable before it takes effect.
#[account]
pub struct PendingVolatilityParams {
    pub admin: Pubkey,
    pub activate_slot: u64,
    pub params: VolatilityParams,
    pub enabled: bool,
    pub bump: u8,
}

fn validate_volatility_params(p: &VolatilityParams) -> Result<()> {
    require!(
        p.short_lambda_bps > 0 && p.short_lambda_bps < 10_000,
        ErrorCode::InvalidVolatilityParams
    );
    require!(
        p.medium_lambda_bps >= p.short_lambda_bps && p.medium_lambda_bps < 10_000,
        ErrorCode::InvalidVolatilityParams
    );
    require!(
        p.jump_multiple >= 1 && p.jump_multiple <= 10_000,
        ErrorCode::InvalidVolatilityParams
    );
    require!(p.max_sigma_q64 > 0, ErrorCode::InvalidVolatilityParams);
    require!(
        p.vol_spread_coeff_bps <= 10_000,
        ErrorCode::InvalidVolatilityParams
    );
    require!(
        p.vol_depth_coeff_bps <= 10_000,
        ErrorCode::InvalidVolatilityParams
    );
    require!(
        p.max_observation_age_slots > 0,
        ErrorCode::InvalidVolatilityParams
    );
    Ok(())
}

/// `ceil(a * bps / 10_000)` in u128 (used by the volatility spread floor and
/// depth cap so a non-zero coefficient is never floored away).
fn mul_bps_ceil(a: u128, bps: u128) -> u128 {
    a.saturating_mul(bps).saturating_add(BPS_DENOM as u128 - 1) / BPS_DENOM as u128
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
pub struct InitializeVolatility<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        init,
        payer = admin,
        space = 8 + VOLATILITY_STATE_LEN,
        seeds = [VOL_SEED, vault.key().as_ref()],
        bump
    )]
    pub volatility_state: Box<Account<'info, VolatilityState>>,
    pub system_program: Program<'info, System>,
}

/// Admin-only timelocked proposal of volatility parameters/activation.
#[derive(Accounts)]
pub struct ProposeVolatilityParams<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + PENDING_VOLATILITY_LEN,
        seeds = [VOL_PENDING_SEED, vault.key().as_ref()],
        bump
    )]
    pub pending_volatility: Box<Account<'info, PendingVolatilityParams>>,
    pub system_program: Program<'info, System>,
}

/// Admin-only application of a previously proposed volatility change once the
/// timelock elapsed.
#[derive(Accounts)]
pub struct ApplyVolatilityParams<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [VOL_SEED, vault.key().as_ref()], bump = volatility_state.bump)]
    pub volatility_state: Box<Account<'info, VolatilityState>>,
    #[account(mut, seeds = [VOL_PENDING_SEED, vault.key().as_ref()], bump = pending_volatility.bump)]
    pub pending_volatility: Box<Account<'info, PendingVolatilityParams>>,
}

/// Permissionless observation. The observer only funds the transaction; the
/// instruction requires a fresh, feed-matching `PriceUpdateV2` and a strictly
/// newer `publish_time`, and can never touch the vault, reserves, or params.
#[derive(Accounts)]
pub struct ObserveVolatility<'info> {
    pub observer: Signer<'info>,
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds = [b"config", vault.key().as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VOL_SEED, vault.key().as_ref()], bump = volatility_state.bump)]
    pub volatility_state: Box<Account<'info, VolatilityState>>,
    pub price_update: Box<Account<'info, PriceUpdateV2>>,
    #[account(address = vault.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = vault.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
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

/// Single-token deposit accounts (see `docs/SINGLE_SIDED_DESIGN.md`). Mirrors
/// `Deposit` plus the committed `quote_state` and the attributed keeper's reward
/// PDA, so the internal conversion uses the exact same ladder and fee path as
/// `swap`. Both user ATAs are supplied; only the input side is debited.
#[derive(Accounts)]
pub struct DepositSingle<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds=[b"config", vault.key().as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds=[b"quote", vault.key().as_ref()], bump = quote_state.bump)]
    pub quote_state: Box<Account<'info, QuoteState>>,
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
    #[account(init_if_needed, payer=user, space=8+32+8+8+1, seeds=[b"reward", vault.key().as_ref(), quote_state.keeper.as_ref()], bump)]
    pub keeper_reward: Box<Account<'info, KeeperReward>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
impl<'info> DepositSingle<'info> {
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

/// Single-token withdrawal accounts (see `docs/SINGLE_SIDED_DESIGN.md`). Mirrors
/// `ClaimWithdraw` plus the committed `quote_state` and the attributed keeper's
/// reward PDA. Both user ATAs are supplied; only the payout side is credited.
#[derive(Accounts)]
pub struct ClaimWithdrawSingle<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds=[b"config", vault.key().as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds=[b"quote", vault.key().as_ref()], bump = quote_state.bump)]
    pub quote_state: Box<Account<'info, QuoteState>>,
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
    #[account(init_if_needed, payer=user, space=8+32+8+8+1, seeds=[b"reward", vault.key().as_ref(), quote_state.keeper.as_ref()], bump)]
    pub keeper_reward: Box<Account<'info, KeeperReward>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
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
    /// Required, vault-bound volatility PDA. When its `enabled` flag is set the
    /// committed quote must satisfy the on-chain volatility spread floor, depth
    /// cap, and sigma kill-switch, and its observation must be fresh; a stale
    /// observation is rejected (fail closed). Required — not optional — so
    /// enforcement cannot be bypassed by omitting the account.
    #[account(seeds = [VOL_SEED, vault.key().as_ref()], bump = volatility_state.bump)]
    pub volatility_state: Box<Account<'info, VolatilityState>>,
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
    /// Required, vault-bound volatility PDA; see `UpdateQuote::volatility_state`.
    /// Staging is guarded too so a staged payload cannot be built that the
    /// program would refuse to commit.
    #[account(seeds = [VOL_SEED, vault.key().as_ref()], bump = volatility_state.bump)]
    pub volatility_state: Box<Account<'info, VolatilityState>>,
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
    /// Required, vault-bound volatility PDA; see `UpdateQuote::volatility_state`.
    #[account(seeds = [VOL_SEED, vault.key().as_ref()], bump = volatility_state.bump)]
    pub volatility_state: Box<Account<'info, VolatilityState>>,
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

// ---------------------------------------------------------------------------
// Shared swap maths (see docs/SINGLE_SIDED_DESIGN.md §1.3).
//
// These helpers are the single definition of the trading fee, the fee split,
// the ladder walk, the one-sided flow cap, and the realized-edge tracker. `swap`
// calls all of them; the single-sided instructions call the same ones, so the
// fee, spread, flow cap and breaker behave identically on every path. `swap`'s
// arithmetic is unchanged (proven by the existing suites passing unmodified).
// ---------------------------------------------------------------------------

/// `fee = ceil(amount_in * fee_bps / 10_000)` and `net = amount_in - fee`,
/// exactly as `swap` charges.
fn charge_fee(amount_in: u64, fee_bps: u16) -> Result<(u64, u64)> {
    let fee = arb_math::fee_amount(amount_in as u128, fee_bps as u128)
        .map_err(|_| error!(ErrorCode::MathOverflow))? as u64;
    let net = amount_in.checked_sub(fee).ok_or(ErrorCode::MathOverflow)?;
    Ok((fee, net))
}

/// Split a fee into the insurance/keeper/protocol buckets by bps (floor).
fn fee_split(fee: u64, config: &Config) -> (u64, u64, u64) {
    let insurance = (fee as u128).saturating_mul(config.insurance_bps as u128) / 10_000;
    let keeper = (fee as u128).saturating_mul(config.keeper_bps as u128) / 10_000;
    let protocol = (fee as u128).saturating_mul(config.protocol_bps as u128) / 10_000;
    (insurance as u64, keeper as u64, protocol as u64)
}

/// Walk the committed ladder for `net` input on `side`; require the ladder to
/// absorb the whole amount (exactly as `swap`).
fn walk_committed_ladder(quote_state: &QuoteState, side: SwapSide, net: u64) -> Result<u64> {
    let (side_levels, math_side) = match side {
        SwapSide::BuyBase => (&quote_state.ask_levels, MathSide::Ask),
        SwapSide::SellBase => (&quote_state.bid_levels, MathSide::Bid),
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
    Ok(result.out as u64)
}

/// Credit an already-charged fee to the insurance/keeper/protocol buckets for
/// the token the fee was charged in (`BuyBase` => quote, `SellBase` => base),
/// including the per-keeper reward PDA. Bookkeeping only: the tokens are already
/// in the vault reserve.
fn credit_fee_buckets(
    vault: &mut Vault,
    keeper_reward: &mut KeeperReward,
    side: SwapSide,
    fee: u64,
    config: &Config,
) -> Result<()> {
    let (insurance, keeper, protocol) = fee_split(fee, config);
    match side {
        SwapSide::BuyBase => {
            vault.insurance_quote = vault
                .insurance_quote
                .checked_add(insurance)
                .ok_or(ErrorCode::MathOverflow)?;
            vault.keeper_quote = vault
                .keeper_quote
                .checked_add(keeper)
                .ok_or(ErrorCode::MathOverflow)?;
            keeper_reward.quote = keeper_reward
                .quote
                .checked_add(keeper)
                .ok_or(ErrorCode::MathOverflow)?;
            vault.protocol_quote = vault
                .protocol_quote
                .checked_add(protocol)
                .ok_or(ErrorCode::MathOverflow)?;
        }
        SwapSide::SellBase => {
            vault.insurance_base = vault
                .insurance_base
                .checked_add(insurance)
                .ok_or(ErrorCode::MathOverflow)?;
            vault.keeper_base = vault
                .keeper_base
                .checked_add(keeper)
                .ok_or(ErrorCode::MathOverflow)?;
            keeper_reward.base = keeper_reward
                .base
                .checked_add(keeper)
                .ok_or(ErrorCode::MathOverflow)?;
            vault.protocol_base = vault
                .protocol_base
                .checked_add(protocol)
                .ok_or(ErrorCode::MathOverflow)?;
        }
    }
    Ok(())
}

/// Item 1a / Spec §5.9: roll the one-sided flow window on the slot clock, add
/// the operation's base leg, enforce the cumulative cap, and maintain the signed
/// net-base-sold accumulator. `net` is the ladder net input, `out` its output.
fn apply_flow_cap(
    config: &Config,
    quote_state: &mut QuoteState,
    clock_slot: u64,
    base_reserve_amount: u64,
    side: SwapSide,
    net: u64,
    out: u64,
) -> Result<()> {
    let window = config.flow_window_slots;
    if window > 0 && clock_slot >= quote_state.window_start_slot.saturating_add(window) {
        quote_state.window_start_slot = clock_slot;
        quote_state.window_base_sold = 0;
        quote_state.window_base_bought = 0;
    }
    let flow_cap = arb_math::mul_div_floor(
        base_reserve_amount as u128,
        config.max_window_flow_bps as u128,
        BPS_DENOM as u128,
    )
    .unwrap_or(0) as u64;
    let (base_sold, base_bought) = match side {
        SwapSide::BuyBase => (out, 0u64),
        SwapSide::SellBase => (0u64, net),
    };
    quote_state.window_base_sold = quote_state
        .window_base_sold
        .checked_add(base_sold)
        .ok_or(ErrorCode::MathOverflow)?;
    quote_state.window_base_bought = quote_state
        .window_base_bought
        .checked_add(base_bought)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        quote_state.window_base_sold <= flow_cap && quote_state.window_base_bought <= flow_cap,
        ErrorCode::FlowCapExceeded
    );
    match side {
        SwapSide::BuyBase => {
            quote_state.flow_n = quote_state.flow_n.saturating_add(out as i128);
        }
        SwapSide::SellBase => {
            quote_state.flow_n = quote_state.flow_n.saturating_sub(net as i128);
        }
    }
    Ok(())
}

/// h3: realized execution edge against the stored verified oracle, the rolling
/// window, and the pause-on-loss bound. May set `vault.status = PAUSED`.
#[allow(clippy::too_many_arguments)]
fn apply_edge(
    config: &Config,
    quote_state: &mut QuoteState,
    vault: &mut Vault,
    clock_slot: u64,
    side: SwapSide,
    amount_in: u64,
    out: u64,
    avail_base: u128,
    avail_quote: u128,
) {
    let oracle = quote_state.oracle_price;
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
    let edge_window = config.edge_window_slots;
    if quote_state.edge_window_start_slot == 0 {
        quote_state.edge_window_start_slot = clock_slot;
    } else if edge_window > 0
        && clock_slot
            >= quote_state
                .edge_window_start_slot
                .saturating_add(edge_window)
    {
        quote_state.edge_window_start_slot = clock_slot;
        quote_state.realized_edge = 0;
    }
    quote_state.realized_edge = quote_state.realized_edge.saturating_add(edge);
    let available_value = ((avail_base.saturating_mul(oracle)) >> 64).saturating_add(avail_quote);
    let loss_bound = available_value.saturating_mul(config.max_edge_loss_bps as u128) / 10_000;
    if quote_state.realized_edge < -(loss_bound as i128) {
        vault.status = PAUSED;
        emit!(EdgeBreakerTripped {
            slot: clock_slot,
            realized_edge: quote_state.realized_edge,
            bound: loss_bound
        });
    }
}

/// Plan produced by the `deposit_single` bisection solver.
struct SinglePlan {
    /// Swapped notional (gross, fee inclusive).
    s: u64,
    fee: u64,
    /// Ladder output of the internal swap (quote for `SellBase`, base for
    /// `BuyBase`).
    swap_out: u64,
    /// Base/quote deposited notionals (the post-swap imbalanced remainder).
    db: u64,
    dq: u64,
    shares: u64,
    /// `floor(db*S/Bnet') - floor(dq*S/Qnet')`; the bisection root.
    diff: i128,
}

/// Evaluate the balanced-deposit plan for a candidate swapped notional `s`.
/// Returns `None` when `s` is infeasible (ladder cannot absorb, or the
/// post-swap net reserve would be non-positive) so the bisection shrinks toward
/// feasible notionals.
#[allow(clippy::too_many_arguments)]
fn single_eval(
    config: &Config,
    quote_state: &QuoteState,
    side: SwapSide,
    amount_in: u64,
    s: u64,
    base_net: u64,
    quote_net: u64,
    total_shares: u64,
) -> Option<SinglePlan> {
    let (fee, s_net) = charge_fee(s, config.fee_bps).ok()?;
    let (swap_out, bnet2, qnet2, db, dq) = match side {
        SwapSide::SellBase => {
            let out = if s_net == 0 {
                0
            } else {
                walk_committed_ladder(quote_state, SwapSide::SellBase, s_net).ok()?
            };
            let bnet2 = base_net.checked_add(s_net)?;
            let qnet2 = quote_net.checked_sub(out)?;
            let db = amount_in.checked_sub(s)?;
            (out, bnet2, qnet2, db, out)
        }
        SwapSide::BuyBase => {
            let out = if s_net == 0 {
                0
            } else {
                walk_committed_ladder(quote_state, SwapSide::BuyBase, s_net).ok()?
            };
            let bnet2 = base_net.checked_sub(out)?;
            let qnet2 = quote_net.checked_add(s_net)?;
            let dq = amount_in.checked_sub(s)?;
            (out, bnet2, qnet2, out, dq)
        }
    };
    if bnet2 == 0 || qnet2 == 0 {
        return None;
    }
    let by_base = (db as u128)
        .checked_mul(total_shares as u128)?
        .checked_div(bnet2 as u128)?;
    let by_quote = (dq as u128)
        .checked_mul(total_shares as u128)?
        .checked_div(qnet2 as u128)?;
    let shares = by_base.min(by_quote);
    Some(SinglePlan {
        s,
        fee,
        swap_out,
        db,
        dq,
        shares: shares as u64,
        diff: by_base as i128 - by_quote as i128,
    })
}

/// Bounded integer bisection (`<= 64` steps) for the balanced swapped notional.
/// `diff(s)` is monotone (decreasing for `SellBase`, increasing for `BuyBase`),
/// so a binary search finds the crossing; the two integers adjacent to it are
/// then compared directly so the maximum-`min` plan is returned.
#[allow(clippy::too_many_arguments)]
fn solve_deposit_single(
    config: &Config,
    quote_state: &QuoteState,
    side: SwapSide,
    amount_in: u64,
    base_net: u64,
    quote_net: u64,
    total_shares: u64,
) -> Result<SinglePlan> {
    let eval = |s: u64| {
        single_eval(
            config,
            quote_state,
            side,
            amount_in,
            s,
            base_net,
            quote_net,
            total_shares,
        )
    };
    let mut lo = 0u64;
    let mut hi = amount_in;
    match side {
        SwapSide::SellBase => {
            // Find the largest `s` with `diff(s) >= 0`.
            while lo < hi {
                let mid = lo + (hi - lo).div_ceil(2);
                match eval(mid) {
                    Some(plan) if plan.diff >= 0 => lo = mid,
                    _ => hi = mid - 1,
                }
            }
        }
        SwapSide::BuyBase => {
            // Find the smallest `s` with `diff(s) >= 0`.
            while lo < hi {
                let mid = lo + (hi - lo) / 2;
                match eval(mid) {
                    Some(plan) if plan.diff >= 0 => hi = mid,
                    _ => lo = mid + 1,
                }
            }
        }
    }
    // Compare the crossing and its neighbours to pick the best integer plan.
    let mut best: Option<SinglePlan> = None;
    for delta in [0i64, -1, 1] {
        let candidate = lo as i64 + delta;
        if !(0..=amount_in as i64).contains(&candidate) {
            continue;
        }
        if let Some(plan) = eval(candidate as u64) {
            if best
                .as_ref()
                .map(|b| plan.shares > b.shares)
                .unwrap_or(true)
            {
                best = Some(plan);
            }
        }
    }
    best.ok_or_else(|| error!(ErrorCode::CapacityExceeded))
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
/// Single-token deposit (see `docs/SINGLE_SIDED_DESIGN.md`). `side` is the token
/// the user paid: `SellBase` = base in, `BuyBase` = quote in.
#[event]
pub struct DepositSingleEvent {
    pub slot: u64,
    pub version: u64,
    pub side: SwapSide,
    /// Total input pulled from the user (the swapped notional plus the
    /// deposited remainder).
    pub amount_in: u64,
    /// Internal swap notional (gross, fee inclusive) and its ladder output.
    pub swap_in: u64,
    pub swap_out: u64,
    pub fee: u64,
    pub base_deposited: u64,
    pub quote_deposited: u64,
    pub shares: u64,
}
/// Single-token withdrawal (see `docs/SINGLE_SIDED_DESIGN.md`). `side` is the
/// token the user receives: `BuyBase` = base out, `SellBase` = quote out.
#[event]
pub struct WithdrawSingleEvent {
    pub slot: u64,
    pub version: u64,
    pub side: SwapSide,
    pub shares: u64,
    pub base_out: u64,
    pub quote_out: u64,
    /// Internal swap notional (the unwanted leg, gross) and its ladder output.
    pub swap_in: u64,
    pub swap_out: u64,
    pub fee: u64,
    pub payout: u64,
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

/// The vault-bound volatility PDA was created.
#[event]
pub struct VolatilityInitialized {
    pub slot: u64,
    pub vault: Pubkey,
}

/// A timelocked volatility-parameter/activation change was proposed.
#[event]
pub struct VolatilityParamsProposed {
    pub slot: u64,
    pub vault: Pubkey,
    pub enabled: bool,
    pub activate_slot: u64,
}

/// A proposed volatility-parameter/activation change was applied (observation
/// state kept).
#[event]
pub struct VolatilityParamsApplied {
    pub slot: u64,
    pub vault: Pubkey,
    pub enabled: bool,
}

/// A verified, fresh Pyth observation advanced the on-chain EWMA/jump state.
#[event]
pub struct VolatilityObserved {
    pub slot: u64,
    pub publish_time: i64,
    pub short_ewma_q64: u128,
    pub medium_ewma_q64: u128,
    pub jump: bool,
    pub nonce: u64,
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
    #[msg("Invalid volatility parameters")]
    InvalidVolatilityParams,
    #[msg("Volatility exceeds the configured ceiling")]
    VolatilityTooHigh,
    #[msg("Quote spread is below the volatility-derived floor")]
    VolatilitySpreadTooLow,
    #[msg("Quote depth exceeds the volatility-derived cap")]
    DepthAboveVolatility,
    #[msg("Volatility observation publish time is not newer than the stored one")]
    StaleVolatilityObservation,
    #[msg("Volatility enforcement cannot activate before a verified observation exists")]
    VolatilityNotReady,
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

    #[test]
    fn volatility_params_validation_accepts_defaults() {
        validate_volatility_params(&DEFAULT_VOLATILITY_PARAMS).unwrap();
    }

    #[test]
    fn volatility_params_validation_rejects_bad_ranges() {
        let ok = DEFAULT_VOLATILITY_PARAMS;
        let mut p = ok;
        p.short_lambda_bps = 0;
        assert!(validate_volatility_params(&p).is_err());
        let mut p = ok;
        p.short_lambda_bps = 9_950;
        p.medium_lambda_bps = 9_900; // medium < short
        assert!(validate_volatility_params(&p).is_err());
        let mut p = ok;
        p.jump_multiple = 0;
        assert!(validate_volatility_params(&p).is_err());
        let mut p = ok;
        p.max_sigma_q64 = 0;
        assert!(validate_volatility_params(&p).is_err());
        let mut p = ok;
        p.vol_spread_coeff_bps = 10_001;
        assert!(validate_volatility_params(&p).is_err());
        let mut p = ok;
        p.vol_depth_coeff_bps = 10_001;
        assert!(validate_volatility_params(&p).is_err());
        let mut p = ok;
        p.max_observation_age_slots = 0;
        assert!(validate_volatility_params(&p).is_err());
    }

    #[test]
    fn mul_bps_ceil_rounds_up() {
        // 1 bps of 1 should round up to 1 rather than floor to 0.
        assert_eq!(mul_bps_ceil(1, 1), 1);
        assert_eq!(mul_bps_ceil(10_000, 0), 0);
        assert_eq!(mul_bps_ceil(10_000, 10_000), 10_000);
        assert_eq!(mul_bps_ceil(5, 2_000), 1);
    }

    fn volatility_state_for_test() -> VolatilityState {
        VolatilityState {
            vault: Pubkey::default(),
            short_ewma_q64: 0,
            medium_ewma_q64: 0,
            last_price_q64: 0,
            last_publish_time: 0,
            last_observation_slot: 0,
            observation_nonce: 0,
            jump_detected: false,
            jump_until_slot: 0,
            short_lambda_bps: DEFAULT_VOLATILITY_PARAMS.short_lambda_bps,
            medium_lambda_bps: DEFAULT_VOLATILITY_PARAMS.medium_lambda_bps,
            jump_multiple: DEFAULT_VOLATILITY_PARAMS.jump_multiple,
            max_sigma_q64: u128::MAX,
            jump_cooldown_slots: DEFAULT_VOLATILITY_PARAMS.jump_cooldown_slots,
            vol_spread_coeff_bps: 0,
            vol_depth_coeff_bps: 0,
            max_observation_age_slots: 100,
            enabled: false,
            bump: 0,
        }
    }

    #[test]
    fn volatility_guard_is_noop_when_disabled() {
        // Disabled: even an unset baseline and a zero spread pass.
        let vs = volatility_state_for_test();
        let update = QuoteUpdate::default();
        volatility_guard_core(2, &update, &vs, 0).unwrap();
    }

    #[test]
    fn volatility_guard_fails_closed_without_baseline_or_when_stale() {
        let mut vs = volatility_state_for_test();
        vs.enabled = true;
        let update = QuoteUpdate::default();
        // No baseline observation yet.
        assert!(volatility_guard_core(2, &update, &vs, 10).is_err());
        vs.last_price_q64 = 1 << 64;
        vs.last_observation_slot = 0;
        // Baseline present but observation older than the allowed age.
        assert!(volatility_guard_core(2, &update, &vs, 101).is_err());
        // Fresh enough: passes with a wide sigma ceiling and zero coefficients.
        volatility_guard_core(0, &update, &vs, 100).unwrap();
    }

    #[test]
    fn volatility_guard_enforces_kill_switch() {
        let mut vs = volatility_state_for_test();
        vs.enabled = true;
        vs.last_price_q64 = 1 << 64;
        vs.last_observation_slot = 5;
        vs.short_ewma_q64 = 1u128 << 64; // sigma = 1.0
        vs.max_sigma_q64 = 1u128 << 50; // ceiling below sigma
        let update = QuoteUpdate::default();
        assert!(volatility_guard_core(2, &update, &vs, 5).is_err());
    }

    #[test]
    fn volatility_guard_enforces_spread_floor_and_depth_cap() {
        let mut vs = volatility_state_for_test();
        vs.enabled = true;
        vs.last_price_q64 = 1 << 64;
        vs.last_observation_slot = 5;
        vs.short_ewma_q64 = 1u128 << 64; // sigma = 1.0 => sigma_bps = 10_000
        vs.max_sigma_q64 = u128::MAX;
        vs.vol_spread_coeff_bps = 1_000; // floor = 10_000 * 0.10 = 1_000 bps
        vs.vol_depth_coeff_bps = 2_000; // cap = 10_000 - 2_000 = 8_000 bps

        let too_low = QuoteUpdate {
            half_spread_bps: 999,
            depth_mult_bps: 8_000,
            ..QuoteUpdate::default()
        };
        assert!(volatility_guard_core(2, &too_low, &vs, 5).is_err());

        let too_deep = QuoteUpdate {
            half_spread_bps: 1_000,
            depth_mult_bps: 8_001,
            ..QuoteUpdate::default()
        };
        assert!(volatility_guard_core(2, &too_deep, &vs, 5).is_err());

        let compliant = QuoteUpdate {
            half_spread_bps: 1_000,
            depth_mult_bps: 8_000,
            ..QuoteUpdate::default()
        };
        volatility_guard_core(2, &compliant, &vs, 5).unwrap();
    }

    #[test]
    fn volatility_guard_jump_scales_effective_sigma() {
        let mut vs = volatility_state_for_test();
        vs.enabled = true;
        vs.last_price_q64 = 1 << 64;
        vs.last_observation_slot = 5;
        vs.short_ewma_q64 = 1u128 << 64; // sigma_bps = 10_000
        vs.vol_spread_coeff_bps = 1_000; // base floor = 1_000 bps
        vs.jump_multiple = 4;
        // A spread that clears the base floor but not the jump-multiplied floor.
        let update = QuoteUpdate {
            half_spread_bps: 2_000,
            depth_mult_bps: 10_000,
            ..QuoteUpdate::default()
        };
        volatility_guard_core(2, &update, &vs, 5).unwrap();
        vs.jump_detected = true; // effective sigma_bps = 40_000 => floor 4_000
        assert!(volatility_guard_core(2, &update, &vs, 5).is_err());
    }

    #[test]
    fn pending_volatility_account_len_matches_layout() {
        // 32 + 8 + params (52) + enabled (1) + bump (1).
        assert_eq!(PENDING_VOLATILITY_LEN, 94);
    }

    /// A `QuoteState` with one valid ladder level on each side (price in [1, 4]),
    /// used to produce integer golden vectors for the frontend mirror.
    fn single_sided_vector_state() -> QuoteState {
        let level = Level {
            offset_bps: 0,
            weight_bps: 10_000,
            sqrt_lo: 1u128 << 64,
            sqrt_hi: 2u128 << 64,
            liquidity: 10u128.pow(28),
        };
        let mut ask = [Level::default(); LEVELS];
        let mut bid = [Level::default(); LEVELS];
        ask[0] = level;
        bid[0] = level;
        QuoteState {
            version: 1,
            update_slot: 0,
            expiry_slot: 0,
            anchor_sqrt_price: 0,
            p_res_sqrt: 0,
            half_spread_bps: 0,
            ask_extra_bps: 0,
            bid_extra_bps: 0,
            depth_mult_bps: 10_000,
            window_start_slot: 0,
            window_base_sold: 0,
            window_base_bought: 0,
            oracle_publish_time: 0,
            oracle_conf_bps: 0,
            oracle_price: 0,
            edge_window_start_slot: 0,
            realized_edge: 0,
            flow_n: 0,
            ask_levels: ask,
            bid_levels: bid,
            bump: 0,
            keeper: Pubkey::default(),
        }
    }

    /// A `Config` with only `fee_bps` relevant to the single-sided solver.
    fn single_sided_vector_config() -> Config {
        Config {
            admin: Pubkey::default(),
            keeper: Pubkey::default(),
            treasury: Pubkey::default(),
            pyth_feed_id: [0u8; 32],
            fee_bps: 30,
            insurance_bps: 3333,
            keeper_bps: 3333,
            protocol_bps: 3334,
            min_liquidity: 0,
            warmup_slots: 0,
            epoch_slots: 216_000,
            grace_slots: 9_000,
            expiry_slots: 120,
            max_staleness_seconds: 2,
            max_conf_bps: 10,
            max_anchor_step_bps: 50,
            max_spread_step_bps: 10,
            min_spread_bps: 2,
            max_spread_bps: 50,
            max_quote_size: 1_000_000_000,
            max_inventory_bps: 6000,
            utilization_max_bps: 9000,
            min_bond: 0,
            unbond_cooldown_slots: 216_000,
            max_update_slot_age: 25,
            edge_window_slots: 216_000,
            max_edge_loss_bps: 50,
            max_anchor_dev_bps: 25,
            flow_window_slots: 216_000,
            max_window_flow_bps: 10_000,
            pending_admin: Pubkey::default(),
            admin_activate_slot: 0,
            bump: 0,
        }
    }

    #[test]
    fn single_sided_golden_vectors() {
        let qs = single_sided_vector_state();
        let config = single_sided_vector_config();
        let (fee_bps, amount_in, base_net, quote_net, total_shares) = (
            30u16,
            100_000_000u64,
            1_000_000_000u64,
            2_000_000_000u64,
            1_000_000_000u64,
        );
        assert_eq!(config.fee_bps, fee_bps);
        for (name, side) in [
            ("sellBase", SwapSide::SellBase),
            ("buyBase", SwapSide::BuyBase),
        ] {
            let plan = solve_deposit_single(
                &config,
                &qs,
                side,
                amount_in,
                base_net,
                quote_net,
                total_shares,
            )
            .expect("vector must be feasible");
            println!(
                "VECTOR {name} s={} fee={} swap_out={} db={} dq={} shares={} diff={}",
                plan.s, plan.fee, plan.swap_out, plan.db, plan.dq, plan.shares, plan.diff
            );
            // Conservation and no-dilution invariants, independent of the exact root.
            assert_eq!(
                plan.fee as u128,
                ((plan.s as u128 * fee_bps as u128) + 9_999) / 10_000
            );
            match side {
                SwapSide::SellBase => {
                    assert_eq!(plan.db + plan.s, amount_in);
                    assert_eq!(plan.dq, plan.swap_out);
                    let by_base = plan.db as u128 * total_shares as u128
                        / (base_net as u128 + (plan.s - plan.fee) as u128);
                    let by_quote = plan.dq as u128 * total_shares as u128
                        / (quote_net as u128 - plan.swap_out as u128);
                    assert!(plan.shares as u128 <= by_base && plan.shares as u128 <= by_quote);
                }
                SwapSide::BuyBase => {
                    assert_eq!(plan.dq + plan.s, amount_in);
                    assert_eq!(plan.db, plan.swap_out);
                    let by_base = plan.db as u128 * total_shares as u128
                        / (base_net as u128 - plan.swap_out as u128);
                    let by_quote = plan.dq as u128 * total_shares as u128
                        / (quote_net as u128 + (plan.s - plan.fee) as u128);
                    assert!(plan.shares as u128 <= by_base && plan.shares as u128 <= by_quote);
                }
            }
        }
    }

    #[test]
    fn single_sided_withdraw_golden_vectors() {
        let qs = single_sided_vector_state();
        let (fee_bps, shares, total_shares, base_net, quote_net) = (
            30u16,
            100_000_000u64,
            1_000_000_000u64,
            1_000_000_000u64,
            2_000_000_000u64,
        );
        let base_out = shares as u128 * base_net as u128 / total_shares as u128;
        let quote_out = shares as u128 * quote_net as u128 / total_shares as u128;
        for (name, side) in [
            ("buyBase", SwapSide::BuyBase),
            ("sellBase", SwapSide::SellBase),
        ] {
            let unwanted = match side {
                SwapSide::BuyBase => quote_out,
                SwapSide::SellBase => base_out,
            } as u64;
            let (fee, net) = charge_fee(unwanted, fee_bps).unwrap();
            let converted = if net > 0 {
                walk_committed_ladder(&qs, side, net).unwrap()
            } else {
                0
            };
            let payout = match side {
                SwapSide::BuyBase => base_out as u64 + converted,
                SwapSide::SellBase => quote_out as u64 + converted,
            };
            println!(
                "WITHDRAW {name} base_out={base_out} quote_out={quote_out} unwanted={unwanted} fee={fee} net={net} converted={converted} payout={payout}"
            );
            assert_eq!(
                fee as u128,
                (unwanted as u128 * fee_bps as u128 + 9_999) / 10_000
            );
        }
    }

    // --- Task 2: Python reference differential, 100k brute force, fuzz -------

    type Vectors = Vec<std::collections::HashMap<&'static str, &'static str>>;

    /// Parse the Python-generated single-sided golden vectors
    /// (`simulation/reference/single_sided_golden.py`).
    fn load_single_sided_vectors() -> Vectors {
        const TEXT: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/single_sided_vectors.txt"
        ));
        let mut out = Vectors::new();
        for line in TEXT.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut map = std::collections::HashMap::new();
            for (i, part) in line.split('|').enumerate() {
                if i == 0 {
                    map.insert("kind", part);
                } else if let Some((k, v)) = part.split_once('=') {
                    map.insert(k, v);
                }
            }
            out.push(map);
        }
        out
    }

    fn field_u(map: &std::collections::HashMap<&'static str, &'static str>, key: &str) -> u128 {
        map.get(key)
            .copied()
            .unwrap_or_else(|| panic!("missing {key}"))
            .parse()
            .expect("u128 field")
    }

    fn field_i(map: &std::collections::HashMap<&'static str, &'static str>, key: &str) -> i128 {
        map.get(key)
            .copied()
            .unwrap_or_else(|| panic!("missing {key}"))
            .parse()
            .expect("i128 field")
    }

    fn vector_state(map: &std::collections::HashMap<&'static str, &'static str>) -> QuoteState {
        let nlev = field_u(map, "nlev") as usize;
        let mut ask = [Level::default(); LEVELS];
        let mut bid = [Level::default(); LEVELS];
        for i in 0..nlev {
            let level = Level {
                offset_bps: 0,
                weight_bps: 0,
                sqrt_lo: field_u(map, &format!("lo{i}")),
                sqrt_hi: field_u(map, &format!("hi{i}")),
                liquidity: field_u(map, &format!("liq{i}")),
            };
            ask[i] = level;
            bid[i] = level;
        }
        let mut qs = single_sided_vector_state();
        qs.ask_levels = ask;
        qs.bid_levels = bid;
        qs
    }

    fn vector_side(map: &std::collections::HashMap<&'static str, &'static str>) -> SwapSide {
        match map["side"] {
            "sellBase" => SwapSide::SellBase,
            _ => SwapSide::BuyBase,
        }
    }

    fn single_sided_lcg(state: &mut u128) -> u128 {
        *state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *state
    }

    /// The independent Python reference (`simulation/reference/single_sided.py`)
    /// must agree with the on-chain solver and the withdraw amount plan on every
    /// generated vector. This is the cross-language differential for Task 2.
    #[test]
    fn single_sided_python_differential() {
        let vectors = load_single_sided_vectors();
        assert!(
            vectors.len() >= 500,
            "expected >=500 vectors, got {}",
            vectors.len()
        );
        let (mut deposits, mut withdraws) = (0u32, 0u32);
        for map in &vectors {
            let qs = vector_state(map);
            let side = vector_side(map);
            let mut config = single_sided_vector_config();
            config.fee_bps = field_u(map, "fee_bps") as u16;
            match map["kind"] {
                "deposit" => {
                    let plan = solve_deposit_single(
                        &config,
                        &qs,
                        side,
                        field_u(map, "amount_in") as u64,
                        field_u(map, "base_net") as u64,
                        field_u(map, "quote_net") as u64,
                        field_u(map, "total_shares") as u64,
                    )
                    .expect("vector must be feasible");
                    assert_eq!(plan.s as u128, field_u(map, "s"));
                    assert_eq!(plan.fee as u128, field_u(map, "fee"));
                    assert_eq!(plan.swap_out as u128, field_u(map, "swap_out"));
                    assert_eq!(plan.db as u128, field_u(map, "db"));
                    assert_eq!(plan.dq as u128, field_u(map, "dq"));
                    assert_eq!(plan.shares as u128, field_u(map, "shares"));
                    assert_eq!(plan.diff, field_i(map, "diff"));
                    deposits += 1;
                }
                "withdraw" => {
                    let total = field_u(map, "total_shares");
                    let shares = field_u(map, "shares");
                    let base_out = (shares * field_u(map, "base_net") / total) as u64;
                    let quote_out = (shares * field_u(map, "quote_net") / total) as u64;
                    let unwanted = match side {
                        SwapSide::BuyBase => quote_out,
                        SwapSide::SellBase => base_out,
                    };
                    let (fee, net) = charge_fee(unwanted, config.fee_bps).unwrap();
                    let converted = if net > 0 {
                        walk_committed_ladder(&qs, side, net).unwrap()
                    } else {
                        0
                    };
                    let payout = match side {
                        SwapSide::BuyBase => base_out + converted,
                        SwapSide::SellBase => quote_out + converted,
                    };
                    assert_eq!(base_out as u128, field_u(map, "base_out"));
                    assert_eq!(quote_out as u128, field_u(map, "quote_out"));
                    assert_eq!(unwanted as u128, field_u(map, "unwanted"));
                    assert_eq!(fee as u128, field_u(map, "fee"));
                    assert_eq!(net as u128, field_u(map, "net"));
                    assert_eq!(converted as u128, field_u(map, "converted"));
                    assert_eq!(payout as u128, field_u(map, "payout"));
                    withdraws += 1;
                }
                other => panic!("unknown vector kind {other}"),
            }
        }
        assert!(
            deposits >= 200 && withdraws >= 100,
            "insufficient coverage: {deposits} deposit / {withdraws} withdraw"
        );
    }

    /// 100,000-case brute-force differential: the bisection solver must return
    /// the same maximum-`min` plan as an exhaustive scan over every `s` on a
    /// small domain. Independent of the golden vectors.
    #[test]
    fn single_sided_solver_matches_brute_force_100k() {
        let lo = 1u128 << 64;
        let hi = 2u128 << 64;
        let mut state = 0x5eed_1234_abcd_9876_u128;
        let mut checked = 0u64;
        for _ in 0..100_000 {
            let capacity = 64u64 + (single_sided_lcg(&mut state) % 64) as u64;
            let level = Level {
                offset_bps: 0,
                weight_bps: 10_000,
                sqrt_lo: lo,
                sqrt_hi: hi,
                liquidity: capacity as u128 * (1u128 << 64),
            };
            let mut ask = [Level::default(); LEVELS];
            let mut bid = [Level::default(); LEVELS];
            ask[0] = level;
            bid[0] = level;
            let qs = QuoteState {
                ask_levels: ask,
                bid_levels: bid,
                ..single_sided_vector_state()
            };
            let side = if single_sided_lcg(&mut state) & 1 == 0 {
                SwapSide::SellBase
            } else {
                SwapSide::BuyBase
            };
            let fee_bps =
                [0u16, 1, 5, 10, 30, 50, 100][(single_sided_lcg(&mut state) % 7) as usize];
            let amount_in = 1 + (single_sided_lcg(&mut state) % 32) as u64;
            let base_net = 1_000 + (single_sided_lcg(&mut state) % 1_000_000) as u64;
            let quote_net = 1_000 + (single_sided_lcg(&mut state) % 1_000_000) as u64;
            let total_shares = 1_000 + (single_sided_lcg(&mut state) % 1_000_000) as u64;
            let mut config = single_sided_vector_config();
            config.fee_bps = fee_bps;

            let mut brute_best = 0u64;
            for s in 0..=amount_in {
                if let Some(plan) = single_eval(
                    &config,
                    &qs,
                    side,
                    amount_in,
                    s,
                    base_net,
                    quote_net,
                    total_shares,
                ) {
                    brute_best = brute_best.max(plan.shares);
                }
            }
            let solved = solve_deposit_single(
                &config,
                &qs,
                side,
                amount_in,
                base_net,
                quote_net,
                total_shares,
            )
            .expect("capacity bounds every candidate so the solver is feasible");
            let side_name = match side {
                SwapSide::SellBase => "sellBase",
                SwapSide::BuyBase => "buyBase",
            };
            assert_eq!(
                solved.shares, brute_best,
                "solver {} != brute {brute_best} (side {side_name}, C {capacity}, fee {fee_bps}, in {amount_in})",
                solved.shares
            );
            checked += 1;
        }
        assert_eq!(checked, 100_000);
    }

    /// Fuzz invariants over wide ranges: conservation, no value from nothing,
    /// vault-favouring rounding, and solver local optimality.
    #[test]
    fn single_sided_fuzz_invariants() {
        let mut state = 0xc0ffee_0bad_f00d_u128;
        for _ in 0..20_000 {
            let nlev = 1 + (single_sided_lcg(&mut state) % 3) as usize;
            let mut ask = [Level::default(); LEVELS];
            let mut bid = [Level::default(); LEVELS];
            let mut sqrt = 1u128 << 64;
            for i in 0..nlev {
                let width = (single_sided_lcg(&mut state) % (1u128 << 64)) + 1;
                let level = Level {
                    offset_bps: 0,
                    weight_bps: 10_000,
                    sqrt_lo: sqrt,
                    sqrt_hi: sqrt + width,
                    liquidity: 10u128.pow(18 + (single_sided_lcg(&mut state) % 7) as u32),
                };
                ask[i] = level;
                bid[i] = level;
                sqrt += width;
            }
            let qs = QuoteState {
                ask_levels: ask,
                bid_levels: bid,
                ..single_sided_vector_state()
            };
            let side = if single_sided_lcg(&mut state) & 1 == 0 {
                SwapSide::SellBase
            } else {
                SwapSide::BuyBase
            };
            let mut config = single_sided_vector_config();
            config.fee_bps =
                [0u16, 1, 5, 10, 30, 50, 100][(single_sided_lcg(&mut state) % 7) as usize];
            let base_net = 10_000 + (single_sided_lcg(&mut state) % 10u128.pow(12)) as u64;
            let quote_net = 10_000 + (single_sided_lcg(&mut state) % 10u128.pow(12)) as u64;
            let total_shares = 10_000 + (single_sided_lcg(&mut state) % 10u128.pow(12)) as u64;
            // A modest notional keeps the internal swap feasible on this ladder.
            let amount_in = 1 + (single_sided_lcg(&mut state) % 10_000) as u64;
            if let Ok(plan) = solve_deposit_single(
                &config,
                &qs,
                side,
                amount_in,
                base_net,
                quote_net,
                total_shares,
            ) {
                // Fee is exactly the swap fee.
                assert_eq!(
                    plan.fee as u128,
                    (plan.s as u128 * config.fee_bps as u128 + 9_999) / 10_000
                );
                if plan.s > 0 {
                    assert!(plan.fee <= plan.s);
                }
                match side {
                    SwapSide::SellBase => {
                        assert_eq!(plan.db + plan.s, amount_in);
                        assert_eq!(plan.dq, plan.swap_out);
                    }
                    SwapSide::BuyBase => {
                        assert_eq!(plan.dq + plan.s, amount_in);
                        assert_eq!(plan.db, plan.swap_out);
                    }
                }
                // Shares never exceed the proportional floors (no dilution).
                if let Some(eval) = single_eval(
                    &config,
                    &qs,
                    side,
                    amount_in,
                    plan.s,
                    base_net,
                    quote_net,
                    total_shares,
                ) {
                    assert_eq!(eval.shares, plan.shares);
                    let local = [
                        plan.s.saturating_sub(1),
                        plan.s,
                        (plan.s + 1).min(amount_in),
                    ];
                    for cand in local {
                        if let Some(p) = single_eval(
                            &config,
                            &qs,
                            side,
                            amount_in,
                            cand,
                            base_net,
                            quote_net,
                            total_shares,
                        ) {
                            assert!(p.shares <= plan.shares, "solver not locally maximal");
                        }
                    }
                }
                // A withdraw plan built from the same state: fee matches the
                // swap fee and the payout is never below the wanted leg alone.
                let shares = 1 + (single_sided_lcg(&mut state) % total_shares as u128) as u64;
                let base_out = (shares as u128 * base_net as u128 / total_shares as u128) as u64;
                let quote_out = (shares as u128 * quote_net as u128 / total_shares as u128) as u64;
                let unwanted = match side {
                    SwapSide::BuyBase => quote_out,
                    SwapSide::SellBase => base_out,
                };
                let (fee, net) = charge_fee(unwanted, config.fee_bps).unwrap();
                assert_eq!(
                    fee as u128,
                    (unwanted as u128 * config.fee_bps as u128 + 9_999) / 10_000
                );
                let wanted = match side {
                    SwapSide::BuyBase => base_out,
                    SwapSide::SellBase => quote_out,
                };
                if net > 0 {
                    if let Ok(converted) = walk_committed_ladder(&qs, side, net) {
                        assert!(wanted.saturating_add(converted) >= wanted);
                    }
                }
            }
        }
    }
}
