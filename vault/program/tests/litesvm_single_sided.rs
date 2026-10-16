//! LiteSVM coverage for the single-token `deposit_single` /
//! `claim_withdraw_single` instructions (see `docs/SINGLE_SIDED_DESIGN.md`).
//!
//! The internal conversion trades against the vault's own committed ladder, so
//! every test first commits a real quote and seeds a two-sided LP position.

mod common;

use arbswap::{DepositTicket, InitParams, LevelUpdate, QuoteState, Vault, WithdrawTicket};
use common::*;
use litesvm::LiteSVM;
use pyth_solana_receiver_sdk::price_update::VerificationLevel;
use solana_address::Address;
use solana_clock::Clock;
use solana_compute_budget::compute_budget::ComputeBudget;
use solana_keypair::Keypair;
use solana_signer::Signer;

const SLOT: u64 = 5;
const EXPIRY_SLOTS: u64 = 50;
const FEE_BPS: u16 = 100;
const INSURANCE_BPS: u16 = 3_333;
const KEEPER_BPS: u16 = 3_333;
const PROTOCOL_BPS: u16 = 3_334;
const MAX_QUOTE_SIZE: u64 = 1_000_000;
const LP_BASE_DEPOSIT: u64 = 100_000_000;
const LP_QUOTE_DEPOSIT: u64 = 100_000_000;
/// Small enough that the whole notional fits the test ladder.
const SINGLE_AMOUNT: u64 = 5_000;
const TEST_LADDER_BASE_CAPACITY: u128 = 10_000;
const TEST_LADDER_QUOTE_CAPACITY: u128 = 20_000_000;

fn ask_ladder() -> [LevelUpdate; 6] {
    anchor_ladder(ANCHOR_SQRT, 5, OFFSETS, TEST_LADDER_BASE_CAPACITY)
}

fn bid_ladder() -> [LevelUpdate; 6] {
    anchor_bid_ladder(ANCHOR_SQRT, 5, OFFSETS, TEST_LADDER_QUOTE_CAPACITY)
}

fn quote_update(update_slot: u64) -> arbswap::QuoteUpdate {
    arbswap::QuoteUpdate {
        update_slot,
        oracle_publish_time: PUBLISH_TIME,
        oracle_conf_bps: CONF_BPS,
        anchor_sqrt_price: ANCHOR_SQRT,
        p_res_sqrt: ANCHOR_SQRT,
        half_spread_bps: 5,
        ask_extra_bps: 0,
        bid_extra_bps: 0,
        depth_mult_bps: 10_000,
        offsets_bps: OFFSETS,
        weights_bps: WEIGHTS,
        ask_levels: ask_ladder(),
        bid_levels: bid_ladder(),
    }
}

struct Keys {
    admin: Keypair,
    keeper: Keypair,
    lp: Keypair,
    user: Keypair,
}

impl Keys {
    fn new() -> Self {
        Self {
            admin: Keypair::new(),
            keeper: Keypair::new(),
            lp: Keypair::new(),
            user: Keypair::new(),
        }
    }
}

struct Fixture {
    svm: LiteSVM,
    program_id: Address,
    base_mint: Address,
    quote_mint: Address,
    vault: Address,
    config: Address,
    quote_state: Address,
    volatility_state: Address,
    base_reserve: Address,
    quote_reserve: Address,
    share_mint: Address,
    share_lock: Address,
    lp_base: Address,
    lp_quote: Address,
    lp_shares: Address,
    user_base: Address,
    user_quote: Address,
    user_shares: Address,
    base_reserve_kp: Keypair,
    quote_reserve_kp: Keypair,
    share_mint_kp: Keypair,
    share_lock_kp: Keypair,
    params: InitParams,
}

impl Fixture {
    fn new(keys: &Keys) -> Self {
        Self::with_config(keys, 100, 10_000)
    }

