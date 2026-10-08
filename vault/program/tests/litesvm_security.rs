//! Adversarial / access-control tests for the program (P2 security pass).
//!
//! Each test takes an attacker's point of view and asserts the program rejects
//! or contains the action. The lifecycle suite covers the money-path invariants;
//! this file covers the bootstrap and authority gates.

mod common;

use arbswap::InitParams;
use common::*;
use litesvm::LiteSVM;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;

const SLOT: u64 = 5;
const FEED_ID: [u8; 32] = [7u8; 32];

fn params(base_mint: Address, quote_mint: Address, admin: &Keypair) -> InitParams {
    InitParams {
        base_mint: pubkey(base_mint),
        quote_mint: pubkey(quote_mint),
        keeper: admin.pubkey(),
        treasury: admin.pubkey(),
        pyth_feed_id: FEED_ID,
        fee_bps: 100,
        insurance_bps: 3_333,
        keeper_bps: 3_333,
        protocol_bps: 3_334,
        min_liquidity: 1,
        warmup_slots: 1,
        epoch_slots: 10,
        grace_slots: 1,
        expiry_slots: 10,
        max_staleness_seconds: 30,
        max_conf_bps: 10,
        max_anchor_step_bps: 100,
        max_spread_bps: 50,
        max_quote_size: 1_000_000,
        max_inventory_bps: 2_000,
        min_bond: 0,
        max_anchor_dev_bps: 500,
        offsets_bps: OFFSETS,
        weights_bps: WEIGHTS,
    }
}

/// A fresh SVM with the program deployed and the program admin already claimed
/// by `admin`.
fn bootstrapped() -> (LiteSVM, Address, Keypair, Address, Address) {
    let admin = Keypair::new();
    let mut svm = LiteSVM::new();
    let program_id = load_arbswap(&mut svm);
    airdrop(&mut svm, &admin, 10_000_000_000);
    let mut clock = svm.get_sysvar::<Clock>();
    clock.slot = SLOT;
    clock.unix_timestamp = 1_000;
    svm.set_sysvar(&clock);

    let base_mint = Address::new_unique();
    let quote_mint = Address::new_unique();
    set_token_mint(&mut svm, base_mint, 9, admin.pubkey());
    set_token_mint(&mut svm, quote_mint, 6, admin.pubkey());

    let program_config = pda(&[b"program"], &program_id).0;
    let configure = ix(
        program_id,
        arbswap::instruction::InitializeProgram {},
        arbswap::accounts::InitializeProgram {
            admin: to_address(admin.pubkey()),
            program_config,
            system_program: anchor_lang::system_program::ID,
        },
    );
    send(&mut svm, &[&admin], configure).expect("initialize_program");
    (svm, program_id, admin, base_mint, quote_mint)
}

fn initialize_vault_ix(
    program_id: Address,
    admin: Address,
    base_mint: Address,
    quote_mint: Address,
    params: InitParams,
    reserves: &[&Keypair; 4],
) -> Instruction {
    let vault = pda(
        &[b"vault", base_mint.as_ref(), quote_mint.as_ref()],
        &program_id,
    )
    .0;
    let config = pda(&[b"config", vault.as_ref()], &program_id).0;
    let quote_state = pda(&[b"quote", vault.as_ref()], &program_id).0;
    let program_config = pda(&[b"program"], &program_id).0;
    ix(
        program_id,
        arbswap::instruction::InitializeVault { params },
        arbswap::accounts::InitializeVault {
            admin,
            program_config,
            vault,
            config,
            quote_state,
            base_mint,
            quote_mint,
            base_reserve: to_address(reserves[0].pubkey()),
            quote_reserve: to_address(reserves[1].pubkey()),
            share_mint: to_address(reserves[2].pubkey()),
            share_lock: to_address(reserves[3].pubkey()),
            token_program: token_program_id(),
            system_program: anchor_lang::system_program::ID,
            rent: rent_id(),
        },
    )
}

/// The real program admin can create the vault.
#[test]
fn only_the_program_admin_can_initialize_a_vault() {
    let (mut svm, program_id, admin, base_mint, quote_mint) = bootstrapped();
    let base_reserve = Keypair::new();
    let quote_reserve = Keypair::new();
    let share_mint_kp = Keypair::new();
    let share_lock_kp = Keypair::new();
    let reserves = [
        &base_reserve,
        &quote_reserve,
        &share_mint_kp,
        &share_lock_kp,
    ];
    let good = initialize_vault_ix(
        program_id,
        to_address(admin.pubkey()),
        base_mint,
        quote_mint,
        params(base_mint, quote_mint, &admin),
        &reserves,
    );
    let signers: [&Keypair; 5] = [
        &admin,
        &base_reserve,
        &quote_reserve,
        &share_mint_kp,
        &share_lock_kp,
    ];
    send(&mut svm, &signers, good).expect("admin may initialize the vault");
}

/// A non-admin calling `initialize_vault` is rejected, so the vault PDA cannot
/// be front-run for a mint pair.
#[test]
fn a_non_admin_cannot_initialize_a_vault() {
    let (mut svm, program_id, _admin, base_mint, quote_mint) = bootstrapped();
    let attacker = Keypair::new();
    airdrop(&mut svm, &attacker, 10_000_000_000);
    let base_reserve = Keypair::new();
    let quote_reserve = Keypair::new();
    let share_mint_kp = Keypair::new();
    let share_lock_kp = Keypair::new();
    let reserves = [
        &base_reserve,
        &quote_reserve,
        &share_mint_kp,
        &share_lock_kp,
    ];
    let hostile = initialize_vault_ix(
        program_id,
        to_address(attacker.pubkey()),
        base_mint,
        quote_mint,
        params(base_mint, quote_mint, &attacker),
        &reserves,
    );
    let signers: [&Keypair; 5] = [
        &attacker,
        &base_reserve,
        &quote_reserve,
        &share_mint_kp,
        &share_lock_kp,
    ];
    assert_anchor_error(send(&mut svm, &signers, hostile), "Unauthorized");
}
