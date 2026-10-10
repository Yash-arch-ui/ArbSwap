//! Shared LiteSVM fixtures for the ArbSwap integration tests.
#![allow(dead_code)]

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token::state::{Account as StateAccount, AccountState, Mint};
use arbswap::LevelUpdate;
use litesvm::LiteSVM;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};
use pythnet_sdk::messages::PriceFeedMessage;
use solana_account::Account;
use solana_address::{address, Address};
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub const OFFSETS: [u32; 6] = [2, 5, 10, 20, 40, 80];
pub const WEIGHTS: [u32; 6] = [1000, 1500, 2000, 2000, 2000, 1500];
/// `sqrt(150) * 2^64`, the anchor for a 150 USDC vault.
pub const ANCHOR_SQRT: u128 = 225_887_000_000_000_000_000;

/// An oracle-consistent ask ladder for the F-04 anchor binding: level `k`
/// spans `anchor*(1 + spread + offset_{k-1})` to `anchor*(1 + spread + offset_k)`.
///
/// Liquidity is derived from a total base-capacity budget distributed by
/// [`WEIGHTS`], so the ladder satisfies the p2-T3 utilization bound when
/// `total_base_capacity <= u_max * available_base`.
pub fn anchor_ladder(
    anchor_sqrt: u128,
    spread_bps: u32,
    offsets: [u32; 6],
    total_base_capacity: u128,
) -> [LevelUpdate; 6] {
    let anchor_price = arb_math::price_from_sqrt(anchor_sqrt).expect("anchor price");
    let mut levels = [LevelUpdate::default(); 6];
    let mut previous = 0u32;
    for (index, level) in levels.iter_mut().enumerate() {
        let lo_price = arb_math::mul_div_floor(
            anchor_price,
            (10_000 + spread_bps + previous) as u128,
            10_000,
        )
        .expect("lo price");
        let hi_price = arb_math::mul_div_floor(
            anchor_price,
            (10_000 + spread_bps + offsets[index]) as u128,
            10_000,
        )
        .expect("hi price");
        level.sqrt_lo = arb_math::sqrt_q64(lo_price).expect("sqrt_lo");
        level.sqrt_hi = arb_math::sqrt_q64(hi_price).expect("sqrt_hi");
        let capacity = total_base_capacity * WEIGHTS[index] as u128 / 10_000;
        level.liquidity =
            arb_math::Level::liquidity_for_base_capacity(level.sqrt_lo, level.sqrt_hi, capacity)
                .expect("liquidity");
        previous = offsets[index];
    }
    levels
}
/// A mirror-image **bid** ladder below the anchor, sized from a total quote
/// capacity budget. Mirrors the keeper's bid construction (h1).
pub fn anchor_bid_ladder(
    anchor_sqrt: u128,
    spread_bps: u32,
    offsets: [u32; 6],
    total_quote_capacity: u128,
) -> [LevelUpdate; 6] {
    let anchor_price = arb_math::price_from_sqrt(anchor_sqrt).expect("anchor price");
    let mut levels = [LevelUpdate::default(); 6];
    let mut previous = 0u32;
    for (index, level) in levels.iter_mut().enumerate() {
        let hi_price = arb_math::mul_div_floor(
            anchor_price,
            (10_000 - spread_bps - previous) as u128,
            10_000,
        )
        .expect("hi price");
        let lo_price = arb_math::mul_div_floor(
            anchor_price,
            (10_000 - spread_bps - offsets[index]) as u128,
            10_000,
        )
        .expect("lo price");
        level.sqrt_lo = arb_math::sqrt_q64(lo_price).expect("sqrt_lo");
        level.sqrt_hi = arb_math::sqrt_q64(hi_price).expect("sqrt_hi");
        let capacity = total_quote_capacity * WEIGHTS[index] as u128 / 10_000;
        level.liquidity =
            arb_math::Level::liquidity_for_quote_capacity(level.sqrt_lo, level.sqrt_hi, capacity)
                .expect("liquidity");
        previous = offsets[index];
    }
    levels
}

pub const FEED_ID: [u8; 32] = [7u8; 32];
/// 150.0 with exponent -8.
pub const PYTH_PRICE: i64 = 15_000_000_000;
pub const PYTH_EXPONENT: i32 = -8;
pub const PUBLISH_TIME: i64 = 1_000;
/// `pyth_price_q64(PYTH_PRICE, PYTH_EXPONENT)`.
pub const PRICE_Q64: u128 = 150u128 << 64;
/// `ceil(conf * 10_000 / price)` for `conf = 1`.
pub const CONF_BPS: u32 = 1;

pub fn to_address(key: Pubkey) -> Address {
    Address::from(key.to_bytes())
}

pub fn pubkey(key: Address) -> Pubkey {
    Pubkey::new_from_array(key.to_bytes())
}

pub fn rent_id() -> Pubkey {
    pubkey(address!("SysvarRent111111111111111111111111111111111"))
}

pub fn token_program_id() -> Pubkey {
    anchor_spl::token::ID
}

/// Token-2022 program. The classic `Program<Token>` constraint must reject it.
pub fn token_2022_program_id() -> Address {
    address!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
}

pub fn account_data<T: AccountSerialize>(value: &T) -> Vec<u8> {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    data
}

pub fn pda(seeds: &[&[u8]], program: &Address) -> (Address, u8) {
    Address::find_program_address(seeds, program)
}

