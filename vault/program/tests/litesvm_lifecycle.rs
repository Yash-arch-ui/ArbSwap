//! End-to-end LiteSVM lifecycle: oracle rejects, deposit, quote, swap,
//! breaker, and withdrawal, with value-conservation invariants.

mod common;

use arbswap::{
    Config, DepositTicket, InitParams, KeeperBond, LevelUpdate, QuoteState, QuoteUpdate, Vault,
};
use common::*;
use litesvm::LiteSVM;
use pyth_solana_receiver_sdk::price_update::VerificationLevel;
use solana_address::Address;
use solana_clock::Clock;
use solana_compute_budget::compute_budget::ComputeBudget;
use solana_instruction::account_meta::AccountMeta;
use solana_keypair::Keypair;
use solana_signer::Signer;

const SLOT: u64 = 5;
const EXPIRY_SLOTS: u64 = 10;
const FEE_BPS: u16 = 100;
const INSURANCE_BPS: u16 = 3_333;
const KEEPER_BPS: u16 = 3_333;
const PROTOCOL_BPS: u16 = 3_334;
const MAX_QUOTE_SIZE: u64 = 1_000_000;
/// `ceil(amount_in * FEE_BPS / 10_000) == FEE`.
const AMOUNT_IN: u64 = 100_000;
const FEE: u64 = 1_000;
const LP_BASE_DEPOSIT: u64 = 1_000_000_000;
const LP_QUOTE_DEPOSIT: u64 = 1_000_000_000;
const FIRST_SHARES: u64 = 999_999_999;
const TOTAL_SHARES: u64 = 1_000_000_000;
const ANCHOR_SQRT: u128 = 225_887_000_000_000_000_000;

struct Keys {
    admin: Keypair,
    keeper: Keypair,
    lp: Keypair,
    trader: Keypair,
}

impl Keys {
    fn new() -> Self {
        Self {
            admin: Keypair::new(),
            keeper: Keypair::new(),
            lp: Keypair::new(),
            trader: Keypair::new(),
        }
    }
}

/// Total base capacity the test ask ladder offers; must fit `u_max * available`.
const TEST_LADDER_BASE_CAPACITY: u128 = 1_000;
/// Total quote capacity the test bid ladder offers; must fit the smallest
/// quote reserve used by the successful-quote tests (`window_flow_cap` deposits
/// 1.5e6 quote -> 7.5e5 cap).
const TEST_LADDER_QUOTE_CAPACITY: u128 = 500_000;

fn ladder() -> [LevelUpdate; 6] {
    anchor_ladder(ANCHOR_SQRT, 5, OFFSETS, TEST_LADDER_BASE_CAPACITY)
}

fn bid_ladder() -> [LevelUpdate; 6] {
    anchor_bid_ladder(ANCHOR_SQRT, 5, OFFSETS, TEST_LADDER_QUOTE_CAPACITY)
}

fn quote_update(update_slot: u64) -> QuoteUpdate {
    QuoteUpdate {
        update_slot,
        oracle_publish_time: PUBLISH_TIME,
        oracle_price: PRICE_Q64,
        oracle_conf_bps: CONF_BPS,
        anchor_sqrt_price: ANCHOR_SQRT,
        p_res_sqrt: ANCHOR_SQRT,
        half_spread_bps: 5,
        ask_extra_bps: 0,
        bid_extra_bps: 0,
        depth_mult_bps: 10_000,
        offsets_bps: OFFSETS,
        weights_bps: WEIGHTS,
        ask_levels: ladder(),
        bid_levels: bid_ladder(),
    }
}

/// The output the arb-math reference produces for the lifecycle swap.
fn expected_swap_out() -> u128 {
    let fee = arb_math::fee_amount(AMOUNT_IN as u128, FEE_BPS as u128).unwrap();
    assert_eq!(fee, FEE as u128);
    let levels: Vec<arb_math::Level> = ladder()
        .iter()
        .map(|level| arb_math::Level {
            sqrt_lo: level.sqrt_lo,
            sqrt_hi: level.sqrt_hi,
            liquidity: level.liquidity,
        })
        .collect();
    let result =
        arb_math::walk_ladder(&levels, arb_math::Side::Ask, AMOUNT_IN as u128 - fee).unwrap();
    assert_eq!(result.remaining, 0, "ladder must absorb the whole input");
    assert!(result.out > 0);
    result.out
}

struct Fixture {
    svm: LiteSVM,
    program_id: Address,
    base_mint: Address,
    quote_mint: Address,
    vault: Address,
    config: Address,
    quote_state: Address,
    base_reserve: Address,
    quote_reserve: Address,
    share_mint: Address,
    share_lock: Address,
    lp_base: Address,
    lp_quote: Address,
    lp_shares: Address,
    trader_shares: Address,
    trader_base: Address,
    trader_quote: Address,
    keeper_base: Address,
    keeper_quote: Address,
    deposit_ticket: Address,
    withdraw_ticket: Address,
    base_reserve_kp: Keypair,
    quote_reserve_kp: Keypair,
    share_mint_kp: Keypair,
    share_lock_kp: Keypair,
    params: InitParams,
}

impl Fixture {
    fn new(keys: &Keys) -> Self {
        Self::with_min_bond(keys, 0)
    }

    fn with_min_bond(keys: &Keys, min_bond: u64) -> Self {
        Self::with_config(keys, min_bond, 100, 10_000)
    }

    fn with_config(
        keys: &Keys,
        min_bond: u64,
        flow_window_slots: u64,
        max_window_flow_bps: u32,
    ) -> Self {
        // LiteSVM defaults the whole transaction to 200k CU, which is not
        // enough to *measure* a swap. Raise the budget so the meter reports
        // true consumption; on-chain the sender sets the same value with a
        // ComputeBudget instruction (see docs/SECURITY_CHECKLIST.md).
        let budget = ComputeBudget {
            compute_unit_limit: 1_400_000,
            ..ComputeBudget::new_with_defaults(false)
        };
        let mut svm = LiteSVM::new().with_compute_budget(budget);
        let program_id = load_arbswap(&mut svm);
        for key in [&keys.admin, &keys.keeper, &keys.lp, &keys.trader] {
            airdrop(&mut svm, key, 10_000_000_000);
        }

        let mut clock = svm.get_sysvar::<Clock>();
        clock.slot = SLOT;
        clock.unix_timestamp = PUBLISH_TIME;
        svm.set_sysvar(&clock);

        let base_mint = Address::new_unique();
        let quote_mint = Address::new_unique();
        set_token_mint(&mut svm, base_mint, 9, keys.admin.pubkey());
        set_token_mint(&mut svm, quote_mint, 6, keys.admin.pubkey());

        let lp_base = Address::new_unique();
        let lp_quote = Address::new_unique();
        let trader_base = Address::new_unique();
        let trader_quote = Address::new_unique();
        set_token_account(
            &mut svm,
            lp_base,
            base_mint,
            keys.lp.pubkey(),
            10_000_000_000,
        );
        set_token_account(
            &mut svm,
            lp_quote,
            quote_mint,
            keys.lp.pubkey(),
            10_000_000_000,
        );
        set_token_account(
            &mut svm,
            trader_base,
            base_mint,
            keys.trader.pubkey(),
            10_000_000_000,
        );
        set_token_account(
            &mut svm,
            trader_quote,
            quote_mint,
            keys.trader.pubkey(),
            10_000_000_000,
        );
        let keeper_base = Address::new_unique();
        let keeper_quote = Address::new_unique();
        set_token_account(
            &mut svm,
            keeper_base,
            base_mint,
            keys.keeper.pubkey(),
            10_000_000_000,
        );
        set_token_account(
            &mut svm,
            keeper_quote,
            quote_mint,
            keys.keeper.pubkey(),
            10_000_000_000,
        );

        let lp_address = to_address(keys.lp.pubkey());
        let (vault, _) = pda(
            &[b"vault", base_mint.as_ref(), quote_mint.as_ref()],
            &program_id,
        );
        let (config, _) = pda(&[b"config", vault.as_ref()], &program_id);
        let (quote_state, _) = pda(&[b"quote", vault.as_ref()], &program_id);
        let (deposit_ticket, _) = pda(&[b"dep", vault.as_ref(), lp_address.as_ref()], &program_id);
        let (withdraw_ticket, _) = pda(&[b"wd", vault.as_ref(), lp_address.as_ref()], &program_id);

        let params = InitParams {
            base_mint: pubkey(base_mint),
            quote_mint: pubkey(quote_mint),
            keeper: keys.keeper.pubkey(),
            treasury: keys.admin.pubkey(),
            pyth_feed_id: FEED_ID,
            fee_bps: FEE_BPS,
            insurance_bps: INSURANCE_BPS,
            keeper_bps: KEEPER_BPS,
            protocol_bps: PROTOCOL_BPS,
            min_liquidity: 1,
            warmup_slots: 1,
            epoch_slots: 10,
            grace_slots: 1,
            expiry_slots: EXPIRY_SLOTS,
            max_staleness_seconds: 30,
            max_conf_bps: 10,
            max_anchor_step_bps: 100,
            min_spread_bps: 2,
            max_spread_bps: 50,
            max_quote_size: MAX_QUOTE_SIZE,
            max_inventory_bps: 2_000,
            utilization_max_bps: 5_000,
            min_bond,
            unbond_cooldown_slots: 100,
            max_update_slot_age: 25,
            max_anchor_dev_bps: 100,
            flow_window_slots,
            max_window_flow_bps,
            offsets_bps: OFFSETS,
            weights_bps: WEIGHTS,
        };

        let base_reserve_kp = Keypair::new();
        let quote_reserve_kp = Keypair::new();
        let share_mint_kp = Keypair::new();
        let share_lock_kp = Keypair::new();
        let mut fixture = Self {
            svm,
            program_id,
            base_mint,
            quote_mint,
            vault,
            config,
            quote_state,
            base_reserve: to_address(base_reserve_kp.pubkey()),
            quote_reserve: to_address(quote_reserve_kp.pubkey()),
            share_mint: to_address(share_mint_kp.pubkey()),
            share_lock: to_address(share_lock_kp.pubkey()),
            lp_base,
            lp_quote,
            lp_shares: Address::new_unique(),
            trader_shares: Address::new_unique(),
            trader_base,
            trader_quote,
            keeper_base,
            keeper_quote,
            deposit_ticket,
            withdraw_ticket,
            base_reserve_kp,
            quote_reserve_kp,
            share_mint_kp,
            share_lock_kp,
            params,
        };
        fixture.initialize_program(&keys.admin);
        fixture.initialize_vault(&keys.admin);
        set_token_account(
            &mut fixture.svm,
            fixture.lp_shares,
            fixture.share_mint,
            keys.lp.pubkey(),
            0,
        );
        set_token_account(
            &mut fixture.svm,
            fixture.trader_shares,
            fixture.share_mint,
            keys.trader.pubkey(),
            0,
        );
        fixture
    }

    /// Deposit as an arbitrary user (deriving that user's deposit ticket), so a
    /// second LP can be used as the victim in the inflation test.
    #[allow(clippy::too_many_arguments)]
    fn deposit_as(
        &mut self,
        user: &Keypair,
        user_base: Address,
        user_quote: Address,
        user_shares: Address,
        base_amount: u64,
        quote_amount: u64,
        min_shares: u64,
    ) -> litesvm::types::TransactionResult {
        let user_address = to_address(user.pubkey());
        let (deposit_ticket, _) = pda(
            &[b"dep", self.vault.as_ref(), user_address.as_ref()],
            &self.program_id,
        );
        let instruction = ix(
            self.program_id,
            arbswap::instruction::Deposit {
                base_amount,
                quote_amount,
                min_shares,
            },
            arbswap::accounts::Deposit {
                user: user_address,
                vault: self.vault,
                config: self.config,
                base_reserve: self.base_reserve,
                quote_reserve: self.quote_reserve,
                share_mint: self.share_mint,
                share_lock: self.share_lock,
                user_base,
                user_quote,
                user_shares,
                deposit_ticket,
                token_program: token_program_id(),
                system_program: anchor_lang::system_program::ID,
            },
        );
        send(&mut self.svm, &[user], instruction)
    }