    fn with_config(keys: &Keys, flow_window_slots: u64, max_window_flow_bps: u32) -> Self {
        let budget = ComputeBudget {
            compute_unit_limit: 1_400_000,
            ..ComputeBudget::new_with_defaults(false)
        };
        let mut svm = LiteSVM::new().with_compute_budget(budget);
        let program_id = load_arbswap(&mut svm);
        for key in [&keys.admin, &keys.keeper, &keys.lp, &keys.user] {
            airdrop(&mut svm, key, 10_000_000_000);
        }

        let mut clock = svm.get_sysvar::<Clock>();
        clock.slot = SLOT;
        clock.unix_timestamp = PUBLISH_TIME;
        svm.set_sysvar(&clock);

        let base_mint = Address::new_unique();
        let quote_mint = Address::new_unique();
        set_token_mint(&mut svm, base_mint, 9, keys.admin.pubkey());
        set_token_mint(&mut svm, quote_mint, 9, keys.admin.pubkey());

        let lp_base = Address::new_unique();
        let lp_quote = Address::new_unique();
        let user_base = Address::new_unique();
        let user_quote = Address::new_unique();
        for (account, mint, owner) in [
            (lp_base, base_mint, keys.lp.pubkey()),
            (lp_quote, quote_mint, keys.lp.pubkey()),
            (user_base, base_mint, keys.user.pubkey()),
            (user_quote, quote_mint, keys.user.pubkey()),
        ] {
            set_token_account(&mut svm, account, mint, owner, 10_000_000_000);
        }
        let (vault, _) = pda(
            &[b"vault", base_mint.as_ref(), quote_mint.as_ref()],
            &program_id,
        );
        let (config, _) = pda(&[b"config", vault.as_ref()], &program_id);
        let (quote_state, _) = pda(&[b"quote", vault.as_ref()], &program_id);
        let (volatility_state, _) = pda(&[b"vol", vault.as_ref()], &program_id);

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
            warmup_slots: 0,
            epoch_slots: 10,
            grace_slots: 1,
            expiry_slots: EXPIRY_SLOTS,
            max_staleness_seconds: 30,
            max_conf_bps: 10,
            max_anchor_step_bps: 100,
            max_spread_step_bps: 10,
            min_spread_bps: 2,
            max_spread_bps: 50,
            max_quote_size: MAX_QUOTE_SIZE,
            max_inventory_bps: 2_000,
            utilization_max_bps: 5_000,
            min_bond: 0,
            unbond_cooldown_slots: 100,
            max_update_slot_age: 25,
            edge_window_slots: 100,
            max_edge_loss_bps: 5_000,
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
            volatility_state,
            base_reserve: to_address(base_reserve_kp.pubkey()),
            quote_reserve: to_address(quote_reserve_kp.pubkey()),
            share_mint: to_address(share_mint_kp.pubkey()),
            share_lock: to_address(share_lock_kp.pubkey()),
            lp_base,
            lp_quote,
            lp_shares: Address::new_unique(),
            user_base,
            user_quote,
            user_shares: Address::new_unique(),
            base_reserve_kp,
            quote_reserve_kp,
            share_mint_kp,
            share_lock_kp,
            params,
        };
        fixture.initialize_program(&keys.admin);
        fixture.initialize_vault(&keys.admin);
        fixture.initialize_volatility(&keys.admin);
        set_token_account(
            &mut fixture.svm,
            fixture.lp_shares,
            fixture.share_mint,
            keys.lp.pubkey(),
            0,
        );
        set_token_account(
            &mut fixture.svm,
            fixture.user_shares,
            fixture.share_mint,
            keys.user.pubkey(),
            0,
        );
        fixture.init_attribution(&keys.keeper);
        // Seed a two-sided LP position and a live quote so the internal ladder
        // has capacity and an attributed author.
        fixture
            .deposit(&keys.lp, LP_BASE_DEPOSIT, LP_QUOTE_DEPOSIT, 1)
            .expect("seed deposit");
        let honest = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
        fixture
            .update_quote(&keys.keeper, honest, quote_update(SLOT))
            .expect("seed quote");
        fixture
    }

    fn program_config(&self) -> Address {
        pda(&[b"program"], &self.program_id).0
    }

    fn keeper_reward(&self) -> Address {
        let keeper = read_state::<QuoteState>(&self.svm, self.quote_state).keeper;
        pda(
            &[b"reward", self.vault.as_ref(), keeper.as_ref()],
            &self.program_id,
        )
        .0
    }

    fn init_attribution(&mut self, keeper: &Keypair) {
        let (kr, kr_bump) = pda(
            &[b"reward", self.vault.as_ref(), keeper.pubkey().as_ref()],
            &self.program_id,
        );
        let value = arbswap::KeeperReward {
            keeper: keeper.pubkey(),
            base: 0,
            quote: 0,
            bump: kr_bump,
        };
        self.svm
            .set_account(
                kr,
                solana_account::Account {
                    lamports: 10_000_000,
                    data: account_data(&value),
                    owner: self.program_id,
                    ..solana_account::Account::default()
                },
            )
            .unwrap();
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
        send(&mut self.svm, &[admin], instruction).expect("initialize_program");
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
        send(
            &mut self.svm,
            &[
                admin,
                &self.base_reserve_kp,
                &self.quote_reserve_kp,
                &self.share_mint_kp,
                &self.share_lock_kp,
            ],
            instruction,
        )
        .expect("initialize_vault");
    }

    fn initialize_volatility(&mut self, admin: &Keypair) {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::InitializeVolatility {
                params: arbswap::VolatilityParams::default(),
            },
            arbswap::accounts::InitializeVolatility {
                admin: to_address(admin.pubkey()),
                vault: self.vault,
                volatility_state: self.volatility_state,
                system_program: anchor_lang::system_program::ID,
            },
        );
        send(&mut self.svm, &[admin], instruction).expect("initialize_volatility");
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

    fn update_quote(
        &mut self,
        keeper: &Keypair,
        price_update: Address,
        update: arbswap::QuoteUpdate,
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
                keeper_bond: pda(
                    &[b"keeper", self.vault.as_ref(), keeper.pubkey().as_ref()],
                    &self.program_id,
                )
                .0,
                base_reserve: self.base_reserve,
                quote_reserve: self.quote_reserve,
                base_mint: self.base_mint,
                quote_mint: self.quote_mint,
                volatility_state: self.volatility_state,
            },
        );
        send(&mut self.svm, &[keeper], instruction)
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
                deposit_ticket: pda(
                    &[b"dep", self.vault.as_ref(), user.pubkey().as_ref()],
                    &self.program_id,
                )
                .0,
                token_program: token_program_id(),
                system_program: anchor_lang::system_program::ID,
            },
        );
        send(&mut self.svm, &[user], instruction)
    }

    fn deposit_single(
        &mut self,
        user: &Keypair,
        side: arbswap::SwapSide,
        amount_in: u64,
        min_shares: u64,
        min_swap_out: u64,
    ) -> litesvm::types::TransactionResult {
        let user_address = to_address(user.pubkey());
        let (deposit_ticket, _) = pda(
            &[b"dep", self.vault.as_ref(), user_address.as_ref()],
            &self.program_id,
        );
        let instruction = ix(
            self.program_id,
            arbswap::instruction::DepositSingle {
                side,
                amount_in,
                min_shares,
                min_swap_out,
            },
            arbswap::accounts::DepositSingle {
                user: user_address,
                vault: self.vault,
                config: self.config,
                quote_state: self.quote_state,
                base_reserve: self.base_reserve,
                quote_reserve: self.quote_reserve,
                share_mint: self.share_mint,
                share_lock: self.share_lock,
                user_base: self.user_base,
                user_quote: self.user_quote,
                user_shares: self.user_shares,
                deposit_ticket,
                keeper_reward: self.keeper_reward(),
                token_program: token_program_id(),
                system_program: anchor_lang::system_program::ID,
            },
        );
        send(&mut self.svm, &[user], instruction)
    }

    fn request_withdraw(
        &mut self,
        user: &Keypair,
        shares: u64,
    ) -> litesvm::types::TransactionResult {
        let address = to_address(user.pubkey());
        let instruction = ix(
            self.program_id,
            arbswap::instruction::RequestWithdraw { shares },
            arbswap::accounts::RequestWithdraw {
                user: address,
                vault: self.vault,
                share_lock: self.share_lock,
                deposit_ticket: pda(
                    &[b"dep", self.vault.as_ref(), address.as_ref()],
                    &self.program_id,
                )
                .0,
                user_shares: self.lp_shares,
                withdraw_ticket: pda(
                    &[b"wd", self.vault.as_ref(), address.as_ref()],
                    &self.program_id,
                )
                .0,
                token_program: token_program_id(),
                system_program: anchor_lang::system_program::ID,
            },
        );
        send(&mut self.svm, &[user], instruction)
    }

    fn crank_epoch(&mut self) -> litesvm::types::TransactionResult {
        let instruction = ix(
            self.program_id,
            arbswap::instruction::CrankEpoch {},
            arbswap::accounts::CrankEpoch {
                vault: self.vault,
                config: self.config,
            },
        );
        let payer = Keypair::new();
        airdrop(&mut self.svm, &payer, 1_000_000_000);
        send(&mut self.svm, &[&payer], instruction)
    }

    fn claim_withdraw_single(
        &mut self,
        user: &Keypair,
        user_base: Address,
        user_quote: Address,
        side: arbswap::SwapSide,
        min_out: u64,
    ) -> litesvm::types::TransactionResult {
        let address = to_address(user.pubkey());
        let instruction = ix(
            self.program_id,
            arbswap::instruction::ClaimWithdrawSingle { side, min_out },
            arbswap::accounts::ClaimWithdrawSingle {
                user: address,
                vault: self.vault,
                config: self.config,
                quote_state: self.quote_state,
                base_reserve: self.base_reserve,
                quote_reserve: self.quote_reserve,
                share_mint: self.share_mint,
                share_lock: self.share_lock,
                withdraw_ticket: pda(
                    &[b"wd", self.vault.as_ref(), address.as_ref()],
                    &self.program_id,
                )
                .0,
                user_base,
                user_quote,
                keeper_reward: self.keeper_reward(),
                token_program: token_program_id(),
                system_program: anchor_lang::system_program::ID,
            },
        );
        send(&mut self.svm, &[user], instruction)
    }

    fn claim_withdraw(
        &mut self,
        user: &Keypair,
        user_base: Address,
        user_quote: Address,
    ) -> litesvm::types::TransactionResult {
        let address = to_address(user.pubkey());
        let instruction = ix(
            self.program_id,
            arbswap::instruction::ClaimWithdraw {},
            arbswap::accounts::ClaimWithdraw {
                user: address,
                vault: self.vault,
                base_reserve: self.base_reserve,
                quote_reserve: self.quote_reserve,
                share_mint: self.share_mint,
                share_lock: self.share_lock,
                withdraw_ticket: pda(
                    &[b"wd", self.vault.as_ref(), address.as_ref()],
                    &self.program_id,
                )
                .0,
                user_base,
                user_quote,
                token_program: token_program_id(),
            },
        );
        send(&mut self.svm, &[user], instruction)
    }

    fn warp_to_slot(&mut self, slot: u64) {
        self.svm.warp_to_slot(slot);
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.slot = slot;
        // Keep the oracle input fresh across the warp so a re-quote still passes
        // the staleness guard.
        clock.unix_timestamp = PUBLISH_TIME;
        self.svm.set_sysvar(&clock);
    }

    fn vault_state(&self) -> Vault {
        read_state(&self.svm, self.vault)
    }

    fn quote_state_value(&self) -> QuoteState {
        read_state(&self.svm, self.quote_state)
    }
}

