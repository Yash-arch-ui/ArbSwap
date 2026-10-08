use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountSerialize, AnchorSerialize};
use arbswap::{Config, Level, LevelUpdate, QuoteState, QuoteUpdate, Vault};
use litesvm::LiteSVM;

mod common;
use common::{anchor_ladder, pda, ANCHOR_SQRT};
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

fn account_data<T: AccountSerialize>(value: &T) -> Vec<u8> {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    data
}

fn instruction(name: &str, program_id: Address, vault: Address, quote: Address) -> Instruction {
    let mut hash = Sha256::new();
    hash.update(format!("global:{name}").as_bytes());
    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(quote, false),
        ],
        data: hash.finalize()[..8].to_vec(),
    }
}

#[test]
fn expired_quote_can_trip_breaker_and_live_quote_cannot() {
    let program_id = address(arbswap::ID);
    let mut svm = LiteSVM::new();
    let program =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/arbswap.so");
    svm.add_program(program_id, &std::fs::read(program).unwrap())
        .unwrap();
    let payer = Keypair::new();
    svm.airdrop(&Address::from(payer.pubkey().to_bytes()), 2_000_000_000)
        .unwrap();

    let base_mint = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let (vault_address, bump) = Address::find_program_address(
        &[b"vault", base_mint.as_ref(), quote_mint.as_ref()],
        &program_id,
    );
    let (quote_address, quote_bump) =
        Address::find_program_address(&[b"quote", vault_address.as_ref()], &program_id);
    let vault = Vault {
        admin: Pubkey::new_unique(),
        base_mint,
        quote_mint,
        base_reserve: Pubkey::new_unique(),
        quote_reserve: Pubkey::new_unique(),
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
        bump,
    };
    let expired = QuoteState {
        version: 1,
        update_slot: 1,
        expiry_slot: 0,
        anchor_sqrt_price: 1,
        p_res_sqrt: 1,
        half_spread_bps: 1,
        ask_extra_bps: 0,
        bid_extra_bps: 0,
        depth_mult_bps: 10_000,
        flow_n: 0,
        window_start_slot: 0,
        window_base_sold: 0,
        window_base_bought: 0,
        oracle_publish_time: 0,
        oracle_conf_bps: 1,
        levels: [Level {
            offset_bps: 1,
            weight_bps: 10_000,
            sqrt_lo: 1,
            sqrt_hi: 2,
            liquidity: 1,
        }; 6],
        bump: quote_bump,
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
        quote_address,
        Account {
            lamports: 1_000_000,
            data: account_data(&expired),
            owner: program_id,
            ..Account::default()
        },
    )
    .unwrap();
    let payer_address = Address::from(payer.pubkey().to_bytes());
    let tx = Transaction::new(
        &[&payer],
        Message::new(
            &[instruction(
                "trip_breaker",
                program_id,
                vault_address,
                quote_address,
            )],
            Some(&payer_address),
        ),
        svm.latest_blockhash(),
    );
    let metadata = svm.send_transaction(tx).unwrap();
    println!(
        "p2_trip_breaker_compute_units={}",
        metadata.compute_units_consumed
    );
    assert_eq!(
        svm.get_account(&vault_address).unwrap().data[8 + 32 * 7 + 8 * 9],
        1
    );
}

#[test]
fn update_quote_executes_only_with_full_pyth_account() {
    let program_id = address(arbswap::ID);
    let mut svm = LiteSVM::new();
    let program =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/arbswap.so");
    svm.add_program(program_id, &std::fs::read(program).unwrap())
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
    let vault = Vault {
        admin: Pubkey::new_unique(),
        base_mint,
        quote_mint,
        base_reserve: Pubkey::new_unique(),
        quote_reserve: Pubkey::new_unique(),
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
        max_spread_bps: 50,
        max_quote_size: 1_000_000,
        max_inventory_bps: 10_000,
        min_bond: 0,
        max_anchor_dev_bps: 100,
        flow_window_slots: 100,
        max_window_flow_bps: 10_000,
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
        flow_n: 0,
        window_start_slot: 0,
        window_base_sold: 0,
        window_base_bought: 0,
        oracle_publish_time: 0,
        oracle_conf_bps: 0,
        levels: [Level::default(); 6],
        bump: quote_bump,
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
    let levels = anchor_ladder(ANCHOR_SQRT, 1, [1, 2, 3, 4, 5, 6]);
    let update = QuoteUpdate {
        update_slot: 1,
        oracle_publish_time: 1_000,
        oracle_price: 150u128 << 64,
        oracle_conf_bps: 1,
        anchor_sqrt_price: ANCHOR_SQRT,
        p_res_sqrt: ANCHOR_SQRT,
        half_spread_bps: 1,
        ask_extra_bps: 0,
        bid_extra_bps: 0,
        depth_mult_bps: 10_000,
        offsets_bps: [1, 2, 3, 4, 5, 6],
        weights_bps: [1_000, 1_500, 2_000, 2_000, 2_000, 1_500],
        levels,
    };
    let mut hash = Sha256::new();
    hash.update(b"global:update_quote");
    let mut data = hash.finalize()[..8].to_vec();
    update.serialize(&mut data).unwrap();
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new_readonly(payer_address, true),
            AccountMeta::new(vault_address, false),
            AccountMeta::new_readonly(config_address, false),
            AccountMeta::new(quote_address, false),
            AccountMeta::new_readonly(pyth_address, false),
            AccountMeta::new_readonly(
                pda(
                    &[b"keeper", vault_address.as_ref(), payer_address.as_ref()],
                    &program_id,
                )
                .0,
                false,
            ),
        ],
        data,
    };
    let tx = Transaction::new(
        &[&payer],
        Message::new(&[ix], Some(&payer_address)),
        svm.latest_blockhash(),
    );
    let meta = svm.send_transaction(tx).unwrap();
    println!(
        "p2_update_quote_compute_units={}",
        meta.compute_units_consumed
    );
    assert!(meta.compute_units_consumed > 0);
}