    /// Swap with an explicit side (the default helper is buy-only).
    fn swap_side(
        &mut self,
        trader: &Keypair,
        side: arbswap::SwapSide,
        amount_in: u64,
        min_out: u64,
        min_version: u64,
    ) -> litesvm::types::TransactionResult {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::Swap {
                side,
                amount_in,
                min_out,
                min_version,
            },
            arbswap::accounts::Swap {
                trader: to_address(trader.pubkey()),
                vault: self.vault,
                config: self.config,
                quote_state: self.quote_state,
                base_reserve: self.base_reserve,
                quote_reserve: self.quote_reserve,
                trader_base: self.trader_base,
                trader_quote: self.trader_quote,
                token_program: token_program_id(),
            },
        );
        send(&mut self.svm, &[trader], instruction)
    }

    fn program_config(&self) -> Address {
        pda(&[b"program"], &self.program_id).0
    }

    fn trip_breaker(&mut self, payer: &Keypair) -> litesvm::types::TransactionResult {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::TripBreaker {},
            arbswap::accounts::TripBreaker {
                vault: self.vault,
                config: self.config,
                quote_state: self.quote_state,
            },
        );
        send(&mut self.svm, &[payer], instruction)
    }

    fn reset_breaker(&mut self, admin: &Keypair) -> litesvm::types::TransactionResult {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::ResetBreaker {},
            arbswap::accounts::ResetBreaker {
                admin: to_address(admin.pubkey()),
                vault: self.vault,
            },
        );
        send(&mut self.svm, &[admin], instruction)
    }

    fn crank_epoch(&mut self, payer: &Keypair) -> litesvm::types::TransactionResult {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::CrankEpoch {},
            arbswap::accounts::CrankEpoch {
                vault: self.vault,
                config: self.config,
            },
        );
        send(&mut self.svm, &[payer], instruction)
    }

    fn bond_vault(&self) -> Address {
        pda(&[b"bond", self.vault.as_ref()], &self.program_id).0
    }

    fn keeper_bond(&self, keeper: &Keypair) -> Address {
        pda(
            &[b"keeper", self.vault.as_ref(), keeper.pubkey().as_ref()],
            &self.program_id,
        )
        .0
    }

    fn bond_keeper(&mut self, keeper: &Keypair, amount: u64) -> litesvm::types::TransactionResult {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::BondKeeper { amount },
            arbswap::accounts::BondKeeper {
                keeper: to_address(keeper.pubkey()),
                vault: self.vault,
                quote_mint: self.quote_mint,
                keeper_quote: self.keeper_quote,
                bond_vault: self.bond_vault(),
                keeper_bond: self.keeper_bond(keeper),
                token_program: token_program_id(),
                system_program: anchor_lang::system_program::ID,
            },
        );
        send(&mut self.svm, &[keeper], instruction)
    }

    fn slash_keeper(
        &mut self,
        admin: &Keypair,
        keeper: &Keypair,
        amount: u64,
    ) -> litesvm::types::TransactionResult {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::SlashKeeper { amount },
            arbswap::accounts::SlashKeeper {
                admin: to_address(admin.pubkey()),
                vault: self.vault,
                quote_reserve: self.quote_reserve,
                keeper: to_address(keeper.pubkey()),
                keeper_bond: self.keeper_bond(keeper),
                bond_vault: self.bond_vault(),
                token_program: token_program_id(),
            },
        );
        send(&mut self.svm, &[admin], instruction)
    }

    fn claim_keeper_reward(&mut self, keeper: &Keypair) -> litesvm::types::TransactionResult {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::ClaimKeeperReward {},
            arbswap::accounts::ClaimKeeperReward {
                keeper: to_address(keeper.pubkey()),
                vault: self.vault,
                config: self.config,
                base_reserve: self.base_reserve,
                quote_reserve: self.quote_reserve,
                keeper_base: self.keeper_base,
                keeper_quote: self.keeper_quote,
                token_program: token_program_id(),
            },
        );
        send(&mut self.svm, &[keeper], instruction)
    }

    fn unbond_keeper(
        &mut self,
        keeper: &Keypair,
        amount: u64,
    ) -> litesvm::types::TransactionResult {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::UnbondKeeper { amount },
            arbswap::accounts::UnbondKeeper {
                keeper: to_address(keeper.pubkey()),
                vault: self.vault,
                config: self.config,
                quote_mint: self.quote_mint,
                keeper_quote: self.keeper_quote,
                bond_vault: self.bond_vault(),
                keeper_bond: self.keeper_bond(keeper),
                token_program: token_program_id(),
            },
        );
        send(&mut self.svm, &[keeper], instruction)
    }

    fn initialize_program(&mut self, admin: &Keypair) {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::InitializeProgram {},
            arbswap::accounts::InitializeProgram {
                admin: to_address(admin.pubkey()),
                program_config: self.program_config(),
                system_program: anchor_lang::system_program::ID,
            },
        );
        send(&mut self.svm, &[admin], instruction).expect("initialize_program failed");
    }

    fn initialize_vault(&mut self, admin: &Keypair) {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::InitializeVault {
                params: self.params,
            },
            arbswap::accounts::InitializeVault {
                admin: to_address(admin.pubkey()),
                program_config: self.program_config(),
                vault: self.vault,
                config: self.config,
                quote_state: self.quote_state,
                base_mint: self.base_mint,
                quote_mint: self.quote_mint,
                base_reserve: self.base_reserve,
                quote_reserve: self.quote_reserve,
                share_mint: self.share_mint,
                share_lock: self.share_lock,
                token_program: token_program_id(),
                system_program: anchor_lang::system_program::ID,
                rent: rent_id(),
            },
        );
        let signers: [&Keypair; 5] = [
            admin,
            &self.base_reserve_kp,
            &self.quote_reserve_kp,
            &self.share_mint_kp,
            &self.share_lock_kp,
        ];
        send(&mut self.svm, &signers, instruction).expect("initialize_vault failed");
    }

    fn deposit(
        &mut self,
        user: &Keypair,
        base_amount: u64,
        quote_amount: u64,
        min_shares: u64,
    ) -> litesvm::types::TransactionResult {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::Deposit {
                base_amount,
                quote_amount,
                min_shares,
            },
            arbswap::accounts::Deposit {
                user: to_address(user.pubkey()),
                vault: self.vault,
                config: self.config,
                base_reserve: self.base_reserve,
                quote_reserve: self.quote_reserve,
                share_mint: self.share_mint,
                share_lock: self.share_lock,
                user_base: self.lp_base,
                user_quote: self.lp_quote,
                user_shares: self.lp_shares,
                deposit_ticket: self.deposit_ticket,
                token_program: token_program_id(),
                system_program: anchor_lang::system_program::ID,
            },
        );
        send(&mut self.svm, &[user], instruction)
    }

    fn post_pyth(
        &mut self,
        price: i64,
        conf: u64,
        publish_time: i64,
        verification: VerificationLevel,
    ) -> Address {
        let key = Address::new_unique();
        let account = pyth_account(
            FEED_ID,
            price,
            conf,
            PYTH_EXPONENT,
            publish_time,
            verification,
        );
        self.svm
            .set_account(
                key,
                solana_account::Account {
                    lamports: 1_000_000_000,
                    data: account_data(&account),
                    owner: to_address(pyth_solana_receiver_sdk::ID),
                    ..solana_account::Account::default()
                },
            )
            .unwrap();
        key
    }

    fn post_pyth_with_feed(
        &mut self,
        feed_id: [u8; 32],
        price: i64,
        conf: u64,
        publish_time: i64,
    ) -> Address {
        let key = Address::new_unique();
        let account = pyth_account(
            feed_id,
            price,
            conf,
            PYTH_EXPONENT,
            publish_time,
            VerificationLevel::Full,
        );
        self.svm
            .set_account(
                key,
                solana_account::Account {
                    lamports: 1_000_000_000,
                    data: account_data(&account),
                    owner: to_address(pyth_solana_receiver_sdk::ID),
                    ..solana_account::Account::default()
                },
            )
            .unwrap();
        key
    }

    /// Post a well-formed `PriceUpdateV2` account owned by an arbitrary program
    /// so the Anchor `Account<PriceUpdateV2>` owner check is exercised.
    fn post_pyth_owned_by(
        &mut self,
        owner: Address,
        price: i64,
        conf: u64,
        publish_time: i64,
    ) -> Address {
        let key = Address::new_unique();
        let account = pyth_account(
            FEED_ID,
            price,
            conf,
            PYTH_EXPONENT,
            publish_time,
            VerificationLevel::Full,
        );
        self.svm
            .set_account(
                key,
                solana_account::Account {
                    lamports: 1_000_000_000,
                    data: account_data(&account),
                    owner,
                    ..solana_account::Account::default()
                },
            )
            .unwrap();
        key
    }

    fn wind_down(&mut self, admin: &Keypair) -> litesvm::types::TransactionResult {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::WindDown {},
            arbswap::accounts::WindDown {
                admin: to_address(admin.pubkey()),
                vault: self.vault,
            },
        );
        send(&mut self.svm, &[admin], instruction)
    }

    fn pending_config(&self) -> Address {
        pda(&[b"pending", self.vault.as_ref()], &self.program_id).0
    }

    fn set_params(
        &mut self,
        admin: &Keypair,
        params: arbswap::ParamsUpdate,
    ) -> litesvm::types::TransactionResult {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::SetParams { params },
            arbswap::accounts::SetParams {
                admin: to_address(admin.pubkey()),
                vault: self.vault,
                pending_config: self.pending_config(),
                system_program: anchor_lang::system_program::ID,
            },
        );
        send(&mut self.svm, &[admin], instruction)
    }

    fn apply_params(&mut self, admin: &Keypair) -> litesvm::types::TransactionResult {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::ApplyParams {},
            arbswap::accounts::ApplyParams {
                admin: to_address(admin.pubkey()),
                vault: self.vault,
                config: self.config,
                pending_config: self.pending_config(),
            },
        );
        send(&mut self.svm, &[admin], instruction)
    }

    fn update_quote(
        &mut self,
        keeper: &Keypair,
        price_update: Address,
        update: QuoteUpdate,
    ) -> litesvm::types::TransactionResult {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::UpdateQuote { update },
            arbswap::accounts::UpdateQuote {
                keeper: to_address(keeper.pubkey()),
                vault: self.vault,
                config: self.config,
                quote_state: self.quote_state,
                price_update,
                keeper_bond: self.keeper_bond(keeper),
                base_reserve: self.base_reserve,
                quote_reserve: self.quote_reserve,
            },
        );
        send(&mut self.svm, &[keeper], instruction)
    }

    fn swap(
        &mut self,
        trader: &Keypair,
        amount_in: u64,
        min_out: u64,
        min_version: u64,
    ) -> litesvm::types::TransactionResult {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::Swap {
                side: arbswap::SwapSide::BuyBase,
                amount_in,
                min_out,
                min_version,
            },
            arbswap::accounts::Swap {
                trader: to_address(trader.pubkey()),
                vault: self.vault,
                config: self.config,
                quote_state: self.quote_state,
                base_reserve: self.base_reserve,
                quote_reserve: self.quote_reserve,
                trader_base: self.trader_base,
                trader_quote: self.trader_quote,
                token_program: token_program_id(),
            },
        );
        send(&mut self.svm, &[trader], instruction)
    }

    fn warp_to_slot(&mut self, slot: u64) {
        self.svm.warp_to_slot(slot);
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.slot = slot;
        self.svm.set_sysvar(&clock);
    }

    fn vault_state(&self) -> Vault {
        read_state(&self.svm, self.vault)
    }

    fn quote_state_value(&self) -> QuoteState {
        read_state(&self.svm, self.quote_state)
    }

    fn config_state(&self) -> Config {
        read_state(&self.svm, self.config)
    }

    fn quote_buckets(&self) -> u64 {
        let vault = self.vault_state();
        vault.insurance_quote + vault.keeper_quote + vault.protocol_quote
    }
}

/// Every Pyth rejection path must fail before a quote is ever committed.
#[test]
fn pyth_verification_rejects_untrusted_or_stale_updates() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let update = quote_update(SLOT);

    let partial = fixture.post_pyth(
        PYTH_PRICE,
        1,
        PUBLISH_TIME,
        VerificationLevel::Partial { num_signatures: 1 },
    );
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, partial, update),
        "InvalidOracle",
    );

    let wrong_feed = fixture.post_pyth_with_feed([9u8; 32], PYTH_PRICE, 1, PUBLISH_TIME);
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, wrong_feed, update),
        "InvalidOracle",
    );

    let stale = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME - 100, VerificationLevel::Full);
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, stale, update),
        "InvalidOracle",
    );

    let wide_conf = fixture.post_pyth(
        PYTH_PRICE,
        100_000_000,
        PUBLISH_TIME,
        VerificationLevel::Full,
    );
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, wide_conf, update),
        "WideConfidence",
    );

    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    let mut bad_price = update;
    bad_price.oracle_price = 151 << 64;
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, honest, bad_price),
        "OraclePriceMismatch",
    );

    assert_anchor_error(
        fixture.update_quote(&keys.keeper, honest, quote_update(0)),
        "NonMonotonicSlot",
    );
    assert_anchor_error(fixture.update_quote(&keys.lp, honest, update), "NotKeeper");

    assert_eq!(
        fixture.quote_state_value().version,
        0,
        "no rejected update may commit"
    );

    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, update)
        .expect("verified update must be accepted");
    let quote = fixture.quote_state_value();
    assert_eq!(quote.version, 1);
    assert_eq!(quote.expiry_slot, SLOT + EXPIRY_SLOTS);
    assert_eq!(quote.oracle_publish_time, PUBLISH_TIME);
    assert_eq!(quote.oracle_conf_bps, CONF_BPS);
    assert_eq!(quote.ask_levels[0].sqrt_lo, ladder()[0].sqrt_lo);
}

/// A well-formed Pyth account that is not owned by the receiver program must be
/// rejected by Anchor's `Account<PriceUpdateV2>` owner check.
#[test]
fn pyth_account_owner_must_be_the_receiver_program() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let impostor = fixture.program_id;
    let forged = fixture.post_pyth_owned_by(impostor, PYTH_PRICE, 1, PUBLISH_TIME);
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, forged, quote_update(SLOT)),
        "AccountOwnedByWrongProgram",
    );
    assert_eq!(fixture.quote_state_value().version, 0);
}

/// The payload confidence must equal the confidence decoded from Pyth, not
/// merely sit under the configured maximum. `conf = 2_000_000` decodes to 2 bps
/// (within `max_conf_bps = 10`) while the payload claims 1 bps, so only the
/// equality check can reject it.
#[test]
fn oracle_confidence_must_match_the_payload() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let mismatched =
        fixture.post_pyth(PYTH_PRICE, 2_000_000, PUBLISH_TIME, VerificationLevel::Full);
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, mismatched, quote_update(SLOT)),
        "WideConfidence",
    );
    assert_eq!(fixture.quote_state_value().version, 0);
}

/// `wind_down` is admin-only, flips the vault status, and stops further quotes.
#[test]
fn wind_down_is_admin_only_and_pauses_quotes() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    assert_anchor_error(fixture.wind_down(&keys.lp), "Unauthorized");
    fixture.wind_down(&keys.admin).expect("admin may wind down");
    assert_eq!(fixture.vault_state().status, 2, "WIND_DOWN");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, honest, quote_update(SLOT)),
        "Paused",
    );
}

/// `update_quote` may not stamp a slot in the future (the current rule is
/// `stored < update_slot <= clock.slot`).
#[test]
fn future_update_slot_is_rejected() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, honest, quote_update(SLOT + 1_000_000)),
        "NonMonotonicSlot",
    );
    assert_eq!(fixture.quote_state_value().version, 0);
}

/// F-04: every executed level must sit inside the anchor band. A level priced
/// far from the oracle is rejected even though its shape is valid.
#[test]
fn level_far_from_the_anchor_is_rejected() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    let mut hostile = quote_update(SLOT);
    // ~9x the anchor price on the first level: shape-valid, wildly mispriced.
    hostile.ask_levels[0].sqrt_lo = ANCHOR_SQRT * 3;
    hostile.ask_levels[0].sqrt_hi = ANCHOR_SQRT * 3 + 1;
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, honest, hostile),
        "LevelOutOfBounds",
    );
    assert_eq!(fixture.quote_state_value().version, 0);
}

