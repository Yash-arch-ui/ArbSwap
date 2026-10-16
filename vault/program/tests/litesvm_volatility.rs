//! LiteSVM regression tests for the on-chain volatility guard: the required
//! account cannot be omitted, a disabled (pre-activation) PDA is a no-op, and an
//! enabled PDA fails closed on a missing/stale baseline and enforces the spread
//! floor / depth cap / sigma kill-switch.
use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountSerialize, AnchorSerialize};
use arbswap::{Config, Level, QuoteState, QuoteUpdate, Vault};
use litesvm::LiteSVM;

mod common;
use common::{
    account_data, anchor_bid_ladder, anchor_ladder, pda, pubkey, sbf_artifact_path,
    set_token_account, set_token_mint, to_address, ANCHOR_SQRT,
};
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};
use pythnet_sdk::messages::PriceFeedMessage;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

fn address(key: Pubkey) -> Address {
    Address::from(key.to_bytes())
}

struct Env {
    svm: LiteSVM,
    program_id: Address,
    payer: Keypair,
    payer_address: Address,
    vault_address: Address,
    config_address: Address,
    quote_address: Address,
    pyth_address: Address,
    base_reserve: Address,
    quote_reserve: Address,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    volatility_address: Address,
}

/// Volatility parameters used by the tests (spread floor 1000 bps at sigma 1.0).
#[allow(clippy::too_many_arguments)]
fn install_volatility(
    svm: &mut LiteSVM,
    program_id: Address,
    vault: Address,
    enabled: bool,
    last_price_q64: u128,
    short_ewma_q64: u128,
    last_observation_slot: u64,
    max_observation_age_slots: u64,
    max_sigma_q64: u128,
    vol_spread_coeff_bps: u32,
    vol_depth_coeff_bps: u32,
) -> Address {
    let (addr, bump) = pda(&[b"vol", vault.as_ref()], &program_id);
    let state = arbswap::VolatilityState {
        vault: pubkey(vault),
        short_ewma_q64,
        medium_ewma_q64: 0,
        last_price_q64,
        last_publish_time: 1_000,
        last_observation_slot,
        observation_nonce: 1,
        jump_detected: false,
        jump_until_slot: 0,
        short_lambda_bps: 9_400,
        medium_lambda_bps: 9_900,
        jump_multiple: 4,
        max_sigma_q64,
        jump_cooldown_slots: 1_800,
        vol_spread_coeff_bps,
        vol_depth_coeff_bps,
        max_observation_age_slots,
        enabled,
        bump,
    };
    let mut data = Vec::new();
    state.try_serialize(&mut data).unwrap();
    svm.set_account(
        addr,
        Account {
            lamports: 1_000_000_000,
            data,
            owner: program_id,
            ..Account::default()
        },
    )
    .unwrap();
    addr
}