pub fn load_arbswap(svm: &mut LiteSVM) -> Address {
    let program_id = to_address(arbswap::ID);
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/arbswap.so");
    svm.add_program(program_id, &std::fs::read(path).unwrap())
        .unwrap();
    program_id
}

pub fn airdrop(svm: &mut LiteSVM, key: &Keypair, lamports: u64) {
    svm.airdrop(&to_address(key.pubkey()), lamports).unwrap();
}

/// `signers[0]` is the fee payer; every other entry must be a non-fee-payer
/// signer the instruction requires (Anchor marks freshly `init`-created
/// accounts as signers even when they are not PDAs).
pub fn send(
    svm: &mut LiteSVM,
    signers: &[&Keypair],
    instruction: Instruction,
) -> litesvm::types::TransactionResult {
    svm.expire_blockhash();
    let payer_address = to_address(signers[0].pubkey());
    let tx = Transaction::new(
        signers,
        Message::new(&[instruction], Some(&payer_address)),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx)
}

/// Anchor program errors surface in the logs; assert on the symbolic name so
/// the test does not hard-code a 6000-range numeric code.
pub fn assert_anchor_error(result: litesvm::types::TransactionResult, error_name: &str) {
    let failure = result.expect_err(&format!("expected anchor error `{error_name}`"));
    let expected = format!("Error Code: {error_name}");
    assert!(
        failure
            .meta
            .logs
            .iter()
            .any(|line| line.contains(&expected)),
        "expected `{expected}` in logs:\n{}",
        failure.meta.logs.join("\n")
    );
}

/// Assert the transaction failed *on the named account* (Anchor logs
/// `AnchorError caused by account: <name>.`). Used by the substitution
/// negatives so the test proves the intended binding rejected it, not an
/// unrelated earlier account.
pub fn assert_account_rejected(result: litesvm::types::TransactionResult, account: &str) {
    let failure = result.expect_err(&format!("expected rejection on account `{account}`"));
    let expected = format!("AnchorError caused by account: {account}.");
    assert!(
        failure
            .meta
            .logs
            .iter()
            .any(|line| line.contains(&expected)),
        "expected `{expected}` in logs:\n{}",
        failure.meta.logs.join("\n")
    );
}

pub fn pyth_account(
    feed_id: [u8; 32],
    price: i64,
    conf: u64,
    exponent: i32,
    publish_time: i64,
    verification: VerificationLevel,
) -> PriceUpdateV2 {
    PriceUpdateV2 {
        write_authority: Pubkey::new_unique(),
        verification_level: verification,
        price_message: PriceFeedMessage {
            feed_id,
            price,
            conf,
            exponent,
            ema_price: price,
            ema_conf: conf,
            publish_time,
            prev_publish_time: publish_time,
        },
        posted_slot: 1,
    }
}

fn set_token_account_data(svm: &mut LiteSVM, key: Address, data: Vec<u8>) {
    svm.set_account(
        key,
        Account {
            lamports: 1_000_000_000,
            data,
            owner: to_address(anchor_spl::token::ID),
            ..Account::default()
        },
    )
    .unwrap();
}

pub fn set_token_mint(svm: &mut LiteSVM, key: Address, decimals: u8, authority: Pubkey) {
    let mint = Mint {
        mint_authority: COption::Some(authority),
        supply: 0,
        decimals,
        is_initialized: true,
        freeze_authority: COption::None,
    };
    let mut data = vec![0u8; Mint::LEN];
    Mint::pack(mint, &mut data).unwrap();
    set_token_account_data(svm, key, data);
}

pub fn set_token_account(
    svm: &mut LiteSVM,
    key: Address,
    mint: Address,
    owner: Pubkey,
    amount: u64,
) {
    let token = StateAccount {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut data = vec![0u8; StateAccount::LEN];
    StateAccount::pack(token, &mut data).unwrap();
    set_token_account_data(svm, key, data);
}

/// Same bytes as `set_token_account`, but the account is owned by an arbitrary
/// program so the classic `Program<Token>` constraint rejects it.
pub fn set_foreign_token_account(
    svm: &mut LiteSVM,
    key: Address,
    mint: Address,
    owner: Pubkey,
    amount: u64,
    account_owner: Address,
) {
    let token = StateAccount {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut data = vec![0u8; StateAccount::LEN];
    StateAccount::pack(token, &mut data).unwrap();
    svm.set_account(
        key,
        Account {
            lamports: 1_000_000_000,
            data,
            owner: account_owner,
            ..Account::default()
        },
    )
    .unwrap();
}

pub fn token_amount(svm: &LiteSVM, key: Address) -> u64 {
    let account = svm.get_account(&key).expect("token account missing");
    StateAccount::unpack(&account.data).unwrap().amount
}

pub fn read_state<T: anchor_lang::AccountDeserialize>(svm: &LiteSVM, key: Address) -> T {
    let account = svm.get_account(&key).expect("account missing");
    let mut slice: &[u8] = &account.data;
    T::try_deserialize(&mut slice).unwrap()
}

/// Build an instruction from Anchor-generated client structs so account order
/// stays in lock-step with the program definition.
pub fn ix<A, M>(program_id: Address, args: A, metas: M) -> Instruction
where
    A: InstructionData,
    M: ToAccountMetas,
{
    Instruction {
        program_id,
        accounts: metas.to_account_metas(None),
        data: args.data(),
    }
}