/// F-04: the reservation price may not deviate from the anchor by more than
/// `max_inventory_bps` (2000 bps = 20% in this fixture).
#[test]
fn reservation_outside_the_inventory_band_is_rejected() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    let mut skewed = quote_update(SLOT);
    skewed.p_res_sqrt = ANCHOR_SQRT / 2; // price ~ -75% from the anchor
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, honest, skewed),
        "InventoryOutOfBounds",
    );
    assert_eq!(fixture.quote_state_value().version, 0);
}

/// Item 2: bind the anchor to the **verified** Pyth price, not only to the
/// previous anchor. On the first update the previous anchor is 0 (the step check
/// is skipped), so an anchor 1000 bps above the 150 oracle must be rejected by
/// the new `max_anchor_dev_bps` bound.
#[test]
fn anchor_far_from_the_oracle_is_rejected() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    let mut bad = quote_update(SLOT);
    // anchor = sqrt(165) -> price 165 = 1000 bps above the 150 oracle (> 500).
    bad.anchor_sqrt_price = arb_math::sqrt_q64(165u128 << 64).unwrap();
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, honest, bad),
        "AnchorTooFarFromOracle",
    );
    assert_eq!(fixture.quote_state_value().version, 0);
}

/// Item 3 invariant: after any sequence of swaps, the physical reserves never
/// fall below the tracked (LP-excluded) liabilities. This is the on-chain form
/// of "ladder capacity may not draw on the fee buckets": the buckets are claims
/// on the reserves, so reserves must always cover insurance + keeper + protocol.
#[test]
fn reserves_never_fall_below_tracked_liabilities_after_swaps() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");

    let check = |fixture: &Fixture| {
        let v = fixture.vault_state();
        let base_reserve = token_amount(&fixture.svm, fixture.base_reserve);
        let quote_reserve = token_amount(&fixture.svm, fixture.quote_reserve);
        let base_liab = v
            .insurance_base
            .saturating_add(v.keeper_base)
            .saturating_add(v.protocol_base);
        let quote_liab = v
            .insurance_quote
            .saturating_add(v.keeper_quote)
            .saturating_add(v.protocol_quote);
        assert!(
            base_reserve >= base_liab,
            "base reserve {base_reserve} < liabilities {base_liab}"
        );
        assert!(
            quote_reserve >= quote_liab,
            "quote reserve {quote_reserve} < liabilities {quote_liab}"
        );
    };

    // A sequence of buys across quote refreshes (each swap retains fees that
    // accrue to the buckets, so the liabilities grow while they stay covered).
    for round in 0..4u64 {
        fixture.warp_to_slot(SLOT + 2 * round);
        let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
        fixture
            .update_quote(&keys.keeper, honest, quote_update(SLOT + 2 * round))
            .expect("quote");
        fixture
            .swap(&keys.trader, AMOUNT_IN, 0, 2 * round + 1)
            .expect("buy base");
        check(&fixture);
        fixture.warp_to_slot(SLOT + 2 * round + 1);
        let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
        fixture
            .update_quote(&keys.keeper, honest, quote_update(SLOT + 2 * round + 1))
            .expect("quote");
        fixture
            .swap(&keys.trader, AMOUNT_IN / 2, 0, 2 * round + 2)
            .expect("buy base again");
        check(&fixture);
    }
}

/// F-10: a second deposit reuses the (now `init_if_needed`) ticket, and the
/// depositor is charged only the amounts the minted shares are worth — the
/// imbalanced excess is not pulled.
#[test]
fn second_deposit_reuses_the_ticket_and_pulls_only_what_is_needed() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("first deposit");
    let total_before = fixture.vault_state().total_shares;
    let base_before = token_amount(&fixture.svm, fixture.lp_base);

    // Quote is the limiting side (small relative request), so most of the large
    // base request must stay in the depositor's wallet.
    let request_base = LP_BASE_DEPOSIT / 2;
    let request_quote = LP_QUOTE_DEPOSIT / 100;
    fixture
        .deposit(&keys.lp, request_base, request_quote, 1)
        .expect("second deposit must reuse the ticket");

    let base_after = token_amount(&fixture.svm, fixture.lp_base);
    assert!(
        base_after > base_before - request_base,
        "base excess was donated (F-10): spent {}",
        base_before - base_after
    );
    assert!(
        base_after < base_before,
        "some base must be pulled for the minted shares"
    );
    assert!(fixture.vault_state().total_shares > total_before);
}

/// F-11: a donation-inflation attacker who bloats a reserve cannot make a later
/// deposit succeed with zero shares; the deposit reverts and the attacker gains
/// nothing from the victim's tokens.
#[test]
fn donation_cannot_mint_zero_shares() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("first deposit");
    // Attacker donates a massive base amount directly to the reserve.
    set_token_account(
        &mut fixture.svm,
        fixture.base_reserve,
        fixture.base_mint,
        fixture.vault,
        10_000_000_000_000_000_000,
    );
    // A one-atom deposit would round to zero shares; it must be rejected, not
    // accepted for free.
    let shares_before = token_amount(&fixture.svm, fixture.lp_shares);
    assert_anchor_error(fixture.deposit(&keys.lp, 1, 1, 0), "InvalidAmount");
    assert_eq!(token_amount(&fixture.svm, fixture.lp_shares), shares_before);
}

/// F-17: parameter changes are timelocked and admin-only.
#[test]
fn params_change_is_timelocked() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let update = arbswap::ParamsUpdate {
        fee_bps: 5,
        ..Default::default()
    };
    assert_anchor_error(fixture.set_params(&keys.lp, update), "Unauthorized");
    fixture
        .set_params(&keys.admin, update)
        .expect("admin may propose");
    assert_anchor_error(fixture.apply_params(&keys.admin), "TimelockNotElapsed");

    let pending = read_state::<arbswap::PendingConfig>(&fixture.svm, fixture.pending_config());
    fixture.warp_to_slot(pending.activate_slot);
    fixture
        .apply_params(&keys.admin)
        .expect("apply after the timelock");
    assert_eq!(fixture.config_state().fee_bps, 5);
}

/// The program admin is claimed once; a second claim must fail.
#[test]
fn initialize_program_is_one_time() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let instruction = ix(
        fixture.program_id,
        arbswap::instruction::InitializeProgram {},
        arbswap::accounts::InitializeProgram {
            admin: to_address(keys.lp.pubkey()),
            program_config: fixture.program_config(),
            system_program: anchor_lang::system_program::ID,
        },
    );
    assert!(
        send(&mut fixture.svm, &[&keys.lp], instruction).is_err(),
        "the program config PDA must not be re-initialized"
    );
}

/// Admin-only controls cannot be driven by a non-admin.
#[test]
fn admin_only_controls_reject_non_admins() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    assert_anchor_error(fixture.reset_breaker(&keys.lp), "Unauthorized");
    assert_anchor_error(fixture.wind_down(&keys.lp), "Unauthorized");
    assert_anchor_error(
        fixture.set_params(
            &keys.lp,
            arbswap::ParamsUpdate {
                fee_bps: 1,
                ..Default::default()
            },
        ),
        "Unauthorized",
    );
}

/// The epoch crank is time-gated and permissionless.
#[test]
fn crank_epoch_before_its_interval_is_rejected() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    assert_anchor_error(fixture.crank_epoch(&keys.trader), "EpochNotReached");
}

/// Slippage, version and size guards on `swap`, all on one quoted vault.
#[test]
fn swap_enforces_slippage_version_and_size() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("quote");

    assert_anchor_error(
        fixture.swap(&keys.trader, AMOUNT_IN, u64::MAX, 1),
        "SlippageExceeded",
    );
    assert_anchor_error(fixture.swap(&keys.trader, AMOUNT_IN, 0, 2), "VersionTooOld");
    assert_anchor_error(
        fixture.swap(&keys.trader, MAX_QUOTE_SIZE + 1, 0, 1),
        "CapacityExceeded",
    );
}

/// Keeper outage (Build Plan §7.2): with no further updates the quote expires,
/// swaps stop, and the public breaker can pause the vault. This is the safe
/// failure mode — a down keeper cannot expose the vault.
#[test]
fn keeper_outage_lets_the_quote_expire() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("quote");
    // The keeper stops; time passes.
    let expiry = fixture.quote_state_value().expiry_slot;
    fixture.warp_to_slot(expiry + 1);
    assert_anchor_error(fixture.swap(&keys.trader, AMOUNT_IN, 0, 1), "QuoteExpired");
    fixture
        .trip_breaker(&keys.trader)
        .expect("public breaker trips on the stale quote");
    assert_eq!(fixture.vault_state().status, 1, "PAUSED");
}

/// A wound-down vault stops swaps.
#[test]
fn swap_stops_after_wind_down() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("quote");
    fixture.wind_down(&keys.admin).expect("wind down");
    assert_anchor_error(fixture.swap(&keys.trader, AMOUNT_IN, 0, 1), "Paused");
}

/// Account substitution: a withdraw request must use a token account of the
/// vault's share mint, not an attacker-chosen account.
#[test]
fn request_withdraw_rejects_a_foreign_share_account() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    // A token account owned by the LP but of the *base* mint.
    let foreign = Address::new_unique();
    set_token_account(
        &mut fixture.svm,
        foreign,
        fixture.base_mint,
        keys.lp.pubkey(),
        1_000,
    );
    let instruction = ix(
        fixture.program_id,
        arbswap::instruction::RequestWithdraw { shares: 1 },
        arbswap::accounts::RequestWithdraw {
            user: to_address(keys.lp.pubkey()),
            vault: fixture.vault,
            share_lock: fixture.share_lock,
            deposit_ticket: fixture.deposit_ticket,
            user_shares: foreign,
            withdraw_ticket: fixture.withdraw_ticket,
            token_program: token_program_id(),
            system_program: anchor_lang::system_program::ID,
        },
    );
    assert_anchor_error(
        send(&mut fixture.svm, &[&keys.lp], instruction),
        "ConstraintRaw",
    );
}

/// T3.4: the keeper bond is held in a vault-owned PDA; only the admin can slash
/// it, only up to the bonded amount, and slashed tokens go to insurance.
#[test]
fn keeper_bond_locks_quote_and_admin_slashes_to_insurance() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let before = token_amount(&fixture.svm, fixture.keeper_quote);
    fixture.bond_keeper(&keys.keeper, 1_000).expect("bond");
    assert_eq!(
        token_amount(&fixture.svm, fixture.keeper_quote),
        before - 1_000
    );
    assert_eq!(token_amount(&fixture.svm, fixture.bond_vault()), 1_000);

    assert_anchor_error(
        fixture.slash_keeper(&keys.lp, &keys.keeper, 100),
        "Unauthorized",
    );
    assert_anchor_error(
        fixture.slash_keeper(&keys.admin, &keys.keeper, 2_000),
        "InsufficientBond",
    );

    let reserve_before = token_amount(&fixture.svm, fixture.quote_reserve);
    fixture
        .slash_keeper(&keys.admin, &keys.keeper, 400)
        .expect("admin slash");
    assert_eq!(
        token_amount(&fixture.svm, fixture.quote_reserve),
        reserve_before + 400
    );
    assert_eq!(fixture.vault_state().insurance_quote, 400);
    assert_eq!(token_amount(&fixture.svm, fixture.bond_vault()), 600);
}

/// T3.4: the keeper claims exactly the accrued reward buckets, which are then
/// zeroed; a second claim pays nothing. No vault principal can be drained.
#[test]
fn keeper_reward_claim_pays_only_accrued_and_zeroes_it() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("quote");
    fixture
        .swap(&keys.trader, AMOUNT_IN, 0, 1)
        .expect("swap accrues keeper fees");

    let accrued = fixture.vault_state().keeper_quote;
    assert!(accrued > 0, "the swap must accrue a keeper reward");
    let before = token_amount(&fixture.svm, fixture.keeper_quote);

    fixture
        .claim_keeper_reward(&keys.keeper)
        .expect("keeper claims");
    assert_eq!(
        token_amount(&fixture.svm, fixture.keeper_quote),
        before + accrued
    );
    let vault = fixture.vault_state();
    assert_eq!(vault.keeper_quote, 0);
    assert_eq!(vault.keeper_base, 0);

    fixture
        .claim_keeper_reward(&keys.keeper)
        .expect("empty claim is a no-op");
    assert_eq!(
        token_amount(&fixture.svm, fixture.keeper_quote),
        before + accrued
    );
}

/// D-07: when `min_bond > 0`, an unbonded keeper cannot quote; bonding enables
/// it. This is the resolved bonded-keeper path (0 = allowlist MVP).
#[test]
fn update_quote_requires_a_keeper_bond() {
    let keys = Keys::new();
    let mut fixture = Fixture::with_min_bond(&keys, 1_000);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, honest, quote_update(SLOT)),
        "NotBonded",
    );
    fixture.bond_keeper(&keys.keeper, 1_000).expect("bond");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("a bonded keeper may quote");
}

/// Token-2022 owned accounts must be rejected by the classic `Program<Token>`
/// constraint, without ever reaching the instruction body.
#[test]
fn token_2022_accounts_are_rejected() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let foreign_base = Address::new_unique();
    set_foreign_token_account(
        &mut fixture.svm,
        foreign_base,
        fixture.base_mint,
        keys.lp.pubkey(),
        10_000_000_000,
        token_2022_program_id(),
    );

    let instruction = ix(
        fixture.program_id,
        arbswap::instruction::Deposit {
            base_amount: LP_BASE_DEPOSIT,
            quote_amount: LP_QUOTE_DEPOSIT,
            min_shares: 1,
        },
        arbswap::accounts::Deposit {
            user: to_address(keys.lp.pubkey()),
            vault: fixture.vault,
            config: fixture.config,
            base_reserve: fixture.base_reserve,
            quote_reserve: fixture.quote_reserve,
            share_mint: fixture.share_mint,
            share_lock: fixture.share_lock,
            user_base: foreign_base,
            user_quote: fixture.lp_quote,
            user_shares: fixture.lp_shares,
            deposit_ticket: fixture.deposit_ticket,
            token_program: token_program_id(),
            system_program: anchor_lang::system_program::ID,
        },
    );
    let result = send(&mut fixture.svm, &[&keys.lp], instruction);
    let failure = result.expect_err("Token-2022 owned account must be rejected");
    assert!(
        failure
            .meta
            .logs
            .iter()
            .any(|line| line.contains("Error Code: AccountOwnedByWrongProgram")),
        "expected AccountOwnedByWrongProgram in logs:\n{}",
        failure.meta.logs.join("\n")
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.lp_shares),
        0,
        "no shares minted"
    );
}