/// Build the minimal vault/config/quote/oracle that a valid `update_quote`
/// needs, with `max_spread_bps` wide enough that the volatility floor can be
/// the binding constraint.
#[allow(clippy::too_many_arguments)]
fn env(
    enabled: bool,
    last_price_q64: u128,
    short_ewma_q64: u128,
    last_observation_slot: u64,
    max_observation_age_slots: u64,
    max_sigma_q64: u128,
    vol_spread_coeff_bps: u32,
    vol_depth_coeff_bps: u32,
) -> Env {
    let program_id = address(arbswap::ID);
    let mut svm = LiteSVM::new();
    svm.add_program(program_id, &std::fs::read(sbf_artifact_path()).unwrap())
        .unwrap();
    let payer = Keypair::new();
    let payer_address = Address::from(payer.pubkey().to_bytes());
    svm.airdrop(&payer_address, 2_000_000_000).unwrap();
    let mut clock = svm.get_sysvar::<Clock>();
    clock.slot = 2;
    clock.unix_timestamp = 1_000;
    svm.set_sysvar(&clock);

    let base_mint = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let (vault_address, vault_bump) = Address::find_program_address(
        &[b"vault", base_mint.as_ref(), quote_mint.as_ref()],
        &program_id,
    );
    let (config_address, config_bump) =
        Address::find_program_address(&[b"config", vault_address.as_ref()], &program_id);
    let (quote_address, quote_bump) =
        Address::find_program_address(&[b"quote", vault_address.as_ref()], &program_id);
    let feed_id = [7u8; 32];
    let base_reserve = Address::new_unique();
    let quote_reserve = Address::new_unique();

    let vault = Vault {
        admin: Pubkey::new_unique(),
        base_mint,
        quote_mint,
        base_reserve: pubkey(base_reserve),
        quote_reserve: pubkey(quote_reserve),
        share_mint: Pubkey::new_unique(),
        share_lock: Pubkey::new_unique(),
        total_shares: 1,
        insurance_base: 0,
        insurance_quote: 0,
        keeper_base: 0,
        keeper_quote: 0,
        protocol_base: 0,
        protocol_quote: 0,
        epoch: 0,
        epoch_start: 0,
        status: 0,
        bump: vault_bump,
    };
    let config = Config {
        admin: vault.admin,
        keeper: Pubkey::new_from_array(payer.pubkey().to_bytes()),
        treasury: Pubkey::new_from_array(payer.pubkey().to_bytes()),
        pyth_feed_id: feed_id,
        fee_bps: 1,
        insurance_bps: 1,
        keeper_bps: 1,
        protocol_bps: 1,
        min_liquidity: 1,
        warmup_slots: 1,
        epoch_slots: 1,
        grace_slots: 1,
        expiry_slots: 10,
        max_staleness_seconds: 30,
        max_conf_bps: 10,
        max_anchor_step_bps: 100,
        max_spread_step_bps: 100,
        min_spread_bps: 2,
        max_spread_bps: 10_000,
        max_quote_size: 1_000_000,
        max_inventory_bps: 10_000,
        utilization_max_bps: 5_000,
        min_bond: 0,
        unbond_cooldown_slots: 100,
        max_update_slot_age: 25,
        edge_window_slots: 100,
        max_edge_loss_bps: 500,
        max_anchor_dev_bps: 100,
        flow_window_slots: 100,
        max_window_flow_bps: 10_000,
        pending_admin: Pubkey::default(),
        admin_activate_slot: 0,
        bump: config_bump,
    };
    let quote_state = QuoteState {
        version: 0,
        update_slot: 0,
        expiry_slot: 0,
        anchor_sqrt_price: 0,
        p_res_sqrt: 0,
        half_spread_bps: 0,
        ask_extra_bps: 0,
        bid_extra_bps: 0,
        depth_mult_bps: 0,
        window_start_slot: 0,
        window_base_sold: 0,
        window_base_bought: 0,
        oracle_publish_time: 0,
        oracle_conf_bps: 0,
        oracle_price: 0,
        edge_window_start_slot: 0,
        realized_edge: 0,
        flow_n: 0,
        ask_levels: [Level::default(); 6],
        bid_levels: [Level::default(); 6],
        bump: quote_bump,
        keeper: Pubkey::default(),
    };
    svm.set_account(
        vault_address,
        Account {
            lamports: 1_000_000,
            data: account_data(&vault),
            owner: program_id,
            ..Account::default()
        },
    )
    .unwrap();
    svm.set_account(
        config_address,
        Account {
            lamports: 1_000_000,
            data: account_data(&config),
            owner: program_id,
            ..Account::default()
        },
    )
    .unwrap();
    svm.set_account(
        quote_address,
        Account {
            lamports: 1_000_000,
            data: account_data(&quote_state),
            owner: program_id,
            ..Account::default()
        },
    )
    .unwrap();
    let pyth = PriceUpdateV2 {
        write_authority: Pubkey::new_unique(),
        verification_level: VerificationLevel::Full,
        price_message: PriceFeedMessage {
            feed_id,
            ema_conf: 1,
            ema_price: 15_000,
            price: 15_000,
            conf: 1,
            exponent: -2,
            prev_publish_time: 999,
            publish_time: 1_000,
        },
        posted_slot: 1,
    };
    let pyth_address = Address::new_unique();
    svm.set_account(
        pyth_address,
        Account {
            lamports: 1_000_000,
            data: account_data(&pyth),
            owner: address(pyth_solana_receiver_sdk::ID),
            ..Account::default()
        },
    )
    .unwrap();
    set_token_account(
        &mut svm,
        base_reserve,
        to_address(base_mint),
        payer.pubkey(),
        1_000_000,
    );
    set_token_account(
        &mut svm,
        quote_reserve,
        to_address(quote_mint),
        payer.pubkey(),
        1_000_000,
    );
    set_token_mint(&mut svm, to_address(base_mint), 9, payer.pubkey());
    set_token_mint(&mut svm, to_address(quote_mint), 9, payer.pubkey());

    let volatility_address = install_volatility(
        &mut svm,
        program_id,
        vault_address,
        enabled,
        last_price_q64,
        short_ewma_q64,
        last_observation_slot,
        max_observation_age_slots,
        max_sigma_q64,
        vol_spread_coeff_bps,
        vol_depth_coeff_bps,
    );

    Env {
        svm,
        program_id,
        payer,
        payer_address,
        vault_address,
        config_address,
        quote_address,
        pyth_address,
        base_reserve,
        quote_reserve,
        base_mint,
        quote_mint,
        volatility_address,
    }
}

