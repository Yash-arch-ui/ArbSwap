use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};
use arb_math::{walk_ladder, Level as MathLevel, Side as MathSide};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

declare_id!("E8ptkpV626P2neR8v4Q9UCFHoD6AMAH2aTRsEQiNDN3U");

const LEVELS: usize = 6;
const ACTIVE: u8 = 0;
const PAUSED: u8 = 1;
const WIND_DOWN: u8 = 2;

#[program]
pub mod arbswap {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>, params: InitParams) -> Result<()> {
        require!(params.base_mint != params.quote_mint, ErrorCode::InvalidMint);
        require!(params.min_liquidity > 0, ErrorCode::InvalidParams);
        require!((params.insurance_bps as u32).saturating_add(params.keeper_bps as u32).saturating_add(params.protocol_bps as u32) <= 10_000, ErrorCode::InvalidParams);
        require!(params.weights_bps.iter().map(|v| *v as u64).sum::<u64>() == 10_000, ErrorCode::InvalidWeights);
        require!(params.offsets_bps.windows(2).all(|w| w[0] < w[1]), ErrorCode::InvalidLadder);
        require!(params.expiry_slots > params.grace_slots, ErrorCode::InvalidParams);
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
        config.max_spread_bps = params.max_spread_bps;
        config.max_quote_size = params.max_quote_size;
        config.max_inventory_bps = params.max_inventory_bps;
        config.bump = ctx.bumps.config;