/// The full P2 money path with the fee/value invariants the review asked for.
#[test]
fn lifecycle_deposit_quote_swap_breaker_withdraw_preserves_value() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);

    // --- deposit -------------------------------------------------------
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("first deposit failed");
    assert_eq!(
        token_amount(&fixture.svm, fixture.base_reserve),
        LP_BASE_DEPOSIT
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.quote_reserve),
        LP_QUOTE_DEPOSIT
    );
    assert_eq!(token_amount(&fixture.svm, fixture.lp_shares), FIRST_SHARES);
    assert_eq!(
        token_amount(&fixture.svm, fixture.share_lock),
        1,
        "min-liquidity lock"
    );
    assert_eq!(fixture.vault_state().total_shares, TOTAL_SHARES);
    assert_eq!(fixture.config_state().keeper, keys.keeper.pubkey());

    // --- quote ---------------------------------------------------------
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("update_quote failed");
    assert_eq!(fixture.quote_state_value().version, 1);

    // --- swap ----------------------------------------------------------
    let expected_out = expected_swap_out();
    let base_before = token_amount(&fixture.svm, fixture.base_reserve);
    let quote_before = token_amount(&fixture.svm, fixture.quote_reserve);
    let trader_base_before = token_amount(&fixture.svm, fixture.trader_base);
    let trader_quote_before = token_amount(&fixture.svm, fixture.trader_quote);
    let buckets_before = fixture.quote_buckets();

    let swap_meta = fixture
        .swap(&keys.trader, AMOUNT_IN, expected_out as u64, 1)
        .expect("swap failed");
    println!("p2_swap_compute_units={}", swap_meta.compute_units_consumed);

    let base_after = token_amount(&fixture.svm, fixture.base_reserve);
    let quote_after = token_amount(&fixture.svm, fixture.quote_reserve);
    let vault = fixture.vault_state();
    let buckets_after = vault.insurance_quote + vault.keeper_quote + vault.protocol_quote;

    // Trader pays the full input; the vault pays exactly the quoted output.
    assert_eq!(quote_after, quote_before + AMOUNT_IN);
    assert_eq!(base_before - base_after, expected_out as u64);
    assert_eq!(
        trader_quote_before - token_amount(&fixture.svm, fixture.trader_quote),
        AMOUNT_IN
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.trader_base) - trader_base_before,
        expected_out as u64
    );

    // Fees are bucketed, never more than the fee actually taken.
    assert!(buckets_after > buckets_before, "fee split must be non-zero");
    assert!(
        buckets_after - buckets_before <= FEE,
        "buckets must not exceed the fee"
    );
    // LP-owned quote only loses the bucketed fees, never the raw input.
    assert_eq!(
        quote_after - buckets_after - (quote_before - buckets_before),
        AMOUNT_IN - (buckets_after - buckets_before)
    );
    assert_eq!(
        vault.total_shares, TOTAL_SHARES,
        "swap must not mint shares"
    );

    // --- negative swap guards -----------------------------------------
    assert_anchor_error(fixture.swap(&keys.trader, AMOUNT_IN, 0, 2), "VersionTooOld");
    assert_anchor_error(
        fixture.swap(&keys.trader, AMOUNT_IN, (expected_out as u64) + 1, 1),
        "SlippageExceeded",
    );
    assert_anchor_error(
        fixture.swap(&keys.trader, MAX_QUOTE_SIZE + 1, 0, 1),
        "CapacityExceeded",
    );

    // --- expiry, breaker, reset ---------------------------------------
    let expiry_slot = fixture.quote_state_value().expiry_slot;
    fixture.warp_to_slot(expiry_slot);
    assert_anchor_error(fixture.swap(&keys.trader, AMOUNT_IN, 0, 1), "QuoteExpired");

    let trip = ix(
        fixture.program_id,
        arbswap::instruction::TripBreaker,
        arbswap::accounts::TripBreaker {
            vault: fixture.vault,
            config: fixture.config,
            quote_state: fixture.quote_state,
        },
    );
    send(&mut fixture.svm, &[&keys.lp], trip).expect("trip_breaker failed");
    assert_eq!(fixture.vault_state().status, 1, "vault paused after expiry");

    assert_anchor_error(fixture.swap(&keys.trader, AMOUNT_IN, 0, 1), "Paused");

    let reset = ix(
        fixture.program_id,
        arbswap::instruction::ResetBreaker,
        arbswap::accounts::ResetBreaker {
            admin: to_address(keys.admin.pubkey()),
            vault: fixture.vault,
        },
    );
    send(&mut fixture.svm, &[&keys.admin], reset).expect("reset_breaker failed");
    assert_eq!(
        fixture.vault_state().status,
        0,
        "vault active after admin reset"
    );

    // --- withdrawal ----------------------------------------------------
    let shares = token_amount(&fixture.svm, fixture.lp_shares);
    assert_eq!(shares, FIRST_SHARES);
    let request = ix(
        fixture.program_id,
        arbswap::instruction::RequestWithdraw { shares },
        arbswap::accounts::RequestWithdraw {
            user: to_address(keys.lp.pubkey()),
            vault: fixture.vault,
            share_lock: fixture.share_lock,
            deposit_ticket: fixture.deposit_ticket,
            user_shares: fixture.lp_shares,
            withdraw_ticket: fixture.withdraw_ticket,
            token_program: token_program_id(),
            system_program: anchor_lang::system_program::ID,
        },
    );
    send(&mut fixture.svm, &[&keys.lp], request).expect("request_withdraw failed");
    assert_eq!(token_amount(&fixture.svm, fixture.lp_shares), 0);
    assert_eq!(token_amount(&fixture.svm, fixture.share_lock), 1 + shares);

    let crank = ix(
        fixture.program_id,
        arbswap::instruction::CrankEpoch,
        arbswap::accounts::CrankEpoch {
            vault: fixture.vault,
            config: fixture.config,
        },
    );
    send(&mut fixture.svm, &[&keys.lp], crank).expect("crank_epoch failed");
    assert_eq!(fixture.vault_state().epoch, 1);

    let vault_before = fixture.vault_state();
    let total = vault_before.total_shares;
    let base_available = token_amount(&fixture.svm, fixture.base_reserve)
        .saturating_sub(vault_before.insurance_base)
        .saturating_sub(vault_before.keeper_base)
        .saturating_sub(vault_before.protocol_base);
    let quote_available = token_amount(&fixture.svm, fixture.quote_reserve)
        .saturating_sub(vault_before.insurance_quote)
        .saturating_sub(vault_before.keeper_quote)
        .saturating_sub(vault_before.protocol_quote);
    let expected_base_out = (shares as u128) * (base_available as u128) / (total as u128);
    let expected_quote_out = (shares as u128) * (quote_available as u128) / (total as u128);

    let claim = ix(
        fixture.program_id,
        arbswap::instruction::ClaimWithdraw,
        arbswap::accounts::ClaimWithdraw {
            user: to_address(keys.lp.pubkey()),
            vault: fixture.vault,
            base_reserve: fixture.base_reserve,
            quote_reserve: fixture.quote_reserve,
            share_mint: fixture.share_mint,
            share_lock: fixture.share_lock,
            withdraw_ticket: fixture.withdraw_ticket,
            user_base: fixture.lp_base,
            user_quote: fixture.lp_quote,
            token_program: token_program_id(),
        },
    );
    let lp_base_before = token_amount(&fixture.svm, fixture.lp_base);
    let lp_quote_before = token_amount(&fixture.svm, fixture.lp_quote);
    send(&mut fixture.svm, &[&keys.lp], claim).expect("claim_withdraw failed");

    assert_eq!(fixture.vault_state().total_shares, total - shares);
    assert_eq!(
        token_amount(&fixture.svm, fixture.share_lock),
        1,
        "lock survives the claim"
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.lp_base) - lp_base_before,
        expected_base_out as u64
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.lp_quote) - lp_quote_before,
        expected_quote_out as u64
    );

    // --- global value conservation --------------------------------------
    // Fees only re-bucket value *inside* the quote reserve; deposit, quote,
    // swap, breaker and withdrawal must not create or destroy a single token.
    assert_eq!(
        token_amount(&fixture.svm, fixture.lp_base)
            + token_amount(&fixture.svm, fixture.trader_base)
            + token_amount(&fixture.svm, fixture.base_reserve),
        2 * 10_000_000_000,
        "base must be conserved across every holder"
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.lp_quote)
            + token_amount(&fixture.svm, fixture.trader_quote)
            + token_amount(&fixture.svm, fixture.quote_reserve),
        2 * 10_000_000_000,
        "quote must be conserved across every holder"
    );
    let vault = fixture.vault_state();
    assert_eq!(
        vault.insurance_quote + vault.keeper_quote + vault.protocol_quote,
        buckets_after,
        "breaker/reset/crank must not move bucketed fees"
    );
}

/// Item 5: the keeper role can be rotated through the timelock, so a compromised
/// or retired keeper key cannot permanently DoS quoting. After the change the
/// old key is rejected with `NotKeeper`.
#[test]
fn keeper_can_be_rotated_via_the_timelock() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let new_keeper = Keypair::new();
    airdrop(&mut fixture.svm, &new_keeper, 10_000_000_000);

    let rotation = arbswap::ParamsUpdate {
        keeper: Some(new_keeper.pubkey()),
        ..Default::default()
    };
    fixture
        .set_params(&keys.admin, rotation)
        .expect("admin proposes the rotation");
    let pending = read_state::<arbswap::PendingConfig>(&fixture.svm, fixture.pending_config());
    fixture.warp_to_slot(pending.activate_slot);
    fixture
        .apply_params(&keys.admin)
        .expect("rotation applies after the timelock");
    assert_eq!(fixture.config_state().keeper, new_keeper.pubkey());

    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, honest, quote_update(SLOT)),
        "NotKeeper",
    );
}

/// Item 5: a fee claim is timelocked and can only ever pay the fixed
/// `config.treasury`. Before the timelock it is rejected; after it, only the
/// requested LP-excluded bucket moves and LP shares are untouched.
#[test]
fn fee_claim_is_timelocked_and_pays_only_the_fixed_treasury() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("quote");
    fixture
        .swap(&keys.trader, AMOUNT_IN, 0, 1)
        .expect("swap accrues fees");

    let vault0 = fixture.vault_state();
    assert!(vault0.protocol_quote > 0, "swap must accrue protocol fees");
    let shares_before = vault0.total_shares;

    let treasury_base = Address::new_unique();
    let treasury_quote = Address::new_unique();
    set_token_account(
        &mut fixture.svm,
        treasury_base,
        fixture.base_mint,
        keys.admin.pubkey(), // config.treasury == admin
        0,
    );
    set_token_account(
        &mut fixture.svm,
        treasury_quote,
        fixture.quote_mint,
        keys.admin.pubkey(),
        0,
    );
    let claim_pda = pda(&[b"claim", fixture.vault.as_ref()], &fixture.program_id).0;

    let propose = ix(
        fixture.program_id,
        arbswap::instruction::ProposeFeeClaim {
            kind: arbswap::FeeKind::Protocol,
        },
        arbswap::accounts::ProposeFeeClaim {
            admin: to_address(keys.admin.pubkey()),
            vault: fixture.vault,
            pending_claim: claim_pda,
            system_program: anchor_lang::system_program::ID,
        },
    );
    send(&mut fixture.svm, &[&keys.admin], propose).expect("propose");
    let pending = read_state::<arbswap::PendingClaim>(&fixture.svm, claim_pda);

    let program_id = fixture.program_id;
    let vault = fixture.vault;
    let config = fixture.config;
    let base_reserve = fixture.base_reserve;
    let quote_reserve = fixture.quote_reserve;
    let admin = to_address(keys.admin.pubkey());
    let execute = move || {
        ix(
            program_id,
            arbswap::instruction::ExecuteFeeClaim {},
            arbswap::accounts::ExecuteFeeClaim {
                admin,
                vault,
                config,
                pending_claim: claim_pda,
                base_reserve,
                quote_reserve,
                treasury_base,
                treasury_quote,
                token_program: token_program_id(),
            },
        )
    };

    // Before the timelock: rejected.
    assert_anchor_error(
        send(&mut fixture.svm, &[&keys.admin], execute()),
        "TimelockNotElapsed",
    );

    // After the timelock: protocol bucket moves to the fixed treasury.
    fixture.warp_to_slot(pending.activate_slot);
    let before = token_amount(&fixture.svm, treasury_quote);
    send(&mut fixture.svm, &[&keys.admin], execute()).expect("execute after timelock");
    assert_eq!(
        token_amount(&fixture.svm, treasury_quote),
        before + vault0.protocol_quote
    );
    let vault1 = fixture.vault_state();
    assert_eq!(vault1.protocol_quote, 0, "protocol bucket zeroed");
    assert_eq!(vault1.total_shares, shares_before, "LP shares untouched");
}