fn update_quote(
    e: &mut Env,
    half_spread_bps: u32,
    depth_mult_bps: u32,
    include_volatility: bool,
) -> litesvm::types::TransactionResult {
    let update = QuoteUpdate {
        update_slot: 1,
        oracle_publish_time: 1_000,
        oracle_conf_bps: 1,
        anchor_sqrt_price: ANCHOR_SQRT,
        p_res_sqrt: ANCHOR_SQRT,
        half_spread_bps,
        ask_extra_bps: 0,
        bid_extra_bps: 0,
        depth_mult_bps,
        offsets_bps: [1, 2, 3, 4, 5, 6],
        weights_bps: [1_000, 1_500, 2_000, 2_000, 2_000, 1_500],
        // The ladder is anchored with a small spread so its levels always sit
        // inside the anchor band; the *declared* `half_spread_bps` is what the
        // volatility guard checks.
        ask_levels: anchor_ladder(ANCHOR_SQRT, 2, [1, 2, 3, 4, 5, 6], 1_000),
        bid_levels: anchor_bid_ladder(ANCHOR_SQRT, 2, [1, 2, 3, 4, 5, 6], 1_000),
    };
    let mut hash = Sha256::new();
    hash.update(b"global:update_quote");
    let mut data = hash.finalize()[..8].to_vec();
    update.serialize(&mut data).unwrap();
    let mut accounts = vec![
        AccountMeta::new_readonly(e.payer_address, true),
        AccountMeta::new(e.vault_address, false),
        AccountMeta::new_readonly(e.config_address, false),
        AccountMeta::new(e.quote_address, false),
        AccountMeta::new_readonly(e.pyth_address, false),
        AccountMeta::new_readonly(
            pda(
                &[
                    b"keeper",
                    e.vault_address.as_ref(),
                    e.payer_address.as_ref(),
                ],
                &e.program_id,
            )
            .0,
            false,
        ),
        AccountMeta::new_readonly(e.base_reserve, false),
        AccountMeta::new_readonly(e.quote_reserve, false),
        AccountMeta::new_readonly(to_address(e.base_mint), false),
        AccountMeta::new_readonly(to_address(e.quote_mint), false),
    ];
    if include_volatility {
        accounts.push(AccountMeta::new_readonly(e.volatility_address, false));
    }
    let ix = Instruction {
        program_id: e.program_id,
        accounts,
        data,
    };
    e.svm.expire_blockhash();
    let tx = Transaction::new(
        &[&e.payer],
        Message::new(&[ix], Some(&e.payer_address)),
        e.svm.latest_blockhash(),
    );
    e.svm.send_transaction(tx)
}

const Q64: u128 = 1u128 << 64;

#[test]
fn disabled_volatility_is_a_noop_for_legacy_quotes() {
    // enabled = false: even a tiny spread passes; the account is still required.
    let mut e = env(false, 0, 0, 0, 100, u128::MAX, 1_000, 2_000);
    assert!(
        update_quote(&mut e, 2, 10_000, true).is_ok(),
        "a disabled PDA must not change legacy quote behaviour"
    );
}