// ---------------------------------------------------------------------------
// deposit_single
// ---------------------------------------------------------------------------

#[test]
fn deposit_single_base_pulls_only_base_and_mints_shares() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);

    let user_base_before = token_amount(&fixture.svm, fixture.user_base);
    let user_quote_before = token_amount(&fixture.svm, fixture.user_quote);
    let base_reserve_before = token_amount(&fixture.svm, fixture.base_reserve);
    let quote_reserve_before = token_amount(&fixture.svm, fixture.quote_reserve);
    let shares_before = fixture.vault_state().total_shares;

    fixture
        .deposit_single(&keys.user, arbswap::SwapSide::SellBase, SINGLE_AMOUNT, 1, 1)
        .expect("deposit_single(base) failed");

    // Only the base leg moves from the user; the quote leg is untouched.
    assert_eq!(
        user_base_before - token_amount(&fixture.svm, fixture.user_base),
        SINGLE_AMOUNT
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.user_quote),
        user_quote_before,
        "quote ATA must not move"
    );
    // The whole input arrives in the reserve (its fee stays as buckets).
    assert_eq!(
        token_amount(&fixture.svm, fixture.base_reserve),
        base_reserve_before + SINGLE_AMOUNT
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.quote_reserve),
        quote_reserve_before
    );
    let shares = token_amount(&fixture.svm, fixture.user_shares);
    assert!(shares > 0, "must mint shares");
    assert_eq!(fixture.vault_state().total_shares, shares_before + shares);
    let ticket: DepositTicket = read_state(
        &fixture.svm,
        pda(
            &[b"dep", fixture.vault.as_ref(), keys.user.pubkey().as_ref()],
            &fixture.program_id,
        )
        .0,
    );
    assert_eq!(ticket.shares, shares);
    assert_eq!(ticket.owner, keys.user.pubkey());
}