        ctx.accounts.quote_state.bump = ctx.bumps.quote_state;
        ctx.accounts.quote_state.version = 0;
        ctx.accounts.quote_state.update_slot = 0;
        ctx.accounts.quote_state.expiry_slot = 0;
        ctx.accounts.quote_state.flow_n = 0;
        ctx.accounts.quote_state.levels = [Level::default(); LEVELS];
        emit!(VaultInitialized { slot: Clock::get()?.slot, vault: vault.key() });
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, base_amount: u64, quote_amount: u64, min_shares: u64) -> Result<()> {
        require!(ctx.accounts.vault.status == ACTIVE, ErrorCode::Paused);
        require!(base_amount > 0 && quote_amount > 0, ErrorCode::InvalidAmount);
        let total_shares = ctx.accounts.vault.total_shares;
        let shares = if total_shares == 0 {
            let root = integer_sqrt((base_amount as u128).checked_mul(quote_amount as u128).ok_or(ErrorCode::MathOverflow)?)
                .checked_sub(ctx.accounts.config.min_liquidity as u128).ok_or(ErrorCode::InvalidAmount)? as u64;
            require!(root > 0, ErrorCode::InvalidAmount);
            let lock = ctx.accounts.config.min_liquidity;
            if lock > 0 {
                let bump = [ctx.accounts.vault.bump];
                let seeds: &[&[u8]] = &[b"vault", ctx.accounts.vault.base_mint.as_ref(), ctx.accounts.vault.quote_mint.as_ref(), &bump];
                token::mint_to(CpiContext::new_with_signer(ctx.accounts.token_program.key(), MintTo { mint: ctx.accounts.share_mint.to_account_info(), to: ctx.accounts.share_lock.to_account_info(), authority: ctx.accounts.vault.to_account_info() }, &[seeds]), lock)?;
            }
            root
        } else {
            let by_base = (base_amount as u128).checked_mul(total_shares as u128).ok_or(ErrorCode::MathOverflow)?
                .checked_div(ctx.accounts.base_reserve.amount.saturating_sub(ctx.accounts.vault.insurance_base).saturating_sub(ctx.accounts.vault.keeper_base).saturating_sub(ctx.accounts.vault.protocol_base) as u128).ok_or(ErrorCode::MathOverflow)?;
            let by_quote = (quote_amount as u128).checked_mul(total_shares as u128).ok_or(ErrorCode::MathOverflow)?
                .checked_div(ctx.accounts.quote_reserve.amount.saturating_sub(ctx.accounts.vault.insurance_quote).saturating_sub(ctx.accounts.vault.keeper_quote).saturating_sub(ctx.accounts.vault.protocol_quote) as u128).ok_or(ErrorCode::MathOverflow)?;
            by_base.min(by_quote) as u64
        };
        require!(shares >= min_shares, ErrorCode::SlippageExceeded);
        token::transfer(ctx.accounts.base_transfer_ctx(), base_amount)?;
        token::transfer(ctx.accounts.quote_transfer_ctx(), quote_amount)?;
        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[b"vault", ctx.accounts.vault.base_mint.as_ref(), ctx.accounts.vault.quote_mint.as_ref(), &bump];
        token::mint_to(CpiContext::new_with_signer(ctx.accounts.token_program.key(), MintTo { mint: ctx.accounts.share_mint.to_account_info(), to: ctx.accounts.user_shares.to_account_info(), authority: ctx.accounts.vault.to_account_info() }, &[seeds]), shares)?;
        if total_shares == 0 {
            ctx.accounts.vault.total_shares = shares.checked_add(ctx.accounts.config.min_liquidity).ok_or(ErrorCode::MathOverflow)?;
        }
        let ticket = &mut ctx.accounts.deposit_ticket;
        ticket.owner = ctx.accounts.user.key();
        ticket.shares = shares;
        ticket.activate_slot = Clock::get()?.slot.checked_add(ctx.accounts.config.warmup_slots).ok_or(ErrorCode::MathOverflow)?;
        ticket.bump = ctx.bumps.deposit_ticket;
        emit!(DepositEvent { slot: Clock::get()?.slot, shares, base_amount, quote_amount });
        Ok(())
    }

    pub fn request_withdraw(ctx: Context<RequestWithdraw>, shares: u64) -> Result<()> {
        require!(shares > 0 && shares <= ctx.accounts.user_shares.amount, ErrorCode::InvalidAmount);
        require!(Clock::get()?.slot >= ctx.accounts.deposit_ticket.activate_slot, ErrorCode::WarmupNotElapsed);
        token::transfer(ctx.accounts.queue_transfer_ctx(), shares)?;
        let ticket = &mut ctx.accounts.withdraw_ticket;
        ticket.owner = ctx.accounts.user.key();
        ticket.shares = shares;
        ticket.epoch = ctx.accounts.vault.epoch.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
        ticket.bump = ctx.bumps.withdraw_ticket;
        emit!(WithdrawRequested { slot: Clock::get()?.slot, shares, epoch: ticket.epoch });
        Ok(())
    }

    pub fn crank_epoch(ctx: Context<CrankEpoch>) -> Result<()> {
        let now = Clock::get()?.slot;
        require!(now >= ctx.accounts.vault.epoch_start.checked_add(ctx.accounts.config.epoch_slots).ok_or(ErrorCode::MathOverflow)?, ErrorCode::EpochNotReached);
        ctx.accounts.vault.epoch = ctx.accounts.vault.epoch.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
        ctx.accounts.vault.epoch_start = now;
        Ok(())
    }

    pub fn claim_withdraw(ctx: Context<ClaimWithdraw>) -> Result<()> {
        require!(ctx.accounts.withdraw_ticket.epoch <= ctx.accounts.vault.epoch, ErrorCode::EpochNotReached);
        let total = ctx.accounts.vault.total_shares;
        require!(total > 0, ErrorCode::MathOverflow);
        let shares = ctx.accounts.withdraw_ticket.shares as u128;
        let base_available = ctx.accounts.base_reserve.amount.saturating_sub(ctx.accounts.vault.insurance_base).saturating_sub(ctx.accounts.vault.keeper_base).saturating_sub(ctx.accounts.vault.protocol_base);
        let quote_available = ctx.accounts.quote_reserve.amount.saturating_sub(ctx.accounts.vault.insurance_quote).saturating_sub(ctx.accounts.vault.keeper_quote).saturating_sub(ctx.accounts.vault.protocol_quote);
        let base_out = shares.checked_mul(base_available as u128).ok_or(ErrorCode::MathOverflow)? / total as u128;
        let quote_out = shares.checked_mul(quote_available as u128).ok_or(ErrorCode::MathOverflow)? / total as u128;
        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[b"vault", ctx.accounts.vault.base_mint.as_ref(), ctx.accounts.vault.quote_mint.as_ref(), &bump];
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.key(), Transfer { from: ctx.accounts.base_reserve.to_account_info(), to: ctx.accounts.user_base.to_account_info(), authority: ctx.accounts.vault.to_account_info() }, &[seeds]), base_out as u64)?;
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.key(), Transfer { from: ctx.accounts.quote_reserve.to_account_info(), to: ctx.accounts.user_quote.to_account_info(), authority: ctx.accounts.vault.to_account_info() }, &[seeds]), quote_out as u64)?;
        token::burn(CpiContext::new_with_signer(ctx.accounts.token_program.key(), Burn { mint: ctx.accounts.share_mint.to_account_info(), from: ctx.accounts.share_lock.to_account_info(), authority: ctx.accounts.vault.to_account_info() }, &[seeds]), ctx.accounts.withdraw_ticket.shares)?;
        ctx.accounts.vault.total_shares = total.checked_sub(ctx.accounts.withdraw_ticket.shares).ok_or(ErrorCode::MathOverflow)?;
        emit!(WithdrawClaimed { slot: Clock::get()?.slot, shares: ctx.accounts.withdraw_ticket.shares, base_amount: base_out as u64, quote_amount: quote_out as u64 });
        Ok(())
    }

    pub fn update_quote(ctx: Context<UpdateQuote>, update: QuoteUpdate) -> Result<()> {
        require!(ctx.accounts.vault.status == ACTIVE, ErrorCode::Paused);
        require!(ctx.accounts.keeper.key() == ctx.accounts.config.keeper, ErrorCode::NotKeeper);
        let clock = Clock::get()?;
        require!(update.update_slot > ctx.accounts.quote_state.update_slot && update.update_slot <= clock.slot, ErrorCode::NonMonotonicSlot);
        require!(update.oracle_price > 0 && update.oracle_publish_time >= 0, ErrorCode::InvalidPrice);
        let feed = ctx.accounts.config.pyth_feed_id;
        require!(ctx.accounts.config.max_staleness_seconds >= 0, ErrorCode::InvalidOracle);
        let price = ctx.accounts.price_update.get_price_no_older_than(&clock, ctx.accounts.config.max_staleness_seconds as u64, &feed).map_err(|_| error!(ErrorCode::InvalidOracle))?;
        require!(price.price > 0 && price.publish_time == update.oracle_publish_time, ErrorCode::InvalidOracle);
        let pyth_price_q64 = pyth_price_q64(price.price, price.exponent).ok_or(ErrorCode::InvalidOracle)?;
        require!(pyth_price_q64 == update.oracle_price, ErrorCode::OraclePriceMismatch);
        let decoded_conf_bps = ((price.conf as u128).saturating_mul(10_000).saturating_add(price.price as u128 - 1) / price.price as u128) as u32;
        require!(decoded_conf_bps <= ctx.accounts.config.max_conf_bps && update.oracle_conf_bps == decoded_conf_bps, ErrorCode::WideConfidence);
        require!(update.half_spread_bps <= ctx.accounts.config.max_spread_bps, ErrorCode::SpreadOutOfBounds);
        if ctx.accounts.quote_state.anchor_sqrt_price > 0 {
            let old = ctx.accounts.quote_state.anchor_sqrt_price;
            let diff = if update.anchor_sqrt_price >= old { update.anchor_sqrt_price - old } else { old - update.anchor_sqrt_price };
            require!(diff.saturating_mul(10_000) <= old.saturating_mul(ctx.accounts.config.max_anchor_step_bps as u128), ErrorCode::AnchorStepTooLarge);
        }
        require!(update.weights_bps.iter().map(|v| *v as u64).sum::<u64>() == 10_000, ErrorCode::InvalidWeights);
        require!(update.offsets_bps.windows(2).all(|w| w[0] < w[1]), ErrorCode::InvalidLadder);
        require!(update.levels.iter().all(|l| l.sqrt_lo > 0 && l.sqrt_lo < l.sqrt_hi && l.liquidity > 0), ErrorCode::InvalidLadder);
        let quote = &mut ctx.accounts.quote_state;
        quote.version = quote.version.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
        let version = quote.version;
        quote.update_slot = update.update_slot;
        quote.expiry_slot = clock.slot.checked_add(ctx.accounts.config.expiry_slots).ok_or(ErrorCode::MathOverflow)?;
        quote.anchor_sqrt_price = update.anchor_sqrt_price;
        quote.p_res_sqrt = update.p_res_sqrt;
        quote.half_spread_bps = update.half_spread_bps;
        quote.ask_extra_bps = update.ask_extra_bps;
        quote.bid_extra_bps = update.bid_extra_bps;
        quote.depth_mult_bps = update.depth_mult_bps.min(10_000);
        quote.oracle_publish_time = update.oracle_publish_time;
        quote.oracle_conf_bps = update.oracle_conf_bps;
        quote.flow_n = 0;
        for i in 0..LEVELS { quote.levels[i] = Level { sqrt_lo: update.levels[i].sqrt_lo, sqrt_hi: update.levels[i].sqrt_hi, liquidity: update.levels[i].liquidity, offset_bps: update.offsets_bps[i], weight_bps: update.weights_bps[i] }; }
        emit!(QuoteUpdated { slot: clock.slot, version, anchor_sqrt_price: update.anchor_sqrt_price, depth_mult_bps: update.depth_mult_bps.min(10_000) });
        Ok(())
    }

    pub fn swap(ctx: Context<Swap>, side: SwapSide, amount_in: u64, min_out: u64, min_version: u64) -> Result<()> {
        require!(ctx.accounts.vault.status == ACTIVE, ErrorCode::Paused);
        let clock = Clock::get()?;
        let quote_version = ctx.accounts.quote_state.version;
        require!(quote_version >= min_version, ErrorCode::VersionTooOld);
        require!(clock.slot < ctx.accounts.quote_state.expiry_slot, ErrorCode::QuoteExpired);
        require!(amount_in > 0 && amount_in <= ctx.accounts.config.max_quote_size, ErrorCode::CapacityExceeded);
        let fee = arb_math::fee_amount(amount_in as u128, ctx.accounts.config.fee_bps as u128).map_err(|_| error!(ErrorCode::MathOverflow))? as u64;
        let net = amount_in.checked_sub(fee).ok_or(ErrorCode::MathOverflow)?;
        let levels: Vec<MathLevel> = ctx.accounts.quote_state.levels.iter().map(|l| MathLevel { sqrt_lo: l.sqrt_lo, sqrt_hi: l.sqrt_hi, liquidity: l.liquidity }).collect();
        let math_side = match side { SwapSide::BuyBase => MathSide::Ask, SwapSide::SellBase => MathSide::Bid };
        let result = walk_ladder(&levels, math_side, net as u128).map_err(|_| error!(ErrorCode::MathOverflow))?;
        require!(result.remaining == 0, ErrorCode::CapacityExceeded);
        let out = result.out as u64;
        require!(out >= min_out, ErrorCode::SlippageExceeded);
        let insurance = (fee as u128).saturating_mul(ctx.accounts.config.insurance_bps as u128) / 10_000;
        let keeper = (fee as u128).saturating_mul(ctx.accounts.config.keeper_bps as u128) / 10_000;
        let protocol = (fee as u128).saturating_mul(ctx.accounts.config.protocol_bps as u128) / 10_000;
        match side {
            SwapSide::BuyBase => { token::transfer(ctx.accounts.quote_transfer_ctx(), amount_in)?; let bump = [ctx.accounts.vault.bump]; let seeds: &[&[u8]] = &[b"vault", ctx.accounts.vault.base_mint.as_ref(), ctx.accounts.vault.quote_mint.as_ref(), &bump]; token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.key(), Transfer { from: ctx.accounts.base_reserve.to_account_info(), to: ctx.accounts.trader_base.to_account_info(), authority: ctx.accounts.vault.to_account_info() }, &[seeds]), out)?; ctx.accounts.vault.insurance_quote = ctx.accounts.vault.insurance_quote.checked_add(insurance as u64).ok_or(ErrorCode::MathOverflow)?; ctx.accounts.vault.keeper_quote = ctx.accounts.vault.keeper_quote.checked_add(keeper as u64).ok_or(ErrorCode::MathOverflow)?; ctx.accounts.vault.protocol_quote = ctx.accounts.vault.protocol_quote.checked_add(protocol as u64).ok_or(ErrorCode::MathOverflow)?; ctx.accounts.quote_state.flow_n = ctx.accounts.quote_state.flow_n.checked_add(out as i128).ok_or(ErrorCode::MathOverflow)?; }
            SwapSide::SellBase => { token::transfer(ctx.accounts.base_transfer_ctx(), amount_in)?; let bump = [ctx.accounts.vault.bump]; let seeds: &[&[u8]] = &[b"vault", ctx.accounts.vault.base_mint.as_ref(), ctx.accounts.vault.quote_mint.as_ref(), &bump]; token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.key(), Transfer { from: ctx.accounts.quote_reserve.to_account_info(), to: ctx.accounts.trader_quote.to_account_info(), authority: ctx.accounts.vault.to_account_info() }, &[seeds]), out)?; ctx.accounts.vault.insurance_base = ctx.accounts.vault.insurance_base.checked_add(insurance as u64).ok_or(ErrorCode::MathOverflow)?; ctx.accounts.vault.keeper_base = ctx.accounts.vault.keeper_base.checked_add(keeper as u64).ok_or(ErrorCode::MathOverflow)?; ctx.accounts.vault.protocol_base = ctx.accounts.vault.protocol_base.checked_add(protocol as u64).ok_or(ErrorCode::MathOverflow)?; ctx.accounts.quote_state.flow_n = ctx.accounts.quote_state.flow_n.checked_sub(amount_in as i128).ok_or(ErrorCode::MathOverflow)?; }
        }
        emit!(SwapEvent { slot: clock.slot, version: quote_version, side, amount_in, amount_out: out, fee });
        Ok(())
    }

    pub fn trip_breaker(ctx: Context<TripBreaker>) -> Result<()> {
        require!(ctx.accounts.vault.status == ACTIVE, ErrorCode::InvalidStatus);
        let now = Clock::get()?.slot;
        require!(ctx.accounts.quote_state.version > 0 && now >= ctx.accounts.quote_state.expiry_slot, ErrorCode::BreakerConditionNotMet);
        ctx.accounts.vault.status = PAUSED;
        emit!(BreakerTripped { slot: now });
        Ok(())
    }
    pub fn reset_breaker(ctx: Context<ResetBreaker>) -> Result<()> { require!(ctx.accounts.admin.key() == ctx.accounts.vault.admin, ErrorCode::Unauthorized); require!(ctx.accounts.vault.status == PAUSED, ErrorCode::InvalidStatus); ctx.accounts.vault.status = ACTIVE; emit!(BreakerReset { slot: Clock::get()?.slot }); Ok(()) }
    pub fn wind_down(ctx: Context<WindDown>) -> Result<()> { require!(ctx.accounts.admin.key() == ctx.accounts.vault.admin, ErrorCode::Unauthorized); ctx.accounts.vault.status = WIND_DOWN; Ok(()) }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
 pub struct InitParams { pub base_mint: Pubkey, pub quote_mint: Pubkey, pub keeper: Pubkey, pub pyth_feed_id: [u8; 32], pub fee_bps: u16, pub insurance_bps: u16, pub keeper_bps: u16, pub protocol_bps: u16, pub min_liquidity: u64, pub warmup_slots: u64, pub epoch_slots: u64, pub grace_slots: u64, pub expiry_slots: u64, pub max_staleness_seconds: i64, pub max_conf_bps: u32, pub max_anchor_step_bps: u32, pub max_spread_bps: u32, pub max_quote_size: u64, pub max_inventory_bps: u32, pub offsets_bps: [u32; LEVELS], pub weights_bps: [u32; LEVELS] }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct LevelUpdate { pub sqrt_lo: u128, pub sqrt_hi: u128, pub liquidity: u128 }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct QuoteUpdate { pub update_slot: u64, pub oracle_publish_time: i64, pub oracle_price: u128, pub oracle_conf_bps: u32, pub anchor_sqrt_price: u128, pub p_res_sqrt: u128, pub half_spread_bps: u32, pub ask_extra_bps: u32, pub bid_extra_bps: u32, pub depth_mult_bps: u32, pub offsets_bps: [u32; LEVELS], pub weights_bps: [u32; LEVELS], pub levels: [LevelUpdate; LEVELS] }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum SwapSide { BuyBase, SellBase }