#[test]
fn omitting_the_required_volatility_account_is_rejected() {
    let mut e = env(false, 0, 0, 0, 100, u128::MAX, 1_000, 2_000);
    // The account is required, so a caller cannot bypass enforcement by leaving
    // it out. Anchor reports AccountNotEnoughKeys (3005).
    let outcome = update_quote(&mut e, 2, 10_000, false);
    assert!(outcome.is_err(), "omitting the required PDA must fail");
    let logs = format!("{:?}", outcome.err());
    assert!(
        logs.contains("AccountNotEnoughKeys") || logs.contains("3005"),
        "unexpected error: {logs}"
    );
}

#[test]
fn enabled_without_baseline_fails_closed() {
    // enabled but last_price_q64 == 0: no baseline -> reject, not "allow".
    let mut e = env(true, 0, 0, 2, 100, u128::MAX, 1_000, 2_000);
    let outcome = update_quote(&mut e, 2, 10_000, true);
    assert!(
        outcome.is_err(),
        "an enabled PDA without a baseline must fail closed"
    );
    let logs = format!("{:?}", outcome.err());
    assert!(
        logs.contains("StaleVolatilityObservation"),
        "unexpected error: {logs}"
    );
}

#[test]
fn enabled_stale_observation_is_rejected() {
    // Fresh baseline value but the observation is older than the allowed age.
    let mut e = env(true, Q64, Q64, 0, 1, u128::MAX, 1_000, 2_000);
    let outcome = update_quote(&mut e, 2, 10_000, true);
    assert!(outcome.is_err(), "a stale observation must fail closed");
    let logs = format!("{:?}", outcome.err());
    assert!(
        logs.contains("StaleVolatilityObservation"),
        "unexpected error: {logs}"
    );
}

#[test]
fn enabled_low_spread_below_floor_is_rejected() {
    // sigma = 1.0 -> sigma_bps = 10_000; spread coeff 1_000 -> floor 1_000 bps.
    let mut e = env(true, Q64, Q64, 2, 100, u128::MAX, 1_000, 2_000);
    let outcome = update_quote(&mut e, 999, 8_000, true);
    assert!(
        outcome.is_err(),
        "a spread below the volatility floor must be rejected"
    );
    let logs = format!("{:?}", outcome.err());
    assert!(
        logs.contains("VolatilitySpreadTooLow"),
        "unexpected error: {logs}"
    );
}

#[test]
fn enabled_compliant_spread_and_depth_passes() {
    // floor 1_000 bps, depth cap 10_000 - 2_000 = 8_000 bps.
    let mut e = env(true, Q64, Q64, 2, 100, u128::MAX, 1_000, 2_000);
    let outcome = update_quote(&mut e, 1_000, 8_000, true);
    assert!(
        outcome.is_ok(),
        "a spread at the floor and depth at the cap must be accepted: {:?}",
        outcome.err()
    );
}

#[test]
fn enabled_depth_above_cap_is_rejected() {
    let mut e = env(true, Q64, Q64, 2, 100, u128::MAX, 1_000, 2_000);
    let outcome = update_quote(&mut e, 1_000, 8_001, true);
    assert!(outcome.is_err(), "a depth above the cap must be rejected");
    let logs = format!("{:?}", outcome.err());
    assert!(
        logs.contains("DepthAboveVolatility"),
        "unexpected error: {logs}"
    );
}

#[test]
fn enabled_sigma_above_ceiling_trips_kill_switch() {
    // sigma = 1.0 with a ceiling well below it.
    let mut e = env(true, Q64, Q64, 2, 100, 1u128 << 50, 1_000, 2_000);
    let outcome = update_quote(&mut e, 5_000, 1_000, true);
    assert!(outcome.is_err(), "sigma above the ceiling must be rejected");
    let logs = format!("{:?}", outcome.err());
    assert!(
        logs.contains("VolatilityTooHigh"),
        "unexpected error: {logs}"
    );
}