#[test]
fn deposit_single_quote_pulls_only_quote_and_mints_shares() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);

    let user_base_before = token_amount(&fixture.svm, fixture.user_base);
    let user_quote_before = token_amount(&fixture.svm, fixture.user_quote);
    let base_reserve_before = token_amount(&fixture.svm, fixture.base_reserve);
    let quote_reserve_before = token_amount(&fixture.svm, fixture.quote_reserve);

    fixture
        .deposit_single(&keys.user, arbswap::SwapSide::BuyBase, SINGLE_AMOUNT, 1, 1)
        .expect("deposit_single(quote) failed");

    assert_eq!(
        user_quote_before - token_amount(&fixture.svm, fixture.user_quote),
        SINGLE_AMOUNT
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.user_base),
        user_base_before,
        "base ATA must not move"
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.quote_reserve),
        quote_reserve_before + SINGLE_AMOUNT
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.base_reserve),
        base_reserve_before
    );
    assert!(token_amount(&fixture.svm, fixture.user_shares) > 0);
}

#[test]
fn deposit_single_does_not_dilute_existing_lp_value() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);

    let value_before = lp_value(&fixture);
    fixture
        .deposit_single(&keys.user, arbswap::SwapSide::SellBase, SINGLE_AMOUNT, 1, 1)
        .expect("deposit_single failed");
    let value_after = lp_value(&fixture);

    // The single-sided entrant pays fee + spread; the incumbent LP's value per
    // share must not fall beyond integer rounding (1 quote atom tolerance).
    assert!(
        value_after + 1 >= value_before,
        "existing LP value fell: {value_before} -> {value_after}"
    );
}