#[account]
 pub struct Vault { pub admin: Pubkey, pub base_mint: Pubkey, pub quote_mint: Pubkey, pub base_reserve: Pubkey, pub quote_reserve: Pubkey, pub share_mint: Pubkey, pub share_lock: Pubkey, pub total_shares: u64, pub insurance_base: u64, pub insurance_quote: u64, pub keeper_base: u64, pub keeper_quote: u64, pub protocol_base: u64, pub protocol_quote: u64, pub epoch: u64, pub epoch_start: u64, pub status: u8, pub bump: u8 }
#[account]
 pub struct Config { pub admin: Pubkey, pub keeper: Pubkey, pub pyth_feed_id: [u8; 32], pub fee_bps: u16, pub insurance_bps: u16, pub keeper_bps: u16, pub protocol_bps: u16, pub min_liquidity: u64, pub warmup_slots: u64, pub epoch_slots: u64, pub grace_slots: u64, pub expiry_slots: u64, pub max_staleness_seconds: i64, pub max_conf_bps: u32, pub max_anchor_step_bps: u32, pub max_spread_bps: u32, pub max_quote_size: u64, pub max_inventory_bps: u32, pub bump: u8 }
#[account]
pub struct QuoteState { pub version: u64, pub update_slot: u64, pub expiry_slot: u64, pub anchor_sqrt_price: u128, pub p_res_sqrt: u128, pub half_spread_bps: u32, pub ask_extra_bps: u32, pub bid_extra_bps: u32, pub depth_mult_bps: u32, pub flow_n: i128, pub oracle_publish_time: i64, pub oracle_conf_bps: u32, pub levels: [Level; LEVELS], pub bump: u8 }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct Level { pub offset_bps: u32, pub weight_bps: u32, pub sqrt_lo: u128, pub sqrt_hi: u128, pub liquidity: u128 }
#[account]
pub struct DepositTicket { pub owner: Pubkey, pub shares: u64, pub activate_slot: u64, pub bump: u8 }
#[account]
pub struct WithdrawTicket { pub owner: Pubkey, pub shares: u64, pub epoch: u64, pub bump: u8 }

