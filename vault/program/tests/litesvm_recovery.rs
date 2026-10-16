//! S2-18: expired-quote recovery tests for `update_quote`.
//!
//! Normal refresh keeps the previous-anchor step guard. When the committed quote
//! is genuinely expired (or its stored oracle is stale), the step guard is
//! skipped and the keeper may re-anchor directly to the verified Pyth price —
//! but the oracle-deviation bound and every other quote check still apply.
//!
//! These tests build the vault/quote/oracle state by hand on LiteSVM and assert
//! on symbolic Anchor error names, like `litesvm_oracle_scaling`.

mod common;

use anchor_lang::prelude::Pubkey;
use arbswap::{Config, Level, QuoteState, QuoteUpdate, Vault};
use common::*;
use litesvm::LiteSVM;
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

/// 150.0 USDC/SOL normalized to token units for a 9/6 pair (reference).
const BASE_PRICE_Q64: u128 = 2_767_011_611_056_432_742;
/// 165.0 USDC/SOL normalized for 9/6 — a +10% jump, far beyond step+dev.
const JUMP_PRICE_Q64: u128 = 3_043_712_772_162_076_016;

const FEED_ID: [u8; 32] = [7u8; 32];
const PYTH_EXPO: i32 = -8;

struct Harness {
    svm: LiteSVM,
    program_id: Address,
    payer: Keypair,
    base_mint: Address,
    quote_mint: Address,
    base_reserve: Address,
    quote_reserve: Address,
    vault_address: Address,
    config_address: Address,
    quote_address: Address,
    pyth_address: Address,
}

struct Setup {
    expired: bool,
    pyth_price: i64,
    pyth_conf: u64,
    pyth_feed: [u8; 32],
    pyth_publish_time: i64,
    clock_slot: u64,
    clock_ts: i64,
}

impl Default for Setup {
    fn default() -> Self {
        Setup {
            expired: true,
            pyth_price: 16_500_000_000, // 165.0 with expo -8
            pyth_conf: 1,
            pyth_feed: FEED_ID,
            pyth_publish_time: 2_000,
            clock_slot: 1_000,
            clock_ts: 2_000,
        }
    }
}

fn account_data<T: anchor_lang::AccountSerialize>(value: &T) -> Vec<u8> {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    data
}

/// Mirrors `pyth_price_q64` + `normalize_pyth_price_q64` (9/6).
fn normalized_9_6(price: i64, exponent: i32) -> u128 {
    let p = price as u128;
    let q = if exponent >= 0 {
        p * 10u128.pow(exponent as u32) * (1u128 << 64)
    } else {
        (p << 64) / 10u128.pow((-exponent) as u32)
    };
    q / 1_000
}