#[test]
fn deposit_single_rejects_over_max_quote_size() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    assert_anchor_error(
        fixture.deposit_single(
            &keys.user,
            arbswap::SwapSide::SellBase,
            MAX_QUOTE_SIZE + 1,
            0,
            0,
        ),
        "CapacityExceeded",
    );
}

#[test]
fn deposit_single_rejects_zero_amount() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    assert_anchor_error(
        fixture.deposit_single(&keys.user, arbswap::SwapSide::SellBase, 0, 0, 0),
        "CapacityExceeded",
    );
}

#[test]
fn deposit_single_enforces_min_shares_and_min_swap_out() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    assert_anchor_error(
        fixture.deposit_single(
            &keys.user,
            arbswap::SwapSide::SellBase,
            SINGLE_AMOUNT,
            u64::MAX,
            0,
        ),
        "SlippageExceeded",
    );
    assert_anchor_error(
        fixture.deposit_single(
            &keys.user,
            arbswap::SwapSide::SellBase,
            SINGLE_AMOUNT,
            0,
            u64::MAX,
        ),
        "SlippageExceeded",
    );
}

#[test]
fn deposit_single_rejects_expired_and_unattributed_quotes() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);

    // Expired quote.
    let expiry = fixture.quote_state_value().expiry_slot;
    fixture.warp_to_slot(expiry);
    assert_anchor_error(
        fixture.deposit_single(&keys.user, arbswap::SwapSide::SellBase, SINGLE_AMOUNT, 0, 0),
        "QuoteExpired",
    );
}

#[test]
fn deposit_single_atomic_failure_leaves_state_unchanged() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);

    let base_before = token_amount(&fixture.svm, fixture.base_reserve);
    let quote_before = token_amount(&fixture.svm, fixture.quote_reserve);
    let user_base_before = token_amount(&fixture.svm, fixture.user_base);
    let user_quote_before = token_amount(&fixture.svm, fixture.user_quote);
    let shares_before = fixture.vault_state().total_shares;

    assert_anchor_error(
        fixture.deposit_single(
            &keys.user,
            arbswap::SwapSide::SellBase,
            SINGLE_AMOUNT,
            u64::MAX,
            0,
        ),
        "SlippageExceeded",
    );

    assert_eq!(
        token_amount(&fixture.svm, fixture.base_reserve),
        base_before
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.quote_reserve),
        quote_before
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.user_base),
        user_base_before
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.user_quote),
        user_quote_before
    );
    assert_eq!(fixture.vault_state().total_shares, shares_before);
}

#[test]
fn deposit_single_respects_flow_cap() {
    let keys = Keys::new();
    // A zero-bps window cap rejects any non-zero base leg.
    let mut fixture = Fixture::with_config(&keys, 100, 0);
    assert_anchor_error(
        fixture.deposit_single(&keys.user, arbswap::SwapSide::SellBase, SINGLE_AMOUNT, 0, 0),
        "FlowCapExceeded",
    );
}

// ---------------------------------------------------------------------------
// claim_withdraw_single
// ---------------------------------------------------------------------------

fn queue_withdrawal(fixture: &mut Fixture, keys: &Keys, shares: u64) {
    fixture
        .request_withdraw(&keys.lp, shares)
        .expect("request_withdraw");
    fixture.warp_to_slot(64);
    fixture.crank_epoch().expect("crank_epoch");
    // Re-commit a fresh quote at the new slot so the single-sided claim passes
    // the freshness guard.
    let fresh = fixture.post_pyth(PYTH_PRICE, 1, PUBLISH_TIME, VerificationLevel::Full);
    fixture
        .update_quote(&keys.keeper, fresh, quote_update(64))
        .expect("refresh quote");
}

