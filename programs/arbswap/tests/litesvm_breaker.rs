use anchor_lang::{AccountSerialize, Discriminator};
use anchor_lang::prelude::Pubkey;
use arbswap::{Level, QuoteState, Vault};
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

fn address(key: Pubkey) -> Address { Address::from(key.to_bytes()) }

fn account_data<T: AccountSerialize + Discriminator>(value: &T) -> Vec<u8> {
    let mut data = T::DISCRIMINATOR.to_vec();
    value.try_serialize(&mut data).unwrap();
    data
}

fn instruction(name: &str, program_id: Address, vault: Address, quote: Address) -> Instruction {
    let mut hash = Sha256::new();
    hash.update(format!("global:{name}").as_bytes());
    Instruction {
        program_id,
        accounts: vec![AccountMeta::new(vault, false), AccountMeta::new_readonly(quote, false)],
        data: hash.finalize()[..8].to_vec(),
    }
}

#[test]
fn expired_quote_can_trip_breaker_and_live_quote_cannot() {
    let program_id = address(arbswap::ID);
    let mut svm = LiteSVM::new();
    let program = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/deploy/arbswap.so");
    svm.add_program(program_id, &std::fs::read(program).unwrap()).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&Address::from(payer.pubkey().to_bytes()), 2_000_000_000).unwrap();

    let base_mint = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let (vault_address, bump) = Address::find_program_address(&[b"vault", base_mint.as_ref(), quote_mint.as_ref()], &program_id);
    let (quote_address, quote_bump) = Address::find_program_address(&[b"quote", vault_address.as_ref()], &program_id);
    let vault = Vault { admin: Pubkey::new_unique(), base_mint, quote_mint, base_reserve: Pubkey::new_unique(), quote_reserve: Pubkey::new_unique(), share_mint: Pubkey::new_unique(), share_lock: Pubkey::new_unique(), total_shares: 1, insurance_base: 0, insurance_quote: 0, keeper_base: 0, keeper_quote: 0, protocol_base: 0, protocol_quote: 0, epoch: 0, epoch_start: 0, status: 0, bump };
    let expired = QuoteState { version: 1, update_slot: 1, expiry_slot: 0, anchor_sqrt_price: 1, p_res_sqrt: 1, half_spread_bps: 1, ask_extra_bps: 0, bid_extra_bps: 0, depth_mult_bps: 10_000, flow_n: 0, oracle_publish_time: 0, oracle_conf_bps: 1, levels: [Level { offset_bps: 1, weight_bps: 10_000, sqrt_lo: 1, sqrt_hi: 2, liquidity: 1 }; 6], bump: quote_bump };
    svm.set_account(vault_address, Account { lamports: 1_000_000, data: account_data(&vault), owner: program_id, ..Account::default() }).unwrap();
    svm.set_account(quote_address, Account { lamports: 1_000_000, data: account_data(&expired), owner: program_id, ..Account::default() }).unwrap();
    let payer_address = Address::from(payer.pubkey().to_bytes());
    let tx = Transaction::new(&[&payer], Message::new(&[instruction("trip_breaker", program_id, vault_address, quote_address)], Some(&payer_address)), svm.latest_blockhash());
    let metadata = svm.send_transaction(tx).unwrap();
    println!("p2_trip_breaker_compute_units={}", metadata.compute_units_consumed);
    assert_eq!(svm.get_account(&vault_address).unwrap().data[8 + 32 * 7 + 8 * 9], 1);
}
