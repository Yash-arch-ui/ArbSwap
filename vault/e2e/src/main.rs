//! ArbSwap devnet end-to-end client (P2 gate).
//!
//! `setup <rpc_url> <payer_keypair> <pyth_feed_id_hex>`:
//!   create 9-dp base + 6-dp quote mints, LP token accounts, mint balances,
//!   and `initialize_vault`.
//! `loop <rpc_url> <payer_keypair> <pyth_feed_id_hex>`:
//!   deposit -> update_quote (with a real Pyth `PriceUpdateV2`) -> swap both
//!   ways -> request_withdraw -> crank_epoch -> claim_withdraw.
//!
//! No keys are embedded; the payer keypair is read from a path outside the repo.

use anchor_lang::{InstructionData, ToAccountMetas};
use base64::Engine;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const SYSTEM_ID: &str = "11111111111111111111111111111111";
const TOKEN_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const RENT_ID: &str = "SysvarRent111111111111111111111111111111111";
const BASE_DECIMALS: u8 = 9;
const QUOTE_DECIMALS: u8 = 6;

fn rpc(rpc_url: &str, method: &str, params: serde_json::Value) -> Option<serde_json::Value> {
    let body = serde_json::json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
    let text = ureq::post(rpc_url)
        .send_json(body)
        .ok()?
        .into_string()
        .ok()?;
    serde_json::from_str(&text).ok()
}

fn blockhash(rpc_url: &str) -> solana_hash::Hash {
    let v = rpc(rpc_url, "getLatestBlockhash", serde_json::json!([])).expect("blockhash");
    let s = v["result"]["value"]["blockhash"].as_str().expect("bh");
    let bytes = bs58::decode(s).into_vec().unwrap();
    solana_hash::Hash::new_from_array(bytes.try_into().unwrap())
}

fn rent_exempt(rpc_url: &str, space: u64) -> u64 {
    rpc(
        rpc_url,
        "getMinimumBalanceForRentExemption",
        serde_json::json!([space]),
    )
    .and_then(|v| v["result"].as_u64())
    .expect("rent")
}