/// Item 7: measure the compute units of every instruction the caller pays for.
/// Run with `-- --nocapture` to read the values. (The program is not in the CI
/// clippy set and the CU table had only 3 rows; this closes the measurement gap.)
#[test]
fn measure_instruction_compute_units() {
    let keys = Keys::new();
    let mut fixture = Fixture::with_min_bond(&keys, 1_000);

    let m = fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    println!("cu_deposit={}", m.compute_units_consumed);

    // Bond first (min_bond = 1000), then quote.
    let m = fixture
        .bond_keeper(&keys.keeper, 1_000)
        .expect("bond_keeper");
    println!("cu_bond_keeper={}", m.compute_units_consumed);

    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    let m = fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("update_quote");
    println!("cu_update_quote={}", m.compute_units_consumed);

    // A Pyth-rejected update (wide confidence) stops right after verification;
    // the gap to the successful update bounds the post-oracle validation cost.
    let wide = fixture.post_pyth(PYTH_PRICE, 1_000_000, PUBLISH_TIME, VerificationLevel::Full);
    if let Err(fail) = fixture.update_quote(&keys.keeper, wide, quote_update(SLOT + 1)) {
        println!(
            "cu_update_quote_wide_conf_rejected={}",
            fail.meta.compute_units_consumed
        );
    }

    let m = fixture.swap(&keys.trader, AMOUNT_IN, 0, 1).expect("swap");
    println!("cu_swap={}", m.compute_units_consumed);

    let m = fixture
        .claim_keeper_reward(&keys.keeper)
        .expect("claim_keeper_reward");
    println!("cu_claim_keeper_reward={}", m.compute_units_consumed);

    let m = fixture
        .slash_keeper(&keys.admin, &keys.keeper, 1_000)
        .expect("slash_keeper");
    println!("cu_slash_keeper={}", m.compute_units_consumed);

    // request_withdraw (after warm-up), crank_epoch, claim_withdraw.
    fixture.warp_to_slot(SLOT + 2);
    let shares = token_amount(&fixture.svm, fixture.lp_shares);
    let request = ix(
        fixture.program_id,
        arbswap::instruction::RequestWithdraw { shares },
        arbswap::accounts::RequestWithdraw {
            user: to_address(keys.lp.pubkey()),
            vault: fixture.vault,
            share_lock: fixture.share_lock,
            deposit_ticket: fixture.deposit_ticket,
            user_shares: fixture.lp_shares,
            withdraw_ticket: fixture.withdraw_ticket,
            token_program: token_program_id(),
            system_program: anchor_lang::system_program::ID,
        },
    );
    let m = send(&mut fixture.svm, &[&keys.lp], request).expect("request_withdraw");
    println!("cu_request_withdraw={}", m.compute_units_consumed);

    fixture.warp_to_slot(SLOT + 100);
    let crank = ix(
        fixture.program_id,
        arbswap::instruction::CrankEpoch,
        arbswap::accounts::CrankEpoch {
            vault: fixture.vault,
            config: fixture.config,
        },
    );
    let m = send(&mut fixture.svm, &[&keys.lp], crank).expect("crank_epoch");
    println!("cu_crank_epoch={}", m.compute_units_consumed);

    let claim = ix(
        fixture.program_id,
        arbswap::instruction::ClaimWithdraw,
        arbswap::accounts::ClaimWithdraw {
            user: to_address(keys.lp.pubkey()),
            vault: fixture.vault,
            base_reserve: fixture.base_reserve,
            quote_reserve: fixture.quote_reserve,
            share_mint: fixture.share_mint,
            share_lock: fixture.share_lock,
            withdraw_ticket: fixture.withdraw_ticket,
            user_base: fixture.lp_base,
            user_quote: fixture.lp_quote,
            token_program: token_program_id(),
        },
    );
    let m = send(&mut fixture.svm, &[&keys.lp], claim).expect("claim_withdraw");
    println!("cu_claim_withdraw={}", m.compute_units_consumed);
}

/// Item 1a (negative): the per-window cumulative one-sided flow cap rejects a
/// keeper-driven run of same-side swaps once the window cap is exceeded, and the
/// cap is NOT reset by refreshing the quote (only by the slot window rolling).
#[test]
fn window_flow_cap_stops_one_sided_flow() {
    let keys = Keys::new();
    // 1 bp of the base reserve, so the cap is small in this fixture.
    let mut fixture = Fixture::with_config(&keys, 0, 100, 1);
    // Small reserve: cap = 10_000 * 1 / 10_000 = 1 base atom.
    fixture
        .deposit(&keys.lp, 10_000, 1_500_000, 1)
        .expect("deposit");

    let mut tripped = false;
    for i in 0..40u64 {
        fixture.warp_to_slot(SLOT + i);
        let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
        fixture
            .update_quote(&keys.keeper, honest, quote_update(SLOT + i))
            .expect("quote");
        match fixture.swap(&keys.trader, AMOUNT_IN, 0, i + 1) {
            Ok(_) => {}
            Err(fail) => {
                assert!(
                    fail.meta
                        .logs
                        .iter()
                        .any(|line| line.contains("FlowCapExceeded")),
                    "unexpected error: {:?}",
                    fail.meta.logs
                );
                tripped = true;
                break;
            }
        }
    }
    assert!(tripped, "the per-window flow cap never tripped");
}

/// Item 1c: the insurance buffer cannot be claimed to the treasury; only the
/// protocol bucket is claimable.
#[test]
fn insurance_bucket_cannot_be_claimed_to_treasury() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let claim_pda = pda(&[b"claim", fixture.vault.as_ref()], &fixture.program_id).0;
    let propose = |kind: arbswap::FeeKind| {
        ix(
            fixture.program_id,
            arbswap::instruction::ProposeFeeClaim { kind },
            arbswap::accounts::ProposeFeeClaim {
                admin: to_address(keys.admin.pubkey()),
                vault: fixture.vault,
                pending_claim: claim_pda,
                system_program: anchor_lang::system_program::ID,
            },
        )
    };
    // Borrow fix: build the two instructions before sending.
    let ins = ix(
        fixture.program_id,
        arbswap::instruction::ProposeFeeClaim {
            kind: arbswap::FeeKind::Insurance,
        },
        arbswap::accounts::ProposeFeeClaim {
            admin: to_address(keys.admin.pubkey()),
            vault: fixture.vault,
            pending_claim: claim_pda,
            system_program: anchor_lang::system_program::ID,
        },
    );
    assert_anchor_error(
        send(&mut fixture.svm, &[&keys.admin], ins),
        "InsuranceNotClaimable",
    );
    let proto = propose(arbswap::FeeKind::Protocol);
    send(&mut fixture.svm, &[&keys.admin], proto).expect("protocol claim proposes");
}

/// F-14 (partial): a deterministic state-machine test. Drives a pseudo-random
/// sequence of quote updates and buy/sell swaps and asserts the money
/// invariants hold after every action (reserves cover the tracked liabilities,
/// shares are consistent) and that only *expected* errors occur.
#[test]
fn state_machine_random_actions_preserve_invariants() {
    let keys = Keys::new();
    let mut fixture = Fixture::with_config(&keys, 0, 100, 10_000);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");

    // Deterministic LCG.
    let mut state: u64 = 0x1234_5678_9ABC_DEF0;
    let mut next = move || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        state >> 33
    };

    let mut slot = SLOT;
    for step in 0..120u64 {
        slot += 1;
        fixture.warp_to_slot(slot);
        let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
        fixture
            .update_quote(&keys.keeper, honest, quote_update(slot))
            .expect("quote in a healthy state");

        // Alternate buy/sell with a pseudo-random amount.
        let side = if next() % 2 == 0 {
            arbswap::SwapSide::BuyBase
        } else {
            arbswap::SwapSide::SellBase
        };
        let amount = 10_000 + (next() % 90_000);
        let ix = ix(
            fixture.program_id,
            arbswap::instruction::Swap {
                side,
                amount_in: amount,
                min_out: 0,
                min_version: step + 1,
            },
            arbswap::accounts::Swap {
                trader: to_address(keys.trader.pubkey()),
                vault: fixture.vault,
                config: fixture.config,
                quote_state: fixture.quote_state,
                base_reserve: fixture.base_reserve,
                quote_reserve: fixture.quote_reserve,
                trader_base: fixture.trader_base,
                trader_quote: fixture.trader_quote,
                token_program: token_program_id(),
            },
        );
        match send(&mut fixture.svm, &[&keys.trader], ix) {
            Ok(_) => {}
            Err(fail) => {
                // Only liquidity/flow-cap/slippage failures are acceptable.
                let logs = fail.meta.logs.join(" ");
                assert!(
                    logs.contains("CapacityExceeded")
                        || logs.contains("FlowCapExceeded")
                        || logs.contains("QuoteExpired")
                        || logs.contains("SlippageExceeded"),
                    "unexpected error at step {step}: {logs}"
                );
            }
        }

        // Invariant: reserves cover the tracked (LP-excluded) liabilities.
        let v = fixture.vault_state();
        let base_reserve = token_amount(&fixture.svm, fixture.base_reserve);
        let quote_reserve = token_amount(&fixture.svm, fixture.quote_reserve);
        assert!(
            base_reserve >= v.insurance_base + v.keeper_base + v.protocol_base,
            "step {step}: base reserve below liabilities"
        );
        assert!(
            quote_reserve >= v.insurance_quote + v.keeper_quote + v.protocol_quote,
            "step {step}: quote reserve below liabilities"
        );
        assert!(v.total_shares > 0, "step {step}: shares vanished");
    }
}

/// T1 / P2-F01 (regression): `claim_withdraw` must bind the ticket to *this*
/// vault. A `WithdrawTicket` whose PDA belongs to a different vault but is owned
/// by the same user must be rejected, otherwise its `shares` could be burned out
/// of this vault's `share_lock`, paying the caller with other queued
/// withdrawers' shares.
#[test]
fn claim_withdraw_rejects_a_ticket_from_another_vault() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);

    // LP deposits, warms up, and queues a real withdrawal so this vault's
    // `share_lock` holds queued shares.
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    fixture.warp_to_slot(SLOT + 2);
    let shares = token_amount(&fixture.svm, fixture.lp_shares);
    let request = ix(
        fixture.program_id,
        arbswap::instruction::RequestWithdraw { shares },
        arbswap::accounts::RequestWithdraw {
            user: to_address(keys.lp.pubkey()),
            vault: fixture.vault,
            share_lock: fixture.share_lock,
            deposit_ticket: fixture.deposit_ticket,
            user_shares: fixture.lp_shares,
            withdraw_ticket: fixture.withdraw_ticket,
            token_program: token_program_id(),
            system_program: anchor_lang::system_program::ID,
        },
    );
    send(&mut fixture.svm, &[&keys.lp], request).expect("request_withdraw");
    assert_eq!(token_amount(&fixture.svm, fixture.share_lock), 1 + shares);

    fixture.warp_to_slot(SLOT + 100);
    let crank = ix(
        fixture.program_id,
        arbswap::instruction::CrankEpoch {},
        arbswap::accounts::CrankEpoch {
            vault: fixture.vault,
            config: fixture.config,
        },
    );
    send(&mut fixture.svm, &[&keys.lp], crank).expect("crank_epoch");

    // A program-owned ticket whose PDA belongs to a *different* vault.
    let foreign_base = Address::new_unique();
    let foreign_quote = Address::new_unique();
    let (foreign_vault, _) = pda(
        &[b"vault", foreign_base.as_ref(), foreign_quote.as_ref()],
        &fixture.program_id,
    );
    let lp_address = to_address(keys.lp.pubkey());
    let (foreign_ticket, foreign_bump) = pda(
        &[b"wd", foreign_vault.as_ref(), lp_address.as_ref()],
        &fixture.program_id,
    );
    let ticket = arbswap::WithdrawTicket {
        owner: keys.lp.pubkey(),
        shares,
        epoch: 0,
        bump: foreign_bump,
    };
    fixture
        .svm
        .set_account(
            foreign_ticket,
            solana_account::Account {
                lamports: 1_000_000_000,
                data: account_data(&ticket),
                owner: fixture.program_id,
                ..solana_account::Account::default()
            },
        )
        .unwrap();

    let claim = ix(
        fixture.program_id,
        arbswap::instruction::ClaimWithdraw {},
        arbswap::accounts::ClaimWithdraw {
            user: to_address(keys.lp.pubkey()),
            vault: fixture.vault,
            base_reserve: fixture.base_reserve,
            quote_reserve: fixture.quote_reserve,
            share_mint: fixture.share_mint,
            share_lock: fixture.share_lock,
            withdraw_ticket: foreign_ticket,
            user_base: fixture.lp_base,
            user_quote: fixture.lp_quote,
            token_program: token_program_id(),
        },
    );
    assert_anchor_error(
        send(&mut fixture.svm, &[&keys.lp], claim),
        "ConstraintSeeds",
    );
}

// ---------------------------------------------------------------------------
// T1b: account-binding substitution negatives (one test per account type).
// A wrong-vault or wrong-account substitution must be rejected at account
// validation, before the instruction body runs. Binding table:
// docs/SECURITY_CHECKLIST.md.
// ---------------------------------------------------------------------------

/// A program-owned `Vault`-anchored PDA for a *different* mint pair, so tests
/// can create foreign tickets/bonds/configs whose seeds point at another vault.
fn foreign_vault_address(program_id: &Address) -> Address {
    let base = Address::new_unique();
    let quote = Address::new_unique();
    let (vault, _) = pda(&[b"vault", base.as_ref(), quote.as_ref()], program_id);
    vault
}

#[test]
fn swap_rejects_a_reserve_from_another_vault() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let swap = ix(
        fixture.program_id,
        arbswap::instruction::Swap {
            side: arbswap::SwapSide::BuyBase,
            amount_in: 1,
            min_out: 0,
            min_version: 0,
        },
        arbswap::accounts::Swap {
            trader: to_address(keys.trader.pubkey()),
            vault: fixture.vault,
            config: fixture.config,
            quote_state: fixture.quote_state,
            base_reserve: fixture.lp_base, // not vault.base_reserve
            quote_reserve: fixture.quote_reserve,
            trader_base: fixture.trader_base,
            trader_quote: fixture.trader_quote,
            token_program: token_program_id(),
        },
    );
    assert_anchor_error(
        send(&mut fixture.svm, &[&keys.trader], swap),
        "ConstraintAddress",
    );
}

/// Deposit, warm up and queue a withdrawal so a real ticket exists and account
/// validation reaches the corrupted account instead of stopping early.
fn queue_a_withdrawal(fixture: &mut Fixture, keys: &Keys) {
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    fixture.warp_to_slot(SLOT + 2);
    let shares = token_amount(&fixture.svm, fixture.lp_shares);
    let request = ix(
        fixture.program_id,
        arbswap::instruction::RequestWithdraw { shares },
        arbswap::accounts::RequestWithdraw {
            user: to_address(keys.lp.pubkey()),
            vault: fixture.vault,
            share_lock: fixture.share_lock,
            deposit_ticket: fixture.deposit_ticket,
            user_shares: fixture.lp_shares,
            withdraw_ticket: fixture.withdraw_ticket,
            token_program: token_program_id(),
            system_program: anchor_lang::system_program::ID,
        },
    );
    send(&mut fixture.svm, &[&keys.lp], request).expect("request_withdraw");
}

