use anchor_lang::prelude::*;

declare_id!("E8ptkpV626P2neR8v4Q9UCFHoD6AMAH2aTRsEQiNDN3U");

/// ArbSwap program skeleton (Build Plan P0/T2.1).
///
/// Accounts, config, errors and events land here per Build Plan:
///   §6.1 accounts (Vault, QuoteState, Config, DepositTicket, WithdrawTicket, KeeperBond)
///   §6.2 instructions (deposit, request/claim_withdraw, update_quote, swap, crank_epoch,
///        trip/reset_breaker, bond/slash_keeper, set_params)
///   §6.5 events (QuoteUpdated, Swap, Deposit, ... — every event carries slot and version)
///   §6.6 errors (StaleOracle, QuoteExpired, SlippageExceeded, ...)
///
/// Guards on every call (§6.3/§6.4): bounded anchor step, spread min/max, oracle
/// freshness + confidence, quote expiry, versioned quote + min_out, inventory and
/// size caps, checked math with rounding in the vault's favor.
#[program]
pub mod arbswap {
    use super::*;

    /// P0 placeholder: proves the Anchor pipeline (anchor build / cargo test) end to end.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("ArbSwap skeleton initialized");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// TODO(P2 T2.1): replace with Vault/Config/QuoteState PDAs (Build Plan §6.1).
    pub payer: Signer<'info>,
}