fn harness(setup: &Setup) -> Harness {
    let program_id = to_address(arbswap::ID);
    let mut svm = LiteSVM::new();
    svm.add_program(program_id, &std::fs::read(sbf_artifact_path()).unwrap())
        .unwrap();
    let payer = Keypair::new();
    let payer_address = Address::from(payer.pubkey().to_bytes());
    svm.airdrop(&payer_address, 2_000_000_000).unwrap();
    let mut clock = svm.get_sysvar::<Clock>();
    clock.slot = setup.clock_slot;
    clock.unix_timestamp = setup.clock_ts;
    svm.set_sysvar(&clock);

    let base_mint = Address::new_unique();
    let quote_mint = Address::new_unique();
    let (vault_address, vault_bump) = Address::find_program_address(
        &[b"vault", base_mint.as_ref(), quote_mint.as_ref()],
        &program_id,
    );
    let (config_address, config_bump) =
        Address::find_program_address(&[b"config", vault_address.as_ref()], &program_id);
    let (quote_address, quote_bump) =
        Address::find_program_address(&[b"quote", vault_address.as_ref()], &program_id);
    let base_reserve = Address::new_unique();
    let quote_reserve = Address::new_unique();

    let vault = Vault {
        admin: Pubkey::new_unique(),
        base_mint: pubkey(base_mint),
        quote_mint: pubkey(quote_mint),
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
        pyth_feed_id: FEED_ID,
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
        max_anchor_step_bps: 50,
        max_spread_step_bps: 100,
        min_spread_bps: 2,
        max_spread_bps: 60,
        max_quote_size: 1_000_000,
        max_inventory_bps: 10_000,
        utilization_max_bps: 5_000,
        min_bond: 0,
        unbond_cooldown_slots: 100,
        max_update_slot_age: 25,
        edge_window_slots: 100,
        max_edge_loss_bps: 500,
        max_anchor_dev_bps: 25,
        flow_window_slots: 100,
        max_window_flow_bps: 10_000,
        pending_admin: Pubkey::default(),
        admin_activate_slot: 0,
        bump: config_bump,
    };
    let expiry_slot = if setup.expired {
        setup.clock_slot - 5
    } else {
        setup.clock_slot + 5_000
    };
    let quote_state = QuoteState {
        version: 1,
        update_slot: 990,
        expiry_slot,
        anchor_sqrt_price: arb_math::sqrt_q64(BASE_PRICE_Q64).unwrap(),
        p_res_sqrt: arb_math::sqrt_q64(BASE_PRICE_Q64).unwrap(),
        half_spread_bps: 2,
        ask_extra_bps: 0,
        bid_extra_bps: 0,
        depth_mult_bps: 10_000,
        window_start_slot: 0,
        window_base_sold: 0,
        window_base_bought: 0,
        oracle_publish_time: setup.pyth_publish_time - 10,
        oracle_conf_bps: 1,
        oracle_price: BASE_PRICE_Q64,
        edge_window_start_slot: 0,
        realized_edge: 0,
        flow_n: 0,
        ask_levels: [Level::default(); 6],
        bid_levels: [Level::default(); 6],
        bump: quote_bump,
        keeper: Pubkey::default(),
    };
    for (key, data) in [
        (vault_address, account_data(&vault)),
        (config_address, account_data(&config)),
        (quote_address, account_data(&quote_state)),
    ] {
        svm.set_account(
            key,
            Account {
                lamports: 1_000_000,
                data,
                owner: program_id,
                ..Account::default()
            },
        )
        .unwrap();
    }

    let pyth = PriceUpdateV2 {
        write_authority: Pubkey::new_unique(),
        verification_level: VerificationLevel::Full,
        price_message: PriceFeedMessage {
            feed_id: setup.pyth_feed,
            ema_conf: setup.pyth_conf,
            ema_price: setup.pyth_price,
            price: setup.pyth_price,
            conf: setup.pyth_conf,
            exponent: PYTH_EXPO,
            prev_publish_time: setup.pyth_publish_time,
            publish_time: setup.pyth_publish_time,
        },
        posted_slot: 1,
    };
    let pyth_address = Address::new_unique();
    svm.set_account(
        pyth_address,
        Account {
            lamports: 1_000_000,
            data: account_data(&pyth),
            owner: to_address(pyth_solana_receiver_sdk::ID),
            ..Account::default()
        },
    )
    .unwrap();

    set_token_mint(&mut svm, base_mint, 9, payer.pubkey());
    set_token_mint(&mut svm, quote_mint, 6, payer.pubkey());
    set_token_account(
        &mut svm,
        base_reserve,
        base_mint,
        payer.pubkey(),
        10_000_000_000,
    );
    set_token_account(
        &mut svm,
        quote_reserve,
        quote_mint,
        payer.pubkey(),
        10_000_000_000,
    );

    Harness {
        svm,
        program_id,
        payer,
        base_mint,
        quote_mint,
        base_reserve,
        quote_reserve,
        vault_address,
        config_address,
        quote_address,
        pyth_address,
    }
}

fn quote_update(anchor_sqrt: u128, publish_time: i64, update_slot: u64) -> QuoteUpdate {
    QuoteUpdate {
        update_slot,
        oracle_publish_time: publish_time,
        oracle_conf_bps: 1,
        anchor_sqrt_price: anchor_sqrt,
        p_res_sqrt: anchor_sqrt,
        half_spread_bps: 2,
        ask_extra_bps: 0,
        bid_extra_bps: 0,
        depth_mult_bps: 10_000,
        offsets_bps: OFFSETS,
        weights_bps: WEIGHTS,
        ask_levels: anchor_ladder(anchor_sqrt, 2, OFFSETS, 1_000),
        bid_levels: anchor_bid_ladder(anchor_sqrt, 2, OFFSETS, 1_000),
    }
}

fn send_update(h: &mut Harness, update: &QuoteUpdate) -> litesvm::types::TransactionResult {
    let payer_address = Address::from(h.payer.pubkey().to_bytes());
    let mut hash = Sha256::new();
    hash.update(b"global:update_quote");
    let mut data = hash.finalize()[..8].to_vec();
    anchor_lang::AnchorSerialize::serialize(update, &mut data).unwrap();
    let keeper_bond = pda(
        &[b"keeper", h.vault_address.as_ref(), payer_address.as_ref()],
        &h.program_id,
    )
    .0;
    // Required vault-bound volatility PDA; disabled so the recovery paths under
    // test keep their pre-feature behaviour.
    let volatility = set_disabled_volatility(&mut h.svm, h.vault_address);
    let ix = Instruction {
        program_id: h.program_id,
        accounts: vec![
            AccountMeta::new_readonly(payer_address, true),
            AccountMeta::new(h.vault_address, false),
            AccountMeta::new_readonly(h.config_address, false),
            AccountMeta::new(h.quote_address, false),
            AccountMeta::new_readonly(h.pyth_address, false),
            AccountMeta::new_readonly(keeper_bond, false),
            AccountMeta::new_readonly(h.base_reserve, false),
            AccountMeta::new_readonly(h.quote_reserve, false),
            AccountMeta::new_readonly(h.base_mint, false),
            AccountMeta::new_readonly(h.quote_mint, false),
            AccountMeta::new_readonly(volatility, false),
        ],
        data,
    };
    h.svm.expire_blockhash();
    let tx = Transaction::new(
        &[&h.payer],
        Message::new(&[ix], Some(&payer_address)),
        h.svm.latest_blockhash(),
    );
    h.svm.send_transaction(tx)
}