#[test]
fn claim_withdraw_rejects_a_foreign_share_lock() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    queue_a_withdrawal(&mut fixture, &keys);
    let claim = ix(
        fixture.program_id,
        arbswap::instruction::ClaimWithdraw {},
        arbswap::accounts::ClaimWithdraw {
            user: to_address(keys.lp.pubkey()),
            vault: fixture.vault,
            base_reserve: fixture.base_reserve,
            quote_reserve: fixture.quote_reserve,
            share_mint: fixture.share_mint,
            share_lock: fixture.lp_shares, // not vault.share_lock
            withdraw_ticket: fixture.withdraw_ticket,
            user_base: fixture.lp_base,
            user_quote: fixture.lp_quote,
            token_program: token_program_id(),
        },
    );
    assert_account_rejected(send(&mut fixture.svm, &[&keys.lp], claim), "share_lock");
}

#[test]
fn claim_withdraw_rejects_a_foreign_share_mint() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    queue_a_withdrawal(&mut fixture, &keys);
    let claim = ix(
        fixture.program_id,
        arbswap::instruction::ClaimWithdraw {},
        arbswap::accounts::ClaimWithdraw {
            user: to_address(keys.lp.pubkey()),
            vault: fixture.vault,
            base_reserve: fixture.base_reserve,
            quote_reserve: fixture.quote_reserve,
            share_mint: fixture.base_mint, // not vault.share_mint
            share_lock: fixture.share_lock,
            withdraw_ticket: fixture.withdraw_ticket,
            user_base: fixture.lp_base,
            user_quote: fixture.lp_quote,
            token_program: token_program_id(),
        },
    );
    assert_account_rejected(send(&mut fixture.svm, &[&keys.lp], claim), "share_mint");
}

#[test]
fn request_withdraw_rejects_a_deposit_ticket_from_another_vault() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let foreign_vault = foreign_vault_address(&fixture.program_id);
    let lp = to_address(keys.lp.pubkey());
    let (foreign_deposit_ticket, bump) = pda(
        &[b"dep", foreign_vault.as_ref(), lp.as_ref()],
        &fixture.program_id,
    );
    let ticket = DepositTicket {
        owner: keys.lp.pubkey(),
        shares: 1,
        activate_slot: 0,
        bump,
    };
    fixture
        .svm
        .set_account(
            foreign_deposit_ticket,
            solana_account::Account {
                lamports: 1_000_000_000,
                data: account_data(&ticket),
                owner: fixture.program_id,
                ..solana_account::Account::default()
            },
        )
        .unwrap();
    let request = ix(
        fixture.program_id,
        arbswap::instruction::RequestWithdraw { shares: 1 },
        arbswap::accounts::RequestWithdraw {
            user: lp,
            vault: fixture.vault,
            share_lock: fixture.share_lock,
            deposit_ticket: foreign_deposit_ticket, // not this vault's ticket
            user_shares: fixture.lp_shares,
            withdraw_ticket: fixture.withdraw_ticket,
            token_program: token_program_id(),
            system_program: anchor_lang::system_program::ID,
        },
    );
    assert_anchor_error(
        send(&mut fixture.svm, &[&keys.lp], request),
        "ConstraintSeeds",
    );
}

#[test]
fn slash_keeper_rejects_a_bond_from_another_vault() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    // Create this vault's bond vault + keeper bond so validation reaches the
    // (foreign) keeper bond account rather than stopping on a missing account.
    fixture
        .bond_keeper(&keys.keeper, 1_000)
        .expect("bond_keeper");
    let foreign_vault = foreign_vault_address(&fixture.program_id);
    let (foreign_bond, bump) = pda(
        &[
            b"keeper",
            foreign_vault.as_ref(),
            keys.keeper.pubkey().as_ref(),
        ],
        &fixture.program_id,
    );
    let bond = KeeperBond {
        keeper: keys.keeper.pubkey(),
        bond: 1_000,
        slashed: 0,
        unbond_amount: 0,
        unbond_ready_slot: 0,
        bump,
    };
    fixture
        .svm
        .set_account(
            foreign_bond,
            solana_account::Account {
                lamports: 1_000_000_000,
                data: account_data(&bond),
                owner: fixture.program_id,
                ..solana_account::Account::default()
            },
        )
        .unwrap();
    let slash = ix(
        fixture.program_id,
        arbswap::instruction::SlashKeeper { amount: 1 },
        arbswap::accounts::SlashKeeper {
            admin: to_address(keys.admin.pubkey()),
            vault: fixture.vault,
            quote_reserve: fixture.quote_reserve,
            keeper: to_address(keys.keeper.pubkey()),
            keeper_bond: foreign_bond, // not this vault's keeper bond
            bond_vault: fixture.bond_vault(),
            token_program: token_program_id(),
        },
    );
    assert_account_rejected(send(&mut fixture.svm, &[&keys.admin], slash), "keeper_bond");
}

#[test]
fn slash_keeper_rejects_a_bond_vault_from_another_vault() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .bond_keeper(&keys.keeper, 1_000)
        .expect("bond_keeper");
    let slash = ix(
        fixture.program_id,
        arbswap::instruction::SlashKeeper { amount: 1 },
        arbswap::accounts::SlashKeeper {
            admin: to_address(keys.admin.pubkey()),
            vault: fixture.vault,
            quote_reserve: fixture.quote_reserve,
            keeper: to_address(keys.keeper.pubkey()),
            keeper_bond: fixture.keeper_bond(&keys.keeper),
            bond_vault: fixture.lp_base, // not the [b"bond", vault] account
            token_program: token_program_id(),
        },
    );
    assert_account_rejected(send(&mut fixture.svm, &[&keys.admin], slash), "bond_vault");
}

#[test]
fn swap_rejects_a_config_from_another_vault() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let foreign_vault = foreign_vault_address(&fixture.program_id);
    let (foreign_config, _) = pda(&[b"config", foreign_vault.as_ref()], &fixture.program_id);
    let config_value: Config = read_state(&fixture.svm, fixture.config);
    fixture
        .svm
        .set_account(
            foreign_config,
            solana_account::Account {
                lamports: 1_000_000_000,
                data: account_data(&config_value),
                owner: fixture.program_id,
                ..solana_account::Account::default()
            },
        )
        .unwrap();
    let swap = ix(
        fixture.program_id,
        arbswap::instruction::Swap {
            side: arbswap::SwapSide::BuyBase,
            amount_in: 1,
            min_out: 0,
            min_version: 0,
        },
        arbswap::accounts::Swap {
            trader: to_address(keys.trader.pubkey()),
            vault: fixture.vault,
            config: foreign_config, // not this vault's config
            quote_state: fixture.quote_state,
            base_reserve: fixture.base_reserve,
            quote_reserve: fixture.quote_reserve,
            trader_base: fixture.trader_base,
            trader_quote: fixture.trader_quote,
            token_program: token_program_id(),
        },
    );
    assert_anchor_error(
        send(&mut fixture.svm, &[&keys.trader], swap),
        "ConstraintSeeds",
    );
}

#[test]
fn execute_fee_claim_rejects_a_non_treasury_destination() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("quote");
    fixture
        .swap(&keys.trader, AMOUNT_IN, 0, 1)
        .expect("swap accrues protocol fees");
    assert!(fixture.vault_state().protocol_quote > 0);

    let claim_pda = pda(&[b"claim", fixture.vault.as_ref()], &fixture.program_id).0;
    let propose = ix(
        fixture.program_id,
        arbswap::instruction::ProposeFeeClaim {
            kind: arbswap::FeeKind::Protocol,
        },
        arbswap::accounts::ProposeFeeClaim {
            admin: to_address(keys.admin.pubkey()),
            vault: fixture.vault,
            pending_claim: claim_pda,
            system_program: anchor_lang::system_program::ID,
        },
    );
    send(&mut fixture.svm, &[&keys.admin], propose).expect("propose");
    let pending = read_state::<arbswap::PendingClaim>(&fixture.svm, claim_pda);
    fixture.warp_to_slot(pending.activate_slot);

    // Treasury accounts owned by the LP, not config.treasury (the admin).
    let wrong_base = Address::new_unique();
    let wrong_quote = Address::new_unique();
    set_token_account(
        &mut fixture.svm,
        wrong_base,
        fixture.base_mint,
        keys.lp.pubkey(),
        0,
    );
    set_token_account(
        &mut fixture.svm,
        wrong_quote,
        fixture.quote_mint,
        keys.lp.pubkey(),
        0,
    );
    let execute = ix(
        fixture.program_id,
        arbswap::instruction::ExecuteFeeClaim {},
        arbswap::accounts::ExecuteFeeClaim {
            admin: to_address(keys.admin.pubkey()),
            vault: fixture.vault,
            config: fixture.config,
            pending_claim: claim_pda,
            base_reserve: fixture.base_reserve,
            quote_reserve: fixture.quote_reserve,
            treasury_base: wrong_base,
            treasury_quote: wrong_quote,
            token_program: token_program_id(),
        },
    );
    assert_anchor_error(
        send(&mut fixture.svm, &[&keys.admin], execute),
        "ConstraintRaw",
    );
}

/// T2: a quote below the configured minimum (including zero) spread is rejected.
#[test]
fn a_zero_spread_quote_is_rejected() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);

    let mut zero = quote_update(SLOT);
    zero.half_spread_bps = 0;
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, honest, zero),
        "SpreadOutOfBounds",
    );

    // 1 bps is below the configured `min_spread_bps = 2`.
    let mut sub_minimum = quote_update(SLOT);
    sub_minimum.half_spread_bps = 1;
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, honest, sub_minimum),
        "SpreadOutOfBounds",
    );

    // A spread inside [min, max] still passes.
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("an in-bounds spread is accepted");
}

/// T2: the timelocked parameter path rejects `min_spread_bps > max_spread_bps`.
#[test]
fn apply_params_rejects_min_spread_above_max() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let bad = arbswap::ParamsUpdate {
        min_spread_bps: 60,
        max_spread_bps: 50,
        ..Default::default()
    };
    fixture
        .set_params(&keys.admin, bad)
        .expect("admin proposes");
    let pending = read_state::<arbswap::PendingConfig>(&fixture.svm, fixture.pending_config());
    fixture.warp_to_slot(pending.activate_slot);
    assert_anchor_error(fixture.apply_params(&keys.admin), "InvalidParams");
}

/// T3: an in-bounds utility ladder is accepted (the fixture default).
#[test]
fn an_honest_ladder_passes() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("honest ladder accepted");
}

/// T3: a ladder whose implied base or quote capacity exceeds
/// `u_max * available reserves` is rejected. The two sides are isolated by
/// making the other reserve large.
#[test]
fn a_ladder_deeper_than_the_reserves_is_rejected() {
    // --- base side: quote reserve is huge, so only the base cap can bind ---
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    set_token_account(
        &mut fixture.svm,
        fixture.lp_quote,
        fixture.quote_mint,
        keys.lp.pubkey(),
        1_000_000_000_000_000,
    );
    fixture
        .deposit(&keys.lp, 1_000_000_000, 1_000_000_000_000_000, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    let mut deep = quote_update(SLOT);
    // 2e9 base capacity > u_max (0.5) * 1e9 available base.
    deep.ask_levels = anchor_ladder(ANCHOR_SQRT, 5, OFFSETS, 2_000_000_000);
    deep.bid_levels = anchor_bid_ladder(ANCHOR_SQRT, 5, OFFSETS, 1_000);
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, honest, deep),
        "UtilizationExceeded",
    );

    // --- quote side: base reserve is huge, so only the quote cap can bind ---
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    set_token_account(
        &mut fixture.svm,
        fixture.lp_base,
        fixture.base_mint,
        keys.lp.pubkey(),
        1_000_000_000_000_000,
    );
    fixture
        .deposit(&keys.lp, 1_000_000_000_000_000, 1_000_000_000, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    let mut deep = quote_update(SLOT);
    // 1e9 quote capacity > 0.5 * 1e9 available quote, while the ask base
    // capacity stays well under the huge base reserve.
    deep.ask_levels = anchor_ladder(ANCHOR_SQRT, 5, OFFSETS, 1_000);
    deep.bid_levels = anchor_bid_ladder(ANCHOR_SQRT, 5, OFFSETS, 1_000_000_000);
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, honest, deep),
        "UtilizationExceeded",
    );
}

/// T3: the fee buckets are liabilities and are excluded from the available
/// reserves, so a ladder that fits the gross reserve is rejected once the
/// buckets grow.
#[test]
fn buckets_are_excluded_from_available_reserves() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    // Fits the gross reserve.
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("fits before buckets");

    // Book the whole quote reserve to the protocol bucket: available -> ~0.
    let mut vault: Vault = read_state(&fixture.svm, fixture.vault);
    vault.protocol_quote = token_amount(&fixture.svm, fixture.quote_reserve);
    fixture
        .svm
        .set_account(
            fixture.vault,
            solana_account::Account {
                lamports: 1_000_000_000,
                data: account_data(&vault),
                owner: fixture.program_id,
                ..solana_account::Account::default()
            },
        )
        .unwrap();
    fixture.warp_to_slot(SLOT + 1);
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, honest, quote_update(SLOT + 1)),
        "UtilizationExceeded",
    );
}

// ---------------------------------------------------------------------------
// T4: circuit breaker — state-only, permissionless, non-griefable.
// ---------------------------------------------------------------------------

/// An expired stored quote can be tripped by anyone.
#[test]
fn trip_breaker_on_expiry() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("quote");
    let expiry = fixture.quote_state_value().expiry_slot;
    fixture.warp_to_slot(expiry);
    fixture
        .trip_breaker(&keys.lp)
        .expect("an expired quote can be tripped by anyone");
    assert_eq!(fixture.vault_state().status, 1);
    // While paused, swaps are refused.
    assert_anchor_error(fixture.swap(&keys.trader, AMOUNT_IN, 0, 1), "Paused");
}