#[test]
fn claim_withdraw_single_pays_only_the_chosen_token() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);

    // Give the LP some shares that are not locked as min-liquidity.
    fixture
        .deposit(&keys.lp, 10_000_000, 10_000_000, 1)
        .expect("second deposit failed");
    let shares = token_amount(&fixture.svm, fixture.lp_shares);
    assert!(shares > 1);
    let withdraw_shares = 10_000;
    queue_withdrawal(&mut fixture, &keys, withdraw_shares);

    let base_before = token_amount(&fixture.svm, fixture.lp_base);
    let quote_before = token_amount(&fixture.svm, fixture.lp_quote);
    let total_before = fixture.vault_state().total_shares;

    fixture
        .claim_withdraw_single(
            &keys.lp,
            fixture.lp_base,
            fixture.lp_quote,
            arbswap::SwapSide::BuyBase,
            1,
        )
        .expect("claim_withdraw_single(base) failed");

    assert!(
        token_amount(&fixture.svm, fixture.lp_base) > base_before,
        "base payout must be positive"
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.lp_quote),
        quote_before,
        "quote ATA must not move on a base-side claim"
    );
    assert_eq!(
        fixture.vault_state().total_shares,
        total_before - withdraw_shares
    );
    let ticket: WithdrawTicket = read_state(
        &fixture.svm,
        pda(
            &[b"wd", fixture.vault.as_ref(), keys.lp.pubkey().as_ref()],
            &fixture.program_id,
        )
        .0,
    );
    assert_eq!(ticket.shares, 0, "ticket marked claimed");
}

#[test]
fn claim_withdraw_single_requires_a_fresh_quote() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, 10_000_000, 10_000_000, 1)
        .expect("second deposit failed");
    const WITHDRAW_SHARES: u64 = 10_000;
    fixture
        .request_withdraw(&keys.lp, WITHDRAW_SHARES)
        .expect("queue");
    fixture.warp_to_slot(64);
    fixture.crank_epoch().expect("crank");

    let lock_before = token_amount(&fixture.svm, fixture.share_lock);
    let total_before = fixture.vault_state().total_shares;
    // The quote from SLOT has expired by slot 64.
    assert_anchor_error(
        fixture.claim_withdraw_single(
            &keys.lp,
            fixture.lp_base,
            fixture.lp_quote,
            arbswap::SwapSide::BuyBase,
            1,
        ),
        "QuoteExpired",
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.share_lock),
        lock_before,
        "shares stay locked on revert"
    );
    assert_eq!(fixture.vault_state().total_shares, total_before);
}

#[test]
fn claim_withdraw_single_enforces_min_out() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, 10_000_000, 10_000_000, 1)
        .expect("second deposit failed");
    queue_withdrawal(&mut fixture, &keys, 10_000);
    assert_anchor_error(
        fixture.claim_withdraw_single(
            &keys.lp,
            fixture.lp_base,
            fixture.lp_quote,
            arbswap::SwapSide::BuyBase,
            u64::MAX,
        ),
        "SlippageExceeded",
    );
}

#[test]
fn claim_withdraw_single_capacity_failure_leaves_ticket_intact() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, 10_000_000, 10_000_000, 1)
        .expect("second deposit failed");
    // Withdraw nearly the whole pool: the unwanted leg cannot be absorbed by
    // the test ladder, so the claim must revert and leave the ticket untouched.
    let shares = token_amount(&fixture.svm, fixture.lp_shares) - 1;
    queue_withdrawal(&mut fixture, &keys, shares);

    let lock_before = token_amount(&fixture.svm, fixture.share_lock);
    let total_before = fixture.vault_state().total_shares;
    assert_anchor_error(
        fixture.claim_withdraw_single(
            &keys.lp,
            fixture.lp_base,
            fixture.lp_quote,
            arbswap::SwapSide::BuyBase,
            1,
        ),
        "CapacityExceeded",
    );
    assert_eq!(token_amount(&fixture.svm, fixture.share_lock), lock_before);
    assert_eq!(fixture.vault_state().total_shares, total_before);
    let ticket: WithdrawTicket = read_state(
        &fixture.svm,
        pda(
            &[b"wd", fixture.vault.as_ref(), keys.lp.pubkey().as_ref()],
            &fixture.program_id,
        )
        .0,
    );
    assert_eq!(
        ticket.shares, shares,
        "ticket preserved for the fallback path"
    );
}

#[test]
fn claim_withdraw_single_quote_side_pays_only_quote() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, 10_000_000, 10_000_000, 1)
        .expect("second deposit failed");
    queue_withdrawal(&mut fixture, &keys, 10_000);

    let base_before = token_amount(&fixture.svm, fixture.lp_base);
    let quote_before = token_amount(&fixture.svm, fixture.lp_quote);

    fixture
        .claim_withdraw_single(
            &keys.lp,
            fixture.lp_base,
            fixture.lp_quote,
            arbswap::SwapSide::SellBase,
            1,
        )
        .expect("claim_withdraw_single(quote) failed");

    assert!(
        token_amount(&fixture.svm, fixture.lp_quote) > quote_before,
        "quote payout must be positive"
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.lp_base),
        base_before,
        "base ATA must not move on a quote-side claim"
    );
}