fn target_anchor(price_q64: u128) -> u128 {
    arb_math::sqrt_q64(price_q64).unwrap()
}

#[test]
fn normal_refresh_still_passes_within_bounds() {
    let mut setup = Setup::default();
    setup.expired = false;
    setup.pyth_price = 15_001_500_000; // 150.015, ~1 bp move
    let mut h = harness(&setup);
    let price = normalized_9_6(setup.pyth_price, PYTH_EXPO);
    let update = quote_update(target_anchor(price), setup.pyth_publish_time, 1_000);
    let result = send_update(&mut h, &update);
    assert!(result.is_ok(), "small in-band move must pass: {result:?}");
    let stored: QuoteState = read_state(&h.svm, h.quote_address);
    assert_eq!(stored.version, 2);
}

#[test]
fn large_jump_is_rejected_while_the_quote_is_live() {
    let mut setup = Setup::default();
    setup.expired = false; // committed quote still live -> step guard applies
    let mut h = harness(&setup);
    let update = quote_update(
        target_anchor(JUMP_PRICE_Q64),
        setup.pyth_publish_time,
        1_000,
    );
    assert_anchor_error(send_update(&mut h, &update), "AnchorStepTooLarge");
    let stored: QuoteState = read_state(&h.svm, h.quote_address);
    assert_eq!(
        stored.version, 1,
        "a rejected quote must not bump the version"
    );
}

#[test]
fn same_jump_recovers_after_the_quote_expires() {
    let setup = Setup::default(); // expired = true
    let mut h = harness(&setup);
    let jump = target_anchor(JUMP_PRICE_Q64);
    let result = send_update(&mut h, &quote_update(jump, setup.pyth_publish_time, 1_000));
    assert!(
        result.is_ok(),
        "recovery after expiry must pass: {result:?}"
    );
    let stored: QuoteState = read_state(&h.svm, h.quote_address);
    assert_eq!(stored.version, 2);
    assert_eq!(stored.anchor_sqrt_price, jump);
    // The re-anchored quote is live again (expiry = slot + expiry_slots).
    assert!(stored.expiry_slot > setup.clock_slot);
}

#[test]
fn recovery_still_enforces_the_oracle_deviation_bound() {
    // Expired (recovery eligible) but the submitted anchor is far from the
    // verified Pyth price: the dev guard must still reject it.
    let setup = Setup::default();
    let mut h = harness(&setup);
    let way_far = target_anchor(JUMP_PRICE_Q64).saturating_mul(2); // ~4x price
    let update = quote_update(way_far, setup.pyth_publish_time, 1_000);
    assert_anchor_error(send_update(&mut h, &update), "AnchorTooFarFromOracle");
}

#[test]
fn replayed_slot_is_rejected_in_both_paths() {
    // Fresh path.
    let mut setup = Setup::default();
    setup.expired = false;
    let mut h = harness(&setup);
    let replay = quote_update(target_anchor(BASE_PRICE_Q64), setup.pyth_publish_time, 990);
    assert_anchor_error(send_update(&mut h, &replay), "NonMonotonicSlot");

    // Expired/recovery path: the same monotonic rule still applies.
    let setup = Setup::default();
    let mut h = harness(&setup);
    let replay = quote_update(target_anchor(JUMP_PRICE_Q64), setup.pyth_publish_time, 990);
    assert_anchor_error(send_update(&mut h, &replay), "NonMonotonicSlot");
}

#[test]
fn stale_oracle_is_rejected_in_both_paths() {
    let mut setup = Setup::default();
    setup.expired = true;
    setup.clock_ts = setup.pyth_publish_time + 100; // > max_staleness (30)
    let mut h = harness(&setup);
    let update = quote_update(
        target_anchor(JUMP_PRICE_Q64),
        setup.pyth_publish_time,
        1_000,
    );
    assert_anchor_error(send_update(&mut h, &update), "InvalidOracle");
}

#[test]
fn wrong_feed_is_rejected_in_both_paths() {
    let mut setup = Setup::default();
    setup.expired = true;
    setup.pyth_feed = [9u8; 32];
    let mut h = harness(&setup);
    let update = quote_update(
        target_anchor(JUMP_PRICE_Q64),
        setup.pyth_publish_time,
        1_000,
    );
    assert_anchor_error(send_update(&mut h, &update), "InvalidOracle");
}

#[test]
fn low_confidence_is_rejected_in_both_paths() {
    let mut setup = Setup::default();
    setup.expired = true;
    setup.pyth_conf = 1_000_000_000; // ~607 bps >> max_conf (10)
    let mut h = harness(&setup);
    let update = quote_update(
        target_anchor(JUMP_PRICE_Q64),
        setup.pyth_publish_time,
        1_000,
    );
    assert_anchor_error(send_update(&mut h, &update), "WideConfidence");
}