#[derive(Accounts)]
#[instruction(params: InitParams)]
pub struct InitializeVault<'info> {
    #[account(mut)] pub admin: Signer<'info>,
    #[account(seeds = [b"vault", params.base_mint.as_ref(), params.quote_mint.as_ref()], bump, init, payer = admin, space = 8 + 32*7 + 8*9 + 2)] pub vault: Box<Account<'info, Vault>>,
    #[account(seeds = [b"config", vault.key().as_ref()], bump, init, payer = admin, space = 8 + 32*3 + 2*4 + 8*6 + 4*4 + 8 + 4 + 1)] pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"quote", vault.key().as_ref()], bump, init, payer = admin, space = 8 + 8*3 + 16*3 + 4*5 + 16 + 8 + 4 + (4+4+16+16+16)*LEVELS + 1)] pub quote_state: Box<Account<'info, QuoteState>>,
    #[account(address = params.base_mint)] pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = params.quote_mint)] pub quote_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = admin, token::mint = base_mint, token::authority = vault)] pub base_reserve: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = admin, token::mint = quote_mint, token::authority = vault)] pub quote_reserve: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = admin, mint::decimals = 9, mint::authority = vault)] pub share_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = admin, token::mint = share_mint, token::authority = vault)] pub share_lock: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>, pub system_program: Program<'info, System>, pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)] pub user: Signer<'info>, #[account(mut)] pub vault: Box<Account<'info, Vault>>, #[account(seeds=[b"config", vault.key().as_ref()], bump = config.bump)] pub config: Box<Account<'info, Config>>,
    #[account(mut, address = vault.base_reserve)] pub base_reserve: Box<Account<'info, TokenAccount>>, #[account(mut, address = vault.quote_reserve)] pub quote_reserve: Box<Account<'info, TokenAccount>>, #[account(mut, address = vault.share_mint)] pub share_mint: Box<Account<'info, Mint>>, #[account(mut, address = vault.share_lock)] pub share_lock: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_base.mint == vault.base_mint, constraint = user_base.owner == user.key())] pub user_base: Box<Account<'info, TokenAccount>>, #[account(mut, constraint = user_quote.mint == vault.quote_mint, constraint = user_quote.owner == user.key())] pub user_quote: Box<Account<'info, TokenAccount>>, #[account(mut, constraint = user_shares.mint == vault.share_mint, constraint = user_shares.owner == user.key())] pub user_shares: Box<Account<'info, TokenAccount>>,
    #[account(init, payer=user, space=8+32+8+8+1, seeds=[b"dep", vault.key().as_ref(), user.key().as_ref()], bump)] pub deposit_ticket: Account<'info, DepositTicket>, pub token_program: Program<'info, Token>, pub system_program: Program<'info, System>,
}
impl<'info> Deposit<'info> { fn base_transfer_ctx(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> { CpiContext::new(self.token_program.key(), Transfer { from:self.user_base.to_account_info(), to:self.base_reserve.to_account_info(), authority:self.user.to_account_info() }) } fn quote_transfer_ctx(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> { CpiContext::new(self.token_program.key(), Transfer { from:self.user_quote.to_account_info(), to:self.quote_reserve.to_account_info(), authority:self.user.to_account_info() }) } }

#[derive(Accounts)] pub struct RequestWithdraw<'info> { #[account(mut)] pub user: Signer<'info>, #[account(mut)] pub vault: Box<Account<'info,Vault>>, #[account(mut, address=vault.share_lock)] pub share_lock: Box<Account<'info,TokenAccount>>, #[account(seeds=[b"dep",vault.key().as_ref(),user.key().as_ref()],bump=deposit_ticket.bump)] pub deposit_ticket: Box<Account<'info,DepositTicket>>, #[account(mut, constraint=user_shares.owner==user.key())] pub user_shares: Box<Account<'info,TokenAccount>>, #[account(init, payer=user, space=8+32+8+8+1, seeds=[b"wd", vault.key().as_ref(), user.key().as_ref()], bump)] pub withdraw_ticket: Box<Account<'info,WithdrawTicket>>, pub token_program: Program<'info,Token>, pub system_program: Program<'info,System> }
impl<'info> RequestWithdraw<'info> { fn queue_transfer_ctx(&self)->CpiContext<'_, '_, '_, 'info, Transfer<'info>> { CpiContext::new(self.token_program.key(), Transfer{from:self.user_shares.to_account_info(),to:self.share_lock.to_account_info(),authority:self.user.to_account_info()}) } }

#[derive(Accounts)] pub struct CrankEpoch<'info> { #[account(mut)] pub vault: Account<'info,Vault>, #[account(seeds=[b"config",vault.key().as_ref()],bump=config.bump)] pub config: Account<'info,Config> }
#[derive(Accounts)] pub struct ClaimWithdraw<'info> { #[account(mut)] pub user: Signer<'info>, #[account(mut)] pub vault: Box<Account<'info,Vault>>, #[account(mut, address=vault.base_reserve)] pub base_reserve: Box<Account<'info,TokenAccount>>, #[account(mut,address=vault.quote_reserve)] pub quote_reserve: Box<Account<'info,TokenAccount>>, #[account(mut,address=vault.share_mint)] pub share_mint: Box<Account<'info,Mint>>, #[account(mut,address=vault.share_lock)] pub share_lock: Box<Account<'info,TokenAccount>>, #[account(mut,constraint=withdraw_ticket.owner==user.key())] pub withdraw_ticket: Box<Account<'info,WithdrawTicket>>, #[account(mut,constraint=user_base.owner==user.key())] pub user_base: Box<Account<'info,TokenAccount>>, #[account(mut,constraint=user_quote.owner==user.key())] pub user_quote: Box<Account<'info,TokenAccount>>, pub token_program: Program<'info,Token> }

#[derive(Accounts)] pub struct UpdateQuote<'info> { pub keeper: Signer<'info>, #[account(mut)] pub vault: Box<Account<'info,Vault>>, #[account(seeds=[b"config",vault.key().as_ref()],bump=config.bump)] pub config: Box<Account<'info,Config>>, #[account(mut,seeds=[b"quote",vault.key().as_ref()],bump=quote_state.bump)] pub quote_state: Box<Account<'info,QuoteState>>, pub price_update: Box<Account<'info,PriceUpdateV2>> }
#[derive(Accounts)] pub struct Swap<'info> { #[account(mut)] pub trader: Signer<'info>, #[account(mut)] pub vault: Box<Account<'info,Vault>>, #[account(seeds=[b"config",vault.key().as_ref()],bump=config.bump)] pub config: Box<Account<'info,Config>>, #[account(mut,seeds=[b"quote",vault.key().as_ref()],bump=quote_state.bump)] pub quote_state: Box<Account<'info,QuoteState>>, #[account(mut,address=vault.base_reserve)] pub base_reserve: Box<Account<'info,TokenAccount>>, #[account(mut,address=vault.quote_reserve)] pub quote_reserve: Box<Account<'info,TokenAccount>>, #[account(mut,constraint=trader_base.owner==trader.key())] pub trader_base: Box<Account<'info,TokenAccount>>, #[account(mut,constraint=trader_quote.owner==trader.key())] pub trader_quote: Box<Account<'info,TokenAccount>>, pub token_program: Program<'info,Token> }
impl<'info> Swap<'info> { fn base_transfer_ctx(&self)->CpiContext<'_, '_, '_, 'info, Transfer<'info>> { CpiContext::new(self.token_program.key(),Transfer{from:self.trader_base.to_account_info(),to:self.base_reserve.to_account_info(),authority:self.trader.to_account_info()}) } fn quote_transfer_ctx(&self)->CpiContext<'_, '_, '_, 'info, Transfer<'info>> { CpiContext::new(self.token_program.key(),Transfer{from:self.trader_quote.to_account_info(),to:self.quote_reserve.to_account_info(),authority:self.trader.to_account_info()}) } }
#[derive(Accounts)] pub struct TripBreaker<'info> { #[account(mut)] pub vault: Box<Account<'info,Vault>>, #[account(seeds=[b"quote",vault.key().as_ref()], bump)] pub quote_state: Box<Account<'info,QuoteState>> }
#[derive(Accounts)] pub struct ResetBreaker<'info> { pub admin: Signer<'info>, #[account(mut)] pub vault: Account<'info,Vault> }
#[derive(Accounts)] pub struct WindDown<'info> { pub admin: Signer<'info>, #[account(mut)] pub vault: Account<'info,Vault> }

fn integer_sqrt(n: u128) -> u128 { let mut lo=0; let mut hi=1u128<<64; while lo+1<hi { let mid=(lo+hi)/2; if mid <= n/mid { lo=mid; } else { hi=mid; } } lo }

fn pyth_price_q64(price: i64, exponent: i32) -> Option<u128> {
    let positive = u128::try_from(price).ok()?;
    if exponent >= 0 {
        positive.checked_mul(10u128.checked_pow(exponent as u32)?)?.checked_mul(1u128 << 64)
    } else {
        positive.checked_mul(1u128 << 64)?.checked_div(10u128.checked_pow((-exponent) as u32)?)
    }
}

#[event] pub struct VaultInitialized { pub slot:u64, pub vault:Pubkey }
#[event] pub struct DepositEvent { pub slot:u64, pub shares:u64, pub base_amount:u64, pub quote_amount:u64 }
#[event] pub struct WithdrawRequested { pub slot:u64, pub shares:u64, pub epoch:u64 }
#[event] pub struct WithdrawClaimed { pub slot:u64, pub shares:u64, pub base_amount:u64, pub quote_amount:u64 }
#[event] pub struct QuoteUpdated { pub slot:u64, pub version:u64, pub anchor_sqrt_price:u128, pub depth_mult_bps:u32 }
#[event] pub struct SwapEvent { pub slot:u64, pub version:u64, pub side:SwapSide, pub amount_in:u64, pub amount_out:u64, pub fee:u64 }
#[event] pub struct BreakerTripped { pub slot:u64 }
#[event] pub struct BreakerReset { pub slot:u64 }

#[error_code] pub enum ErrorCode { #[msg("Unauthorized")] Unauthorized, #[msg("Invalid mint")] InvalidMint, #[msg("Invalid params")] InvalidParams, #[msg("Invalid amount")] InvalidAmount, #[msg("Invalid weights")] InvalidWeights, #[msg("Invalid ladder")] InvalidLadder, #[msg("Invalid price")] InvalidPrice, #[msg("Invalid status")] InvalidStatus, #[msg("Breaker condition not met")] BreakerConditionNotMet, #[msg("Math overflow")] MathOverflow, #[msg("Paused")] Paused, #[msg("Warmup not elapsed")] WarmupNotElapsed, #[msg("Invalid oracle account or verification")] InvalidOracle, #[msg("Oracle price mismatch")] OraclePriceMismatch, #[msg("Stale oracle")] StaleOracle, #[msg("Wide confidence")] WideConfidence, #[msg("Anchor step too large")] AnchorStepTooLarge, #[msg("Spread out of bounds")] SpreadOutOfBounds, #[msg("Quote expired")] QuoteExpired, #[msg("Version too old")] VersionTooOld, #[msg("Slippage exceeded")] SlippageExceeded, #[msg("Capacity exceeded")] CapacityExceeded, #[msg("Epoch not reached")] EpochNotReached, #[msg("Not keeper")] NotKeeper, #[msg("Non-monotonic slot")] NonMonotonicSlot }

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