/// The two-sided `claim_withdraw` must keep working with an expired quote; only
/// the single-sided path needs a fresh one.
#[test]
fn two_sided_claim_withdraw_still_works_with_an_expired_quote() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, 10_000_000, 10_000_000, 1)
        .expect("second deposit failed");
    const WITHDRAW_SHARES: u64 = 10_000;
    fixture
        .request_withdraw(&keys.lp, WITHDRAW_SHARES)
        .expect("queue");
    fixture.warp_to_slot(64);
    fixture.crank_epoch().expect("crank");

    let base_before = token_amount(&fixture.svm, fixture.lp_base);
    let quote_before = token_amount(&fixture.svm, fixture.lp_quote);
    fixture
        .claim_withdraw(&keys.lp, fixture.lp_base, fixture.lp_quote)
        .expect("two-sided claim must succeed on an expired quote");
    assert!(token_amount(&fixture.svm, fixture.lp_base) > base_before);
    assert!(token_amount(&fixture.svm, fixture.lp_quote) > quote_before);
}

// ---------------------------------------------------------------------------
// guards
// ---------------------------------------------------------------------------

#[test]
fn single_sided_ops_reject_a_paused_vault() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    // Wind down pauses the vault.
    let instruction = ix(
        fixture.program_id,
        arbswap::instruction::WindDown {},
        arbswap::accounts::WindDown {
            admin: to_address(keys.admin.pubkey()),
            vault: fixture.vault,
        },
    );
    send(&mut fixture.svm, &[&keys.admin], instruction).expect("wind_down");
    assert_eq!(fixture.vault_state().status, 2);
    assert_anchor_error(
        fixture.deposit_single(&keys.user, arbswap::SwapSide::SellBase, SINGLE_AMOUNT, 0, 0),
        "Paused",
    );
}

#[test]
fn single_sided_ops_reject_a_foreign_quote_state() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    // Point quote_state at a wrong PDA; the seed constraint must reject it.
    let wrong = Address::new_unique();
    let instruction = ix(
        fixture.program_id,
        arbswap::instruction::DepositSingle {
            side: arbswap::SwapSide::SellBase,
            amount_in: SINGLE_AMOUNT,
            min_shares: 0,
            min_swap_out: 0,
        },
        arbswap::accounts::DepositSingle {
            user: to_address(keys.user.pubkey()),
            vault: fixture.vault,
            config: fixture.config,
            quote_state: wrong,
            base_reserve: fixture.base_reserve,
            quote_reserve: fixture.quote_reserve,
            share_mint: fixture.share_mint,
            share_lock: fixture.share_lock,
            user_base: fixture.user_base,
            user_quote: fixture.user_quote,
            user_shares: fixture.user_shares,
            deposit_ticket: pda(
                &[b"dep", fixture.vault.as_ref(), keys.user.pubkey().as_ref()],
                &fixture.program_id,
            )
            .0,
            keeper_reward: fixture.keeper_reward(),
            token_program: token_program_id(),
            system_program: anchor_lang::system_program::ID,
        },
    );
    assert_account_rejected(
        send(&mut fixture.svm, &[&keys.user], instruction),
        "quote_state",
    );
}

#[test]
fn deposit_single_conserves_reserves_and_ticket() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let base_before = token_amount(&fixture.svm, fixture.base_reserve);
    let quote_before = token_amount(&fixture.svm, fixture.quote_reserve);
    let user_base_before = token_amount(&fixture.svm, fixture.user_base);
    let user_quote_before = token_amount(&fixture.svm, fixture.user_quote);
    let total_before = fixture.vault_state().total_shares;

    fixture
        .deposit_single(&keys.user, arbswap::SwapSide::SellBase, SINGLE_AMOUNT, 1, 1)
        .expect("deposit_single(base) failed");

    // Exactly the input moves: user -amount_in, input reserve +amount_in, output
    // reserve untouched (the converted leg is a claim on the ladder, not a token
    // movement).
    assert_eq!(
        user_base_before - token_amount(&fixture.svm, fixture.user_base),
        SINGLE_AMOUNT
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.base_reserve),
        base_before + SINGLE_AMOUNT
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.quote_reserve),
        quote_before
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.user_quote),
        user_quote_before
    );

    let ticket: DepositTicket = read_state(
        &fixture.svm,
        pda(
            &[b"dep", fixture.vault.as_ref(), keys.user.pubkey().as_ref()],
            &fixture.program_id,
        )
        .0,
    );
    assert!(ticket.shares > 0);
    assert_eq!(
        fixture.vault_state().total_shares,
        total_before + ticket.shares
    );
}