/// A stored oracle publish time far older than `max_staleness × 2` trips the
/// breaker — using only state the program itself stored.
#[test]
fn trip_breaker_on_stored_staleness() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("quote");
    // max_staleness_seconds = 30, so 61 s of stored staleness must trip.
    let mut clock = fixture.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = PUBLISH_TIME + 61;
    fixture.svm.set_sysvar(&clock);
    fixture
        .trip_breaker(&keys.lp)
        .expect("stored staleness must trip");
    assert_eq!(fixture.vault_state().status, 1);
}

/// T4 griefing defence: a caller-supplied stale oracle account cannot trip a
/// fresh quote. A naive breaker that read the caller's `PriceUpdateV2` would
/// pause here; the state-only design ignores it.
#[test]
fn no_trip_with_a_stale_foreign_account() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("a fresh quote");

    // An old-but-valid update account for the same feed, as an attacker would
    // supply to a naive breaker that trusts the caller's oracle.
    let stale = fixture.post_pyth(
        PYTH_PRICE,
        1,
        PUBLISH_TIME - 100_000,
        VerificationLevel::Full,
    );
    let mut trip = ix(
        fixture.program_id,
        arbswap::instruction::TripBreaker {},
        arbswap::accounts::TripBreaker {
            vault: fixture.vault,
            config: fixture.config,
            quote_state: fixture.quote_state,
        },
    );
    trip.accounts.push(AccountMeta::new_readonly(stale, false));
    assert_anchor_error(
        send(&mut fixture.svm, &[&keys.lp], trip),
        "BreakerConditionNotMet",
    );
    assert_eq!(
        fixture.vault_state().status,
        0,
        "a stale foreign account must not pause the vault"
    );
}

/// Only the admin can reset the breaker.
#[test]
fn reset_breaker_requires_the_admin() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("quote");
    let expiry = fixture.quote_state_value().expiry_slot;
    fixture.warp_to_slot(expiry);
    fixture.trip_breaker(&keys.lp).expect("trip");
    assert_anchor_error(fixture.reset_breaker(&keys.lp), "Unauthorized");
    fixture.reset_breaker(&keys.admin).expect("admin resets");
    assert_eq!(fixture.vault_state().status, 0);
}

/// A rejected wide-confidence update leaves the previous quote to expire (safe
/// failure), which then trips the breaker.
#[test]
fn rejected_wide_confidence_leaves_the_old_quote_to_expire() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("quote");
    assert_eq!(fixture.quote_state_value().version, 1);

    fixture.warp_to_slot(SLOT + 1);
    // conf = 1.5e8 -> ~100 bps, above max_conf_bps (10).
    let wide = fixture.post_pyth(
        PYTH_PRICE,
        150_000_000,
        PUBLISH_TIME,
        VerificationLevel::Full,
    );
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, wide, quote_update(SLOT + 1)),
        "WideConfidence",
    );
    assert_eq!(
        fixture.quote_state_value().version,
        1,
        "a rejected update must not commit"
    );

    let expiry = fixture.quote_state_value().expiry_slot;
    fixture.warp_to_slot(expiry);
    assert_anchor_error(fixture.swap(&keys.trader, AMOUNT_IN, 0, 1), "QuoteExpired");
    fixture
        .trip_breaker(&keys.lp)
        .expect("the expired old quote trips");
}

// ---------------------------------------------------------------------------
// T5: keeper unbond with a cooldown.
// ---------------------------------------------------------------------------

/// Starting an unbond too early fails; after the cooldown the queued stake is
/// released and the bond shrinks.
#[test]
fn unbond_keeper_cooldown_and_release() {
    let keys = Keys::new();
    let mut fixture = Fixture::with_min_bond(&keys, 1_000);
    fixture.bond_keeper(&keys.keeper, 1_000).expect("bond");
    let before = token_amount(&fixture.svm, fixture.keeper_quote);

    let m = fixture
        .unbond_keeper(&keys.keeper, 400)
        .expect("start unbond");
    println!("cu_unbond_keeper_start={}", m.compute_units_consumed);
    let bond = read_state::<KeeperBond>(&fixture.svm, fixture.keeper_bond(&keys.keeper));
    assert_eq!(bond.unbond_amount, 400);
    assert!(bond.unbond_ready_slot > SLOT);

    // Releasing before the cooldown elapses fails.
    assert_anchor_error(fixture.unbond_keeper(&keys.keeper, 0), "TimelockNotElapsed");

    fixture.warp_to_slot(bond.unbond_ready_slot);
    let m = fixture
        .unbond_keeper(&keys.keeper, 0)
        .expect("release after cooldown");
    println!("cu_unbond_keeper_release={}", m.compute_units_consumed);
    let after = read_state::<KeeperBond>(&fixture.svm, fixture.keeper_bond(&keys.keeper));
    assert_eq!(after.bond, 600);
    assert_eq!(after.unbond_amount, 0);
    assert_eq!(after.unbond_ready_slot, 0);
    assert_eq!(
        token_amount(&fixture.svm, fixture.keeper_quote),
        before + 400
    );
}

/// A keeper whose pending unbond drops the effective bond below `min_bond`
/// can no longer quote (quoting deactivates).
#[test]
fn unbond_below_min_bond_deactivates_quoting() {
    let keys = Keys::new();
    let mut fixture = Fixture::with_min_bond(&keys, 1_000);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    fixture.bond_keeper(&keys.keeper, 1_000).expect("bond");
    fixture
        .unbond_keeper(&keys.keeper, 600)
        .expect("start unbond");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, honest, quote_update(SLOT)),
        "NotBonded",
    );
}

/// The admin can slash during the cooldown; the release is capped at the
/// remaining bond.
#[test]
fn slash_during_unbond_reduces_the_release() {
    let keys = Keys::new();
    let mut fixture = Fixture::with_min_bond(&keys, 1_000);
    fixture.bond_keeper(&keys.keeper, 1_000).expect("bond");
    let before = token_amount(&fixture.svm, fixture.keeper_quote);
    fixture
        .unbond_keeper(&keys.keeper, 1_000)
        .expect("start unbond");

    fixture
        .slash_keeper(&keys.admin, &keys.keeper, 300)
        .expect("slash during the cooldown");
    let bond = read_state::<KeeperBond>(&fixture.svm, fixture.keeper_bond(&keys.keeper));
    assert_eq!(bond.bond, 700);

    fixture.warp_to_slot(bond.unbond_ready_slot);
    fixture
        .unbond_keeper(&keys.keeper, 0)
        .expect("release the capped amount");
    let after = read_state::<KeeperBond>(&fixture.svm, fixture.keeper_bond(&keys.keeper));
    assert_eq!(after.bond, 0);
    assert_eq!(
        token_amount(&fixture.svm, fixture.keeper_quote),
        before + 700
    );
}

/// A keeper bond from another vault cannot be used here.
#[test]
fn unbond_keeper_rejects_a_bond_from_another_vault() {
    let keys = Keys::new();
    let mut fixture = Fixture::with_min_bond(&keys, 1_000);
    fixture.bond_keeper(&keys.keeper, 1_000).expect("bond");
    let foreign_vault = foreign_vault_address(&fixture.program_id);
    let (foreign_bond, bump) = pda(
        &[
            b"keeper",
            foreign_vault.as_ref(),
            keys.keeper.pubkey().as_ref(),
        ],
        &fixture.program_id,
    );
    let bond = KeeperBond {
        keeper: keys.keeper.pubkey(),
        bond: 1_000,
        slashed: 0,
        unbond_amount: 0,
        unbond_ready_slot: 0,
        bump,
    };
    fixture
        .svm
        .set_account(
            foreign_bond,
            solana_account::Account {
                lamports: 1_000_000_000,
                data: account_data(&bond),
                owner: fixture.program_id,
                ..solana_account::Account::default()
            },
        )
        .unwrap();
    let unbond = ix(
        fixture.program_id,
        arbswap::instruction::UnbondKeeper { amount: 1 },
        arbswap::accounts::UnbondKeeper {
            keeper: to_address(keys.keeper.pubkey()),
            vault: fixture.vault,
            config: fixture.config,
            quote_mint: fixture.quote_mint,
            keeper_quote: fixture.keeper_quote,
            bond_vault: fixture.bond_vault(),
            keeper_bond: foreign_bond,
            token_program: token_program_id(),
        },
    );
    assert_account_rejected(
        send(&mut fixture.svm, &[&keys.keeper], unbond),
        "keeper_bond",
    );
}

// ---------------------------------------------------------------------------
// T6: compromised-keeper worst-case loss bound.
// ---------------------------------------------------------------------------

/// A malicious keeper posts the anchor at the maximum allowed deviation from the
/// oracle every slot; an arbitrageur takes the full quoted ladder each time.
/// The realized vault loss must stay within
/// `u * d * available_value` per update and `d * w * base * price` per window.
#[test]
fn malicious_keeper_at_max_deviation_every_slot() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);

    // Tighten the loss knobs: 1% anchor deviation, 10% per-window one-sided
    // flow cap, 50% utilization, a large per-swap cap.
    let mut config: Config = read_state(&fixture.svm, fixture.config);
    // A near-zero vault fee so the 1% mispricing is not hidden by the swap fee.
    config.fee_bps = 1;
    config.max_anchor_dev_bps = 100;
    config.utilization_max_bps = 5_000;
    config.max_window_flow_bps = 1_000;
    config.max_quote_size = 100_000_000;
    fixture
        .svm
        .set_account(
            fixture.config,
            solana_account::Account {
                lamports: 1_000_000_000,
                data: account_data(&config),
                owner: fixture.program_id,
                ..solana_account::Account::default()
            },
        )
        .unwrap();

    // Value-balanced-ish vault: 1e6 base (~1.5e8 quote) and 1.5e8 quote.
    let base_deposit: u64 = 1_000_000;
    let quote_deposit: u64 = 150_000_000;
    fixture
        .deposit(&keys.lp, base_deposit, quote_deposit, 1)
        .expect("deposit");

    // Ladder depth = 5% of base reserve, half the 10% per-window flow cap, so
    // at least one slot's attack lands before the cap stops it.
    let ladder_base_capacity: u128 = 50_000;
    // Anchor just under 1% BELOW the oracle (99 bps realized after the
    // floor-rounding of sqrt/sqrt-inverse), so asks are cheap: the vault loses.
    // The loss bound uses the configured 100 bps cap, which is conservative.
    let anchor_price_q64 = PRICE_Q64 * 9_901 / 10_000;
    let anchor_sqrt = arb_math::sqrt_q64(anchor_price_q64).expect("anchor sqrt");
    let ask_levels = anchor_ladder(anchor_sqrt, 2, OFFSETS, ladder_base_capacity);
    let bid_levels = anchor_bid_ladder(anchor_sqrt, 2, OFFSETS, 1_000);
    let ladder_quote_capacity: u128 = ask_levels
        .iter()
        .map(|l| {
            arb_math::Level {
                sqrt_lo: l.sqrt_lo,
                sqrt_hi: l.sqrt_hi,
                liquidity: l.liquidity,
            }
            .quote_capacity()
            .expect("quote capacity")
        })
        .sum();

    let base_start = token_amount(&fixture.svm, fixture.base_reserve);
    let quote_start = token_amount(&fixture.svm, fixture.quote_reserve);
    let oracle_price: u128 = PRICE_Q64 >> 64; // 150
    let available_value = (base_start as u128) * oracle_price + quote_start as u128;
    let per_update_bound = 5_000u128 * 100u128 * available_value / 100_000_000;
    let per_window_bound = 100u128 * 1_000u128 * (base_start as u128) * oracle_price / 100_000_000;

    let mut lost: u128 = 0;
    let mut landed: u32 = 0;
    for i in 0..4u64 {
        fixture.warp_to_slot(SLOT + i);
        let oracle = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
        let update = QuoteUpdate {
            update_slot: SLOT + i,
            oracle_publish_time: PUBLISH_TIME,
            oracle_price: PRICE_Q64,
            oracle_conf_bps: CONF_BPS,
            anchor_sqrt_price: anchor_sqrt,
            p_res_sqrt: anchor_sqrt,
            half_spread_bps: 2,
            ask_extra_bps: 0,
            bid_extra_bps: 0,
            depth_mult_bps: 10_000,
            offsets_bps: OFFSETS,
            weights_bps: WEIGHTS,
            ask_levels,
            bid_levels,
        };
        fixture
            .update_quote(&keys.keeper, oracle, update)
            .expect("malicious quote at max deviation");

        let base_before = token_amount(&fixture.svm, fixture.base_reserve);
        let quote_before = token_amount(&fixture.svm, fixture.quote_reserve);
        // The trader supplies exactly the ladder's quote capacity.
        let input = ladder_quote_capacity.min(config.max_quote_size as u128) as u64;
        match fixture.swap(&keys.trader, input, 0, 1) {
            Ok(_) => {
                let base_sold = base_before - token_amount(&fixture.svm, fixture.base_reserve);
                let quote_gained = token_amount(&fixture.svm, fixture.quote_reserve) - quote_before;
                let this_loss = (base_sold as u128) * oracle_price
                    - (quote_gained as u128).min((base_sold as u128) * oracle_price);
                assert!(
                    this_loss <= per_update_bound,
                    "per-update loss {this_loss} exceeds bound {per_update_bound}"
                );
                lost += this_loss;
                landed += 1;
            }
            Err(fail) => {
                // Only the per-window flow cap may stop a later slot.
                assert!(
                    fail.meta
                        .logs
                        .iter()
                        .any(|line| line.contains("FlowCapExceeded")),
                    "unexpected swap failure: {:?}",
                    fail.meta.logs
                );
            }
        }
    }

    assert!(landed >= 1, "no attack landed; the test would be vacuous");
    assert!(
        lost <= per_window_bound,
        "total loss {lost} exceeds the per-window bound {per_window_bound}"
    );
    println!(
        "t6_landed={landed} t6_loss={lost} per_update_bound={per_update_bound} per_window_bound={per_window_bound}"
    );
}

// ---------------------------------------------------------------------------
// T7: share accounting, round-trip, expiry, and account-space invariants.
// ---------------------------------------------------------------------------

