//! B1 regression: the executable oracle price is a *token-unit* price
//! (`quote-atoms per base-atom`) derived on-chain from the verified Pyth value
//! and the vault's own mint decimals.
//!
//! These tests build a minimal `update_quote` harness by hand (like
//! `litesvm_breaker`) so they can vary the mint decimals and the submitted
//! price independently of the big lifecycle fixture.

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountSerialize, AnchorSerialize};
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

/// Human SOL/USD = 150.0 (Pyth `price = 15_000_000_000`, exponent `-8`) as Q64.
const HUMAN_Q64: u128 = 150u128 << 64;
/// Independent expected token-unit price for a 9/6 pair: `floor(150e-3 * 2^64)`.
/// Computed by hand (NOT by calling the program/keeper helper).
const NORMALIZED_9_6_Q64: u128 = 2_767_011_611_056_432_742;

fn account_data<T: AccountSerialize>(value: &T) -> Vec<u8> {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    data
}

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

/// Build a minimal vault + oracle for `base_decimals`/`quote_decimals`, with a
/// ladder anchored at the given token-unit price and small capacity so it fits
/// the utilization bound.
fn harness(base_decimals: u8, quote_decimals: u8, anchor_price_q64: u128) -> Harness {
    let program_id = to_address(arbswap::ID);
    let mut svm = LiteSVM::new();
    let program = sbf_artifact_path();
    svm.add_program(program_id, &std::fs::read(program).unwrap())
        .unwrap();
    let payer = Keypair::new();
    let payer_address = Address::from(payer.pubkey().to_bytes());
    svm.airdrop(&payer_address, 2_000_000_000).unwrap();
    let mut clock = svm.get_sysvar::<Clock>();
    clock.slot = 2;
    clock.unix_timestamp = 1_000;
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
    let feed_id = [7u8; 32];
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
        max_spread_bps: 50,
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
            feed_id,
            ema_conf: 1,
            ema_price: 15_000_000_000,
            price: 15_000_000_000,
            conf: 1,
            exponent: -8,
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
            owner: to_address(pyth_solana_receiver_sdk::ID),
            ..Account::default()
        },
    )
    .unwrap();

    set_token_mint(&mut svm, base_mint, base_decimals, payer.pubkey());
    set_token_mint(&mut svm, quote_mint, quote_decimals, payer.pubkey());
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
    let _ = anchor_price_q64;
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

fn quote_update(anchor_sqrt: u128, update_slot: u64) -> QuoteUpdate {
    let ask_levels = anchor_ladder(anchor_sqrt, 2, [1, 2, 3, 4, 5, 6], 1_000);
    let bid_levels = anchor_bid_ladder(anchor_sqrt, 2, [1, 2, 3, 4, 5, 6], 1_000);
    QuoteUpdate {
        update_slot,
        oracle_publish_time: 1_000,
        oracle_conf_bps: 1,
        anchor_sqrt_price: anchor_sqrt,
        p_res_sqrt: anchor_sqrt,
        half_spread_bps: 2,
        ask_extra_bps: 0,
        bid_extra_bps: 0,
        depth_mult_bps: 10_000,
        offsets_bps: [1, 2, 3, 4, 5, 6],
        weights_bps: [1_000, 1_500, 2_000, 2_000, 2_000, 1_500],
        ask_levels,
        bid_levels,
    }
}

fn send_update(
    h: &mut Harness,
    update: &QuoteUpdate,
    base_mint: Address,
    quote_mint: Address,
) -> litesvm::types::TransactionResult {
    let payer_address = Address::from(h.payer.pubkey().to_bytes());
    let mut hash = Sha256::new();
    hash.update(b"global:update_quote");
    let mut data = hash.finalize()[..8].to_vec();
    update.serialize(&mut data).unwrap();
    let keeper_bond = pda(
        &[b"keeper", h.vault_address.as_ref(), payer_address.as_ref()],
        &h.program_id,
    )
    .0;
    // Required vault-bound volatility PDA; disabled, so the quote math under
    // test is unchanged by the volatility feature.
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
            AccountMeta::new_readonly(base_mint, false),
            AccountMeta::new_readonly(quote_mint, false),
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

#[test]
fn nine_six_vault_derives_normalized_price_from_verified_pyth() {
    // S2-9: the payload carries no price; the program derives the token-unit
    // price from the verified Pyth value (150.0) and the 9/6 mint decimals.
    let anchor = arb_math::sqrt_q64(NORMALIZED_9_6_Q64).unwrap();
    let mut h = harness(9, 6, NORMALIZED_9_6_Q64);
    let (bm, qm) = (h.base_mint, h.quote_mint);

    let ok = send_update(&mut h, &quote_update(anchor, 1), bm, qm);
    assert!(ok.is_ok(), "normalized 9/6 update must be accepted: {ok:?}");

    // The stored price is exactly the token-unit value consumed by swap math.
    let stored: QuoteState = read_state(&h.svm, h.quote_address);
    assert_eq!(stored.oracle_price, NORMALIZED_9_6_Q64);
    assert_eq!(stored.version, 1);

    // A different mint account is rejected by the address binding: decimals
    // cannot be swapped in to change the derived price.
    let forged_mint = Address::new_unique();
    set_token_mint(&mut h.svm, forged_mint, 6, h.payer.pubkey());
    let forged = send_update(&mut h, &quote_update(anchor, 2), bm, forged_mint);
    assert_account_rejected(forged, "quote_mint");
}

#[test]
fn nine_nine_vault_derives_unscaled_price() {
    let anchor = arb_math::sqrt_q64(HUMAN_Q64).unwrap();
    let mut h = harness(9, 9, HUMAN_Q64);
    let (bm, qm) = (h.base_mint, h.quote_mint);

    let ok = send_update(&mut h, &quote_update(anchor, 1), bm, qm);
    assert!(ok.is_ok(), "9/9 identity price must be accepted: {ok:?}");
    let stored: QuoteState = read_state(&h.svm, h.quote_address);
    assert_eq!(stored.oracle_price, HUMAN_Q64);
}

#[test]
fn stale_oracle_still_fails_under_existing_rules() {
    let anchor = arb_math::sqrt_q64(NORMALIZED_9_6_Q64).unwrap();
    let mut h = harness(9, 6, NORMALIZED_9_6_Q64);
    // Move the clock far past publish_time + max_staleness (30s).
    let mut clock = h.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = 10_000;
    h.svm.set_sysvar(&clock);
    let (bm, qm) = (h.base_mint, h.quote_mint);
    let stale = send_update(&mut h, &quote_update(anchor, 1), bm, qm);
    assert_anchor_error(stale, "InvalidOracle");
}
