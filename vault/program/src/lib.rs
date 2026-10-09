#![allow(unexpected_cfgs)] // Anchor macros emit `cfg(target_os="solana")`

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};
use arb_math::{walk_ladder, Level as MathLevel, Side as MathSide};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

declare_id!("E8ptkpV626P2neR8v4Q9UCFHoD6AMAH2aTRsEQiNDN3U");

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
/// p2-T4: the permissionless breaker trips when the stored oracle publish time
/// is older than this multiple of `max_staleness_seconds`. Stored state only.
const STALENESS_TRIP_MULTIPLE: i64 = 2;

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
        config.bump = ctx.bumps.config;

        ctx.accounts.quote_state.bump = ctx.bumps.quote_state;
        ctx.accounts.quote_state.version = 0;
        ctx.accounts.quote_state.update_slot = 0;
        ctx.accounts.quote_state.expiry_slot = 0;
        ctx.accounts.quote_state.window_start_slot = 0;
        ctx.accounts.quote_state.window_base_sold = 0;
        ctx.accounts.quote_state.window_base_bought = 0;
        ctx.accounts.quote_state.ask_levels = [Level::default(); LEVELS];
        ctx.accounts.quote_state.bid_levels = [Level::default(); LEVELS];
        emit!(VaultInitialized {
            slot: Clock::get()?.slot,
            vault: vault.key()
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
        require!(
            ctx.accounts.keeper.key() == ctx.accounts.config.keeper,
            ErrorCode::NotKeeper
        );
        // D-07: when a minimum bond is configured, the keeper must be bonded.
        // The PDA derivation only runs when bonding is enabled, so the MVP
        // allowlist path keeps the update CU low (the `keeper_bond` account is
        // unvalidated in the context for exactly this reason).
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
        require!(
            update.oracle_price > 0 && update.oracle_publish_time >= 0,
            ErrorCode::InvalidPrice
        );
        let feed = ctx.accounts.config.pyth_feed_id;
        require!(
            ctx.accounts.config.max_staleness_seconds >= 0,
            ErrorCode::InvalidOracle
        );
        let price = ctx
            .accounts
            .price_update
            .get_price_no_older_than(
                &clock,
                ctx.accounts.config.max_staleness_seconds as u64,
                &feed,
            )
            .map_err(|_| error!(ErrorCode::InvalidOracle))?;
        require!(
            price.price > 0 && price.publish_time == update.oracle_publish_time,
            ErrorCode::InvalidOracle
        );
        let pyth_price_q64 =
            pyth_price_q64(price.price, price.exponent).ok_or(ErrorCode::InvalidOracle)?;
        require!(
            pyth_price_q64 == update.oracle_price,
            ErrorCode::OraclePriceMismatch
        );
        let decoded_conf_bps = ((price.conf as u128)
            .saturating_mul(10_000)
            .saturating_add(price.price as u128 - 1)
            / price.price as u128) as u32;
        require!(
            decoded_conf_bps <= ctx.accounts.config.max_conf_bps
                && update.oracle_conf_bps == decoded_conf_bps,
            ErrorCode::WideConfidence
        );
        require!(
            update.half_spread_bps >= ctx.accounts.config.min_spread_bps
                && update.half_spread_bps <= ctx.accounts.config.max_spread_bps,
            ErrorCode::SpreadOutOfBounds
        );
        if ctx.accounts.quote_state.anchor_sqrt_price > 0 {
            let old = ctx.accounts.quote_state.anchor_sqrt_price;
            let diff = update.anchor_sqrt_price.abs_diff(old);
            require!(
                diff.saturating_mul(10_000)
                    <= old.saturating_mul(ctx.accounts.config.max_anchor_step_bps as u128),
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
        let anchor_price = arb_math::price_from_sqrt(update.anchor_sqrt_price)
            .map_err(|_| ErrorCode::InvalidPrice)?;
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
        let oracle_price = update.oracle_price; // Q64 price, == Pyth, > 0 (checked)
        let anchor_dev = anchor_price.abs_diff(oracle_price);
        require!(
            anchor_dev.saturating_mul(BPS_DENOM as u128)
                <= oracle_price.saturating_mul(ctx.accounts.config.max_anchor_dev_bps as u128),
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
        let inventory = ctx.accounts.config.max_inventory_bps.min(BPS_DENOM - 1);
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
            let lo =
                arb_math::price_from_sqrt(level.sqrt_lo).map_err(|_| ErrorCode::InvalidPrice)?;
            let hi =
                arb_math::price_from_sqrt(level.sqrt_hi).map_err(|_| ErrorCode::InvalidPrice)?;
            require!(
                lo.saturating_add(band_epsilon) >= lower
                    && hi <= upper.saturating_add(band_epsilon),
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
        let available_base = ctx
            .accounts
            .base_reserve
            .amount
            .saturating_sub(ctx.accounts.vault.insurance_base)
            .saturating_sub(ctx.accounts.vault.keeper_base)
            .saturating_sub(ctx.accounts.vault.protocol_base) as u128;
        let available_quote =
            ctx.accounts
                .quote_reserve
                .amount
                .saturating_sub(ctx.accounts.vault.insurance_quote)
                .saturating_sub(ctx.accounts.vault.keeper_quote)
                .saturating_sub(ctx.accounts.vault.protocol_quote) as u128;
        let utilization = ctx.accounts.config.utilization_max_bps as u128;
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
        let quote = &mut ctx.accounts.quote_state;
        quote.version = quote
            .version
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;
        let version = quote.version;
        quote.update_slot = update.update_slot;
        quote.expiry_slot = clock
            .slot
            .checked_add(ctx.accounts.config.expiry_slots)
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
        quote.oracle_price = update.oracle_price;
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
        let config = &mut ctx.accounts.config;
        config.fee_bps = update.fee_bps;
        config.insurance_bps = update.insurance_bps;
        config.keeper_bps = update.keeper_bps;
        config.protocol_bps = update.protocol_bps;
        config.max_staleness_seconds = update.max_staleness_seconds;
        config.max_conf_bps = update.max_conf_bps;
        config.max_anchor_step_bps = update.max_anchor_step_bps;
        config.min_spread_bps = update.min_spread_bps;
        config.max_spread_bps = update.max_spread_bps;
        config.max_quote_size = update.max_quote_size;
        config.max_inventory_bps = update.max_inventory_bps;
        config.utilization_max_bps = update.utilization_max_bps;
        config.min_bond = update.min_bond;
        config.unbond_cooldown_slots = update.unbond_cooldown_slots;
        config.max_update_slot_age = update.max_update_slot_age;
        config.edge_window_slots = update.edge_window_slots;
        config.max_edge_loss_bps = update.max_edge_loss_bps;
        config.max_anchor_dev_bps = update.max_anchor_dev_bps;
        config.flow_window_slots = update.flow_window_slots;
        config.max_window_flow_bps = update.max_window_flow_bps;
        if let Some(new_keeper) = update.keeper {
            config.keeper = new_keeper;
        }
        ctx.accounts.pending_config.activate_slot = u64::MAX;
        emit!(ParamsApplied {
            slot: Clock::get()?.slot
        });
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
        require!(
            ctx.accounts.keeper.key() == ctx.accounts.config.keeper,
            ErrorCode::NotKeeper
        );
        let base_reward = ctx.accounts.vault.keeper_base;
        let quote_reward = ctx.accounts.vault.keeper_quote;
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
        ctx.accounts.vault.keeper_base = 0;
        ctx.accounts.vault.keeper_quote = 0;
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
        // see docs/AUDIT_FULL.md.)
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct ParamsUpdate {
    pub fee_bps: u16,
    pub insurance_bps: u16,
    pub keeper_bps: u16,
    pub protocol_bps: u16,
    pub max_staleness_seconds: i64,
    pub max_conf_bps: u32,
    pub max_anchor_step_bps: u32,
    pub min_spread_bps: u32,
    pub max_spread_bps: u32,
    pub max_quote_size: u64,
    pub max_inventory_bps: u32,
    pub utilization_max_bps: u32,
    pub min_bond: u64,
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
    /// Item 5: optional keeper rotation, applied (timelocked) when set.
    pub keeper: Option<Pubkey>,
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
    pub oracle_price: u128,
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
    pub ask_levels: [Level; LEVELS],
    pub bid_levels: [Level; LEVELS],
    pub bump: u8,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct Level {
    pub offset_bps: u32,
    pub weight_bps: u32,
    pub sqrt_lo: u128,
    pub sqrt_hi: u128,
    pub liquidity: u128,
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
    #[account(seeds = [b"config", vault.key().as_ref()], bump, init, payer = admin, space = 8 + 32*4 + 2*4 + 8*8 + 4*6 + 8 + 4 + 1 + 4 + 4 + 8 + 4 + 8 + 4)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"quote", vault.key().as_ref()], bump, init, payer = admin, space = 8 + 8*6 + 16*2 + 4*5 + 16 + 8 + 4 + 16 + 8 + 16 + (4+4+16+16+16)*LEVELS + (4+4+16+16+16)*LEVELS + 1)]
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
    #[account(seeds=[b"config", vault.key().as_ref()], bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
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
    #[account(init_if_needed, payer=admin, space=8+32+8+129+1, seeds=[b"pending", vault.key().as_ref()], bump)]
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

#[event]
pub struct VaultInitialized {
    pub slot: u64,
    pub vault: Pubkey,
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