/// A first depositor cannot steal from a later depositor by donating reserves:
/// the victim's pro-rata claim is fair to within rounding.
#[test]
fn first_depositor_inflation_loses_at_most_rounding() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);

    // Attacker makes the minimum first deposit.
    fixture
        .deposit(&keys.lp, 1_000_000, 1_000_000, 1)
        .expect("attacker deposit");
    let attacker_shares = token_amount(&fixture.svm, fixture.lp_shares);
    assert_eq!(attacker_shares, 999_999, "MIN_LIQUIDITY is burned");

    // Attacker donates 1e6 of each token directly into the reserves (no shares).
    let vault_authority = pubkey(fixture.vault);
    let base_new = token_amount(&fixture.svm, fixture.base_reserve) + 1_000_000;
    let quote_new = token_amount(&fixture.svm, fixture.quote_reserve) + 1_000_000;
    set_token_account(
        &mut fixture.svm,
        fixture.base_reserve,
        fixture.base_mint,
        vault_authority,
        base_new,
    );
    set_token_account(
        &mut fixture.svm,
        fixture.quote_reserve,
        fixture.quote_mint,
        vault_authority,
        quote_new,
    );

    // Victim deposits the same size; shares are priced on the inflated reserves.
    fixture
        .deposit_as(
            &keys.trader,
            fixture.trader_base,
            fixture.trader_quote,
            fixture.trader_shares,
            1_000_000,
            1_000_000,
            0,
        )
        .expect("victim deposit");
    let victim_shares = token_amount(&fixture.svm, fixture.trader_shares);
    let total = fixture.vault_state().total_shares;
    assert_eq!(victim_shares, 500_000);
    assert_eq!(total, 1_500_000);

    // Victim's pro-rata claim is at least the deposit minus one atom of rounding.
    let base_avail = token_amount(&fixture.svm, fixture.base_reserve);
    let quote_avail = token_amount(&fixture.svm, fixture.quote_reserve);
    let claim_base = (victim_shares as u128) * (base_avail as u128) / (total as u128);
    let claim_quote = (victim_shares as u128) * (quote_avail as u128) / (total as u128);
    assert!(claim_base + 1 >= 1_000_000, "victim lost base value");
    assert!(claim_quote + 1 >= 1_000_000, "victim lost quote value");
}

/// Invariant 2 (Build Plan §10): selling then buying the same size can never
/// leave the trader with more base than they started with.
#[test]
fn sell_then_buy_same_size_never_creates_value() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("quote");

    let base_before = token_amount(&fixture.svm, fixture.trader_base);
    let quote_before = token_amount(&fixture.svm, fixture.trader_quote);
    fixture
        .swap_side(&keys.trader, arbswap::SwapSide::SellBase, 100, 0, 1)
        .expect("sell base");
    let proceeds = token_amount(&fixture.svm, fixture.trader_quote) - quote_before;
    assert!(proceeds > 0);
    fixture
        .swap_side(&keys.trader, arbswap::SwapSide::BuyBase, proceeds, 0, 1)
        .expect("buy base back");
    let base_after = token_amount(&fixture.svm, fixture.trader_base);
    assert!(
        base_after <= base_before,
        "round trip created base: {base_after} > {base_before}"
    );
}

/// Invariant 4 (Build Plan §10): a quote at or past its expiry always rejects.
#[test]
fn expired_quote_always_rejects_swap() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, quote_update(SLOT))
        .expect("quote");
    let expiry = fixture.quote_state_value().expiry_slot;
    fixture.warp_to_slot(expiry);
    assert_anchor_error(fixture.swap(&keys.trader, AMOUNT_IN, 0, 1), "QuoteExpired");
}

/// P2-F11: every account's allocated `space` covers its serialized size.
#[test]
fn account_spaces_match_serialized_sizes() {
    let keys = Keys::new();
    let mut fixture = Fixture::with_min_bond(&keys, 1_000);

    // Create every account type.
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    fixture.bond_keeper(&keys.keeper, 1_000).expect("bond");
    fixture.warp_to_slot(SLOT + 2);
    let shares = token_amount(&fixture.svm, fixture.lp_shares);
    let request = ix(
        fixture.program_id,
        arbswap::instruction::RequestWithdraw { shares },
        arbswap::accounts::RequestWithdraw {
            user: to_address(keys.lp.pubkey()),
            vault: fixture.vault,
            share_lock: fixture.share_lock,
            deposit_ticket: fixture.deposit_ticket,
            user_shares: fixture.lp_shares,
            withdraw_ticket: fixture.withdraw_ticket,
            token_program: token_program_id(),
            system_program: anchor_lang::system_program::ID,
        },
    );
    send(&mut fixture.svm, &[&keys.lp], request).expect("request");
    fixture
        .set_params(
            &keys.admin,
            arbswap::ParamsUpdate {
                fee_bps: 5,
                ..Default::default()
            },
        )
        .expect("set_params");
    let claim_pda = pda(&[b"claim", fixture.vault.as_ref()], &fixture.program_id).0;
    let propose = ix(
        fixture.program_id,
        arbswap::instruction::ProposeFeeClaim {
            kind: arbswap::FeeKind::Protocol,
        },
        arbswap::accounts::ProposeFeeClaim {
            admin: to_address(keys.admin.pubkey()),
            vault: fixture.vault,
            pending_claim: claim_pda,
            system_program: anchor_lang::system_program::ID,
        },
    );
    send(&mut fixture.svm, &[&keys.admin], propose).expect("propose");

    fn check<T: anchor_lang::AccountSerialize + anchor_lang::AccountDeserialize>(
        svm: &litesvm::LiteSVM,
        key: Address,
    ) {
        let needed = account_data(&read_state::<T>(svm, key)).len();
        let allocated = svm.get_account(&key).expect("account missing").data.len();
        assert!(
            allocated >= needed,
            "account {key:?}: allocated {allocated} < serialized {needed}"
        );
    }

    let program_config = pda(&[b"program"], &fixture.program_id).0;
    check::<arbswap::ProgramConfig>(&fixture.svm, program_config);
    check::<Vault>(&fixture.svm, fixture.vault);
    check::<Config>(&fixture.svm, fixture.config);
    check::<QuoteState>(&fixture.svm, fixture.quote_state);
    check::<DepositTicket>(&fixture.svm, fixture.deposit_ticket);
    check::<arbswap::WithdrawTicket>(&fixture.svm, fixture.withdraw_ticket);
    check::<KeeperBond>(&fixture.svm, fixture.keeper_bond(&keys.keeper));
    check::<arbswap::PendingConfig>(&fixture.svm, fixture.pending_config());
    check::<arbswap::PendingClaim>(&fixture.svm, claim_pda);
}

/// T8: an update observed too many slots before it lands is rejected.
#[test]
fn an_old_update_slot_is_rejected() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");
    // max_update_slot_age = 25; the keeper observed SLOT but lands 100 slots later.
    fixture.warp_to_slot(SLOT + 100);
    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    assert_anchor_error(
        fixture.update_quote(&keys.keeper, honest, quote_update(SLOT)),
        "UpdateSlotTooOld",
    );
}

// ---------------------------------------------------------------------------
// H1: two-sided keeper ladder.
// ---------------------------------------------------------------------------

/// Build an on-chain `QuoteUpdate` from a keeper-produced two-sided quote.
fn keeper_two_sided_update(base: u128, quote: u128) -> QuoteUpdate {
    let tick = arbswap_keeper::OracleTick {
        slot: SLOT,
        publish_time: PUBLISH_TIME,
        price_q64: PRICE_Q64,
        confidence_bps: CONF_BPS,
    };
    let q = arbswap_keeper::compute_quote(
        tick,
        arbswap_keeper::VolatilityState::default(),
        base,
        quote,
        0,
        0,
        arbswap_keeper::KeeperParams::default(),
    )
    .expect("keeper quote");
    let to_update = |l: &arb_math::Level| LevelUpdate {
        sqrt_lo: l.sqrt_lo,
        sqrt_hi: l.sqrt_hi,
        liquidity: l.liquidity,
    };
    let mut ask_levels = [LevelUpdate::default(); 6];
    let mut bid_levels = [LevelUpdate::default(); 6];
    for i in 0..6 {
        ask_levels[i] = to_update(&q.ask_levels[i]);
        bid_levels[i] = to_update(&q.bid_levels[i]);
    }
    QuoteUpdate {
        update_slot: SLOT,
        oracle_publish_time: PUBLISH_TIME,
        oracle_price: q.oracle_price_q64,
        oracle_conf_bps: q.confidence_bps,
        anchor_sqrt_price: q.anchor_sqrt_price,
        p_res_sqrt: q.reservation_sqrt_price,
        half_spread_bps: q.half_spread_bps,
        ask_extra_bps: q.ask_extra_bps,
        bid_extra_bps: q.bid_extra_bps,
        depth_mult_bps: q.depth_mult_bps,
        offsets_bps: q.offsets_bps,
        weights_bps: q.weights_bps,
        ask_levels,
        bid_levels,
    }
}

/// A keeper-produced two-sided quote is accepted, then both swap directions
/// execute at the quoted-or-better output with value conservation.
#[test]
fn keeper_two_sided_quote_executes_both_directions() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
        .expect("deposit");

    let update = keeper_two_sided_update(LP_BASE_DEPOSIT as u128, LP_QUOTE_DEPOSIT as u128);
    let ask_levels: Vec<arb_math::Level> = update
        .ask_levels
        .iter()
        .map(|l| arb_math::Level {
            sqrt_lo: l.sqrt_lo,
            sqrt_hi: l.sqrt_hi,
            liquidity: l.liquidity,
        })
        .collect();
    let bid_levels: Vec<arb_math::Level> = update
        .bid_levels
        .iter()
        .map(|l| arb_math::Level {
            sqrt_lo: l.sqrt_lo,
            sqrt_hi: l.sqrt_hi,
            liquidity: l.liquidity,
        })
        .collect();

    let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, honest, update)
        .expect("keeper two-sided quote accepted");
    assert_eq!(fixture.quote_state_value().version, 1);

    // --- BuyBase against the ask ladder ---
    let buy_in: u64 = 100_000;
    let buy_fee = arb_math::fee_amount(buy_in as u128, FEE_BPS as u128).unwrap();
    let expected_buy =
        arb_math::walk_ladder(&ask_levels, arb_math::Side::Ask, buy_in as u128 - buy_fee).unwrap();
    assert_eq!(expected_buy.remaining, 0, "ask ladder must absorb the buy");
    let trader_base_before = token_amount(&fixture.svm, fixture.trader_base);
    fixture
        .swap(&keys.trader, buy_in, expected_buy.out as u64, 1)
        .expect("buy swap executes");
    assert_eq!(
        token_amount(&fixture.svm, fixture.trader_base) - trader_base_before,
        expected_buy.out as u64,
        "buy output matches the quoted ladder"
    );
    assert_anchor_error(
        fixture.swap(&keys.trader, buy_in, expected_buy.out as u64, 2),
        "VersionTooOld",
    );

    // --- SellBase against the bid ladder ---
    let sell_in: u64 = 100;
    let sell_fee = arb_math::fee_amount(sell_in as u128, FEE_BPS as u128).unwrap();
    let expected_sell =
        arb_math::walk_ladder(&bid_levels, arb_math::Side::Bid, sell_in as u128 - sell_fee)
            .unwrap();
    assert_eq!(
        expected_sell.remaining, 0,
        "bid ladder must absorb the sell"
    );
    let trader_quote_before = token_amount(&fixture.svm, fixture.trader_quote);
    fixture
        .swap_side(
            &keys.trader,
            arbswap::SwapSide::SellBase,
            sell_in,
            expected_sell.out as u64,
            1,
        )
        .expect("sell swap executes");
    assert_eq!(
        token_amount(&fixture.svm, fixture.trader_quote) - trader_quote_before,
        expected_sell.out as u64,
        "sell output matches the quoted ladder"
    );

    // --- value conservation across all holders ---
    assert_eq!(
        token_amount(&fixture.svm, fixture.lp_base)
            + token_amount(&fixture.svm, fixture.trader_base)
            + token_amount(&fixture.svm, fixture.base_reserve),
        2 * 10_000_000_000
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.lp_quote)
            + token_amount(&fixture.svm, fixture.trader_quote)
            + token_amount(&fixture.svm, fixture.quote_reserve),
        2 * 10_000_000_000
    );
}

/// At zero inventory skew the bid ladder mirrors the ask ladder around the
/// reservation price: `ask_lo[k] + bid_hi[k] == ask_hi[k] + bid_lo[k] == 2·p_res`.
#[test]
fn two_sided_ladder_is_mirrored_at_zero_skew() {
    let base: u128 = 1_000_000_000;
    let quote: u128 = base * 150; // zero skew: base*P == quote
    let q = arbswap_keeper::compute_quote(
        arbswap_keeper::OracleTick {
            slot: SLOT,
            publish_time: PUBLISH_TIME,
            price_q64: PRICE_Q64,
            confidence_bps: CONF_BPS,
        },
        arbswap_keeper::VolatilityState::default(),
        base,
        quote,
        0,
        0,
        arbswap_keeper::KeeperParams::default(),
    )
    .expect("keeper quote");
    assert_eq!(
        q.reservation_sqrt_price, q.anchor_sqrt_price,
        "zero skew must quote at the anchor"
    );
    let reservation = arb_math::price_from_sqrt(q.reservation_sqrt_price).unwrap();
    let tolerance = reservation / 1_000_000; // a few-ulp round-trip slack
    for k in 0..6 {
        let ask_lo = arb_math::price_from_sqrt(q.ask_levels[k].sqrt_lo).unwrap();
        let ask_hi = arb_math::price_from_sqrt(q.ask_levels[k].sqrt_hi).unwrap();
        let bid_lo = arb_math::price_from_sqrt(q.bid_levels[k].sqrt_lo).unwrap();
        let bid_hi = arb_math::price_from_sqrt(q.bid_levels[k].sqrt_hi).unwrap();
        let two_res = 2 * reservation;
        assert!(
            (ask_lo + bid_hi).abs_diff(two_res) <= tolerance,
            "ask_lo + bid_hi not mirrored at level {k}"
        );
        assert!(
            (ask_hi + bid_lo).abs_diff(two_res) <= tolerance,
            "ask_hi + bid_lo not mirrored at level {k}"
        );
    }
}