#[test]
fn claim_withdraw_single_rejects_before_the_epoch() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, 10_000_000, 10_000_000, 1)
        .expect("second deposit failed");
    // Queue at SLOT; the ticket's epoch gate is not open until the crank.
    fixture
        .request_withdraw(&keys.lp, 10_000)
        .expect("queue withdraw");
    assert_anchor_error(
        fixture.claim_withdraw_single(
            &keys.lp,
            fixture.lp_base,
            fixture.lp_quote,
            arbswap::SwapSide::BuyBase,
            1,
        ),
        "EpochNotReached",
    );
}

#[test]
fn claim_withdraw_single_double_claim_rejected() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    fixture
        .deposit(&keys.lp, 10_000_000, 10_000_000, 1)
        .expect("second deposit failed");
    queue_withdrawal(&mut fixture, &keys, 10_000);
    fixture
        .claim_withdraw_single(
            &keys.lp,
            fixture.lp_base,
            fixture.lp_quote,
            arbswap::SwapSide::BuyBase,
            1,
        )
        .expect("first claim");
    // The ticket is spent; a second claim of the same ticket must fail.
    assert_anchor_error(
        fixture.claim_withdraw_single(
            &keys.lp,
            fixture.lp_base,
            fixture.lp_quote,
            arbswap::SwapSide::BuyBase,
            1,
        ),
        "InvalidAmount",
    );
}

#[test]
fn deposit_single_rejects_token_2022() {
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);
    let instruction = ix(
        fixture.program_id,
        arbswap::instruction::DepositSingle {
            side: arbswap::SwapSide::SellBase,
            amount_in: SINGLE_AMOUNT,
            min_shares: 0,
            min_swap_out: 0,
        },
        arbswap::accounts::DepositSingle {
            user: to_address(keys.user.pubkey()),
            vault: fixture.vault,
            config: fixture.config,
            quote_state: fixture.quote_state,
            base_reserve: fixture.base_reserve,
            quote_reserve: fixture.quote_reserve,
            share_mint: fixture.share_mint,
            share_lock: fixture.share_lock,
            user_base: fixture.user_base,
            user_quote: fixture.user_quote,
            user_shares: fixture.user_shares,
            deposit_ticket: pda(
                &[b"dep", fixture.vault.as_ref(), keys.user.pubkey().as_ref()],
                &fixture.program_id,
            )
            .0,
            keeper_reward: fixture.keeper_reward(),
            token_program: token_2022_program_id(),
            system_program: anchor_lang::system_program::ID,
        },
    );
    assert!(
        send(&mut fixture.svm, &[&keys.user], instruction).is_err(),
        "Token-2022 must be rejected by the classic-token constraint"
    );
}

/// Task 3.5: both new instructions must stay well inside the 200k-CU program
/// limit (bounded bisection <= 64 steps x 6 levels).
#[test]
fn single_sided_compute_units_within_budget() {
    const CU_BUDGET: u64 = 200_000;
    let keys = Keys::new();
    let mut fixture = Fixture::new(&keys);

    let deposit = fixture
        .deposit_single(&keys.user, arbswap::SwapSide::SellBase, SINGLE_AMOUNT, 1, 1)
        .expect("deposit_single");
    println!("deposit_single CU = {}", deposit.compute_units_consumed);
    assert!(
        deposit.compute_units_consumed < CU_BUDGET,
        "deposit_single used {} CU",
        deposit.compute_units_consumed
    );

    fixture
        .deposit(&keys.lp, 10_000_000, 10_000_000, 1)
        .expect("second deposit failed");
    queue_withdrawal(&mut fixture, &keys, 10_000);
    let claim = fixture
        .claim_withdraw_single(
            &keys.lp,
            fixture.lp_base,
            fixture.lp_quote,
            arbswap::SwapSide::BuyBase,
            1,
        )
        .expect("claim_withdraw_single");
    println!(
        "claim_withdraw_single CU = {}",
        claim.compute_units_consumed
    );
    assert!(
        claim.compute_units_consumed < CU_BUDGET,
        "claim_withdraw_single used {} CU",
        claim.compute_units_consumed
    );
}

/// Value of one LP share, in quote atoms, at the committed oracle price.
fn lp_value(fixture: &Fixture) -> u128 {
    let vault = fixture.vault_state();
    let total = vault.total_shares as u128;
    if total == 0 {
        return 0;
    }
    let base_net = token_amount(&fixture.svm, fixture.base_reserve)
        .saturating_sub(vault.insurance_base)
        .saturating_sub(vault.keeper_base)
        .saturating_sub(vault.protocol_base) as u128;
    let quote_net = token_amount(&fixture.svm, fixture.quote_reserve)
        .saturating_sub(vault.insurance_quote)
        .saturating_sub(vault.keeper_quote)
        .saturating_sub(vault.protocol_quote) as u128;
    let oracle = fixture.quote_state_value().oracle_price;
    ((base_net.saturating_mul(oracle) >> 64) + quote_net) * 1_000_000_000 / total
}