fn send(
    rpc_url: &str,
    payer: &Keypair,
    signers: &[&Keypair],
    instructions: Vec<Instruction>,
) -> String {
    let bh = blockhash(rpc_url);
    let msg = Message::new(&instructions, Some(&payer.pubkey()));
    let tx = Transaction::new(signers, msg, bh);
    let bytes = wincode::serialize(&tx).unwrap();
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let v = rpc(
        rpc_url,
        "sendTransaction",
        serde_json::json!([encoded, {"encoding":"base64","skipPreflight":false}]),
    )
    .expect("send");
    if let Some(err) = v.get("error") {
        panic!("sendTransaction failed: {err}");
    }
    let sig = v["result"].as_str().unwrap().to_string();
    // Confirm.
    for _ in 0..40 {
        let s = rpc(
            rpc_url,
            "getSignatureStatuses",
            serde_json::json!([[sig], {"searchTransactionHistory": true}]),
        );
        let st = &s.as_ref().unwrap()["result"]["value"][0];
        if !st.is_null() {
            if !st["err"].is_null() {
                panic!("tx {sig} failed: {}", st["err"]);
            }
            if st["confirmationStatus"].as_str() == Some("confirmed")
                || st["confirmationStatus"].as_str() == Some("finalized")
            {
                return sig;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    sig
}

fn ix<A: InstructionData, M: ToAccountMetas>(program: Address, args: A, metas: M) -> Instruction {
    Instruction {
        program_id: program,
        accounts: metas.to_account_metas(None),
        data: args.data(),
    }
}

fn create_account(
    payer: &Keypair,
    new: &Keypair,
    lamports: u64,
    space: u64,
    owner: Address,
) -> Instruction {
    solana_system_interface::instruction::create_account(
        &payer.pubkey(),
        &new.pubkey(),
        lamports,
        space,
        &owner,
    )
}

fn pda(seeds: &[&[u8]], program: &Address) -> Address {
    Address::find_program_address(seeds, program).0
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let phase = args.first().map(String::as_str).unwrap_or("setup");
    let rpc_url = &args[1];
    let payer = read_keypair(&args[2]);
    let feed_hex = args[3].trim_start_matches("0x");
    let feed: [u8; 32] = hex32(feed_hex);

    let program_id: Address = arbswap::ID.to_string().parse().unwrap();
    let token: Address = TOKEN_ID.parse().unwrap();
    let system: Address = SYSTEM_ID.parse().unwrap();
    let rent: Address = RENT_ID.parse().unwrap();

    println!("program={program_id}");
    match phase {
        "setup" => setup(rpc_url, &payer, program_id, token, system, rent, feed),
        "loop" => e2e(rpc_url, &payer, program_id, token, system, feed),
        other => panic!("unknown phase {other}"),
    }
}

fn read_keypair(path: &str) -> Keypair {
    let text = std::fs::read_to_string(path).expect("keypair");
    let bytes: Vec<u8> = serde_json::from_str(&text).expect("json");
    Keypair::new_from_array(bytes[..32].try_into().unwrap())
}

fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).expect("hex");
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn setup(
    rpc_url: &str,
    payer: &Keypair,
    program_id: Address,
    token: Address,
    system: Address,
    rent: Address,
    feed: [u8; 32],
) {
    // Deterministic-ish new keypairs; addresses printed for reuse.
    let base_mint = Keypair::new();
    let quote_mint = Keypair::new();
    let base_reserve = Keypair::new();
    let quote_reserve = Keypair::new();
    let share_mint = Keypair::new();
    let share_lock = Keypair::new();
    let lp_base = Keypair::new();
    let lp_quote = Keypair::new();

    let mint_rent = rent_exempt(rpc_url, 82);
    let acct_rent = rent_exempt(rpc_url, 165);

    // --- create mints ---
    let ixs = vec![
        create_account(payer, &base_mint, mint_rent, 82, token),
        create_account(payer, &quote_mint, mint_rent, 82, token),
        spl_token_interface::instruction::initialize_mint2(
            &token,
            &base_mint.pubkey(),
            &payer.pubkey(),
            None,
            BASE_DECIMALS,
        )
        .unwrap(),
        spl_token_interface::instruction::initialize_mint2(
            &token,
            &quote_mint.pubkey(),
            &payer.pubkey(),
            None,
            QUOTE_DECIMALS,
        )
        .unwrap(),
        // --- LP token accounts ---
        create_account(payer, &lp_base, acct_rent, 165, token),
        create_account(payer, &lp_quote, acct_rent, 165, token),
        spl_token_interface::instruction::initialize_account3(
            &token,
            &lp_base.pubkey(),
            &base_mint.pubkey(),
            &payer.pubkey(),
        )
        .unwrap(),
        spl_token_interface::instruction::initialize_account3(
            &token,
            &lp_quote.pubkey(),
            &quote_mint.pubkey(),
            &payer.pubkey(),
        )
        .unwrap(),
        spl_token_interface::instruction::mint_to(
            &token,
            &base_mint.pubkey(),
            &lp_base.pubkey(),
            &payer.pubkey(),
            &[],
            1_000_000_000_000_000,
        )
        .unwrap(),
        spl_token_interface::instruction::mint_to(
            &token,
            &quote_mint.pubkey(),
            &lp_quote.pubkey(),
            &payer.pubkey(),
            &[],
            1_000_000_000_000_000,
        )
        .unwrap(),
    ];
    let sig = send(
        rpc_url,
        payer,
        &[payer, &base_mint, &quote_mint, &lp_base, &lp_quote],
        ixs,
    );
    println!("mints+accounts sig={sig}");
    println!("base_mint={}", base_mint.pubkey());
    println!("quote_mint={}", quote_mint.pubkey());
    println!("lp_base={}", lp_base.pubkey());
    println!("lp_quote={}", lp_quote.pubkey());

    // --- initialize_vault ---
    let vault = pda(
        &[
            b"vault",
            base_mint.pubkey().as_ref(),
            quote_mint.pubkey().as_ref(),
        ],
        &program_id,
    );
    let config = pda(&[b"config", vault.as_ref()], &program_id);
    let quote_state = pda(&[b"quote", vault.as_ref()], &program_id);
    let program_config = pda(&[b"program"], &program_id);
    let params = arbswap::InitParams {
        base_mint: base_mint.pubkey(),
        quote_mint: quote_mint.pubkey(),
        keeper: payer.pubkey(),
        treasury: payer.pubkey(),
        pyth_feed_id: feed,
        fee_bps: 100,
        insurance_bps: 3_333,
        keeper_bps: 3_333,
        protocol_bps: 3_334,
        min_liquidity: 1,
        warmup_slots: 1,
        epoch_slots: 10,
        grace_slots: 1,
        expiry_slots: 25,
        max_staleness_seconds: 60,
        max_conf_bps: 50,
        max_anchor_step_bps: 100,
        min_spread_bps: 2,
        max_spread_bps: 50,
        max_quote_size: 1_000_000_000,
        max_inventory_bps: 2_000,
        utilization_max_bps: 5_000,
        min_bond: 0,
        unbond_cooldown_slots: 216_000,
        max_update_slot_age: 100,
        edge_window_slots: 9_000,
        max_edge_loss_bps: 50,
        max_anchor_dev_bps: 100,
        flow_window_slots: 1_000,
        max_window_flow_bps: 5_000,
        offsets_bps: [2, 5, 10, 20, 40, 80],
        weights_bps: [1_000, 1_500, 2_000, 2_000, 2_000, 1_500],
    };
    let ix = ix(
        program_id,
        arbswap::instruction::InitializeVault { params },
        arbswap::accounts::InitializeVault {
            admin: payer.pubkey(),
            program_config,
            vault,
            config,
            quote_state,
            base_mint: base_mint.pubkey(),
            quote_mint: quote_mint.pubkey(),
            base_reserve: base_reserve.pubkey(),
            quote_reserve: quote_reserve.pubkey(),
            share_mint: share_mint.pubkey(),
            share_lock: share_lock.pubkey(),
            token_program: token,
            system_program: system,
            rent,
        },
    );
    let sig = send(
        rpc_url,
        payer,
        &[
            payer,
            &base_reserve,
            &quote_reserve,
            &share_mint,
            &share_lock,
        ],
        vec![ix],
    );
    println!("initialize_vault sig={sig}");
    println!("vault={vault}");
    println!("config={config}");
    println!("quote_state={quote_state}");
    println!("base_reserve={}", base_reserve.pubkey());
    println!("quote_reserve={}", quote_reserve.pubkey());
    println!("share_mint={}", share_mint.pubkey());
    println!("share_lock={}", share_lock.pubkey());
}

fn e2e(
    _rpc_url: &str,
    _payer: &Keypair,
    _program_id: Address,
    _token: Address,
    _system: Address,
    _feed: [u8; 32],
) {
    eprintln!("loop: not implemented yet (deposit/quote/swap/withdraw)");
}
