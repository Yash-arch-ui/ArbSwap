//! ArbSwap devnet end-to-end client (P2 gate).
//!
//! `setup <rpc> <payer> <feed_hex> <state_json>`: mints + LP accounts + vault.
//! `loop <rpc> <payer> <state_json> <pyth_json>`: deposit -> update_quote ->
//!   swap both ways -> request_withdraw -> crank_epoch -> claim_withdraw.
//!
//! No keys are embedded; the payer keypair path is outside the repo.

use anchor_lang::{InstructionData, ToAccountMetas};
use base64::Engine;
use serde::{Deserialize, Serialize};
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

#[derive(Serialize, Deserialize, Clone)]
struct State {
    base_mint: String,
    quote_mint: String,
    lp_base: String,
    lp_quote: String,
    lp_shares: String,
    vault: String,
    config: String,
    quote_state: String,
    base_reserve: String,
    quote_reserve: String,
    share_mint: String,
    share_lock: String,
    base_reserve_kp: String,
    quote_reserve_kp: String,
    share_mint_kp: String,
    share_lock_kp: String,
}

fn addr(s: &str) -> Address {
    s.parse().expect("address")
}

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
    solana_hash::Hash::new_from_array(bs58::decode(s).into_vec().unwrap().try_into().unwrap())
}

fn slot(rpc_url: &str) -> u64 {
    rpc(rpc_url, "getSlot", serde_json::json!([]))
        .and_then(|v| v["result"].as_u64())
        .unwrap_or(0)
}

fn token_amount(rpc_url: &str, account: &Address) -> u64 {
    rpc(
        rpc_url,
        "getTokenAccountBalance",
        serde_json::json!([account.to_string()]),
    )
    .and_then(|v| {
        v["result"]["value"]["amount"]
            .as_str()
            .map(|s| s.parse().ok())
    })
    .flatten()
    .unwrap_or(0)
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
    let tx = Transaction::new(
        signers,
        Message::new(&instructions, Some(&payer.pubkey())),
        bh,
    );
    let encoded =
        base64::engine::general_purpose::STANDARD.encode(wincode::serialize(&tx).unwrap());
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
    for _ in 0..60 {
        let s = rpc(
            rpc_url,
            "getSignatureStatuses",
            serde_json::json!([[sig], {"searchTransactionHistory": true}]),
        );
        let st = &s.unwrap()["result"]["value"][0];
        if !st.is_null() {
            if !st["err"].is_null() {
                panic!("tx {sig} failed: {}", st["err"]);
            }
            if matches!(
                st["confirmationStatus"].as_str(),
                Some("confirmed") | Some("finalized")
            ) {
                return sig;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
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

fn read_keypair(path: &str) -> Keypair {
    let text = std::fs::read_to_string(path).expect("keypair");
    let bytes: Vec<u8> = serde_json::from_str(&text).expect("json");
    Keypair::new_from_array(bytes[..32].try_into().unwrap())
}

fn hex32(s: &str) -> [u8; 32] {
    let s = s.trim_start_matches("0x");
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).expect("hex");
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let phase = args.first().cloned().unwrap_or_default();
    let rpc_url = args.get(1).cloned().unwrap_or_default();
    let payer = read_keypair(&args[2]);
    let program_id: Address = arbswap::ID.to_string().parse().unwrap();
    let token: Address = TOKEN_ID.parse().unwrap();
    let system: Address = SYSTEM_ID.parse().unwrap();
    let rent: Address = RENT_ID.parse().unwrap();

    match phase.as_str() {
        "setup" => setup(
            &rpc_url,
            &payer,
            program_id,
            token,
            system,
            rent,
            hex32(&args[3]),
            &args[4],
        ),
        "loop" => run_loop(
            &rpc_url, &payer, program_id, token, system, &args[3], &args[4],
        ),
        other => panic!("unknown phase {other}"),
    }
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
    state_path: &str,
) {
    let base_mint = Keypair::new();
    let quote_mint = Keypair::new();
    let base_reserve = Keypair::new();
    let quote_reserve = Keypair::new();
    let share_mint = Keypair::new();
    let share_lock = Keypair::new();
    let lp_base = Keypair::new();
    let lp_quote = Keypair::new();
    let lp_shares = Keypair::new();

    let mint_rent = rent_exempt(rpc_url, 82);
    let acct_rent = rent_exempt(rpc_url, 165);

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
        expiry_slots: 1000,
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
    let init = ix(
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
        vec![init],
    );
    println!("initialize_vault sig={sig}");

    let make_shares = create_account(payer, &lp_shares, acct_rent, 165, token);
    let init_shares = spl_token_interface::instruction::initialize_account3(
        &token,
        &lp_shares.pubkey(),
        &share_mint.pubkey(),
        &payer.pubkey(),
    )
    .unwrap();
    let sig = send(
        rpc_url,
        payer,
        &[payer, &lp_shares],
        vec![make_shares, init_shares],
    );
    println!("lp_shares sig={sig}");

    let state = State {
        base_mint: base_mint.pubkey().to_string(),
        quote_mint: quote_mint.pubkey().to_string(),
        lp_base: lp_base.pubkey().to_string(),
        lp_quote: lp_quote.pubkey().to_string(),
        lp_shares: lp_shares.pubkey().to_string(),
        vault: vault.to_string(),
        config: config.to_string(),
        quote_state: quote_state.to_string(),
        base_reserve: base_reserve.pubkey().to_string(),
        quote_reserve: quote_reserve.pubkey().to_string(),
        share_mint: share_mint.pubkey().to_string(),
        share_lock: share_lock.pubkey().to_string(),
        base_reserve_kp: kp_path("base_reserve"),
        quote_reserve_kp: kp_path("quote_reserve"),
        share_mint_kp: kp_path("share_mint"),
        share_lock_kp: kp_path("share_lock"),
    };
    std::fs::write(state_path, serde_json::to_string_pretty(&state).unwrap()).expect("write state");
    println!("state written to {state_path}");
    println!("vault={vault}");
    println!("base_reserve={}", base_reserve.pubkey());
    println!("quote_reserve={}", quote_reserve.pubkey());
    println!("share_mint={}", share_mint.pubkey());
    println!("share_lock={}", share_lock.pubkey());
}

// The reserve/mint keypairs are only needed at init; we do not persist secrets.
fn kp_path(_name: &str) -> String {
    String::new()
}

#[derive(Deserialize)]
struct PythInfo {
    price_update: String,
    price_q64: String,
    conf_bps: u32,
    publish_time: i64,
}

#[allow(clippy::too_many_arguments)]
fn run_loop(
    rpc_url: &str,
    payer: &Keypair,
    program_id: Address,
    token: Address,
    system: Address,
    state_path: &str,
    pyth_path: &str,
) {
    let state: State = serde_json::from_str(&std::fs::read_to_string(state_path).expect("state"))
        .expect("state json");
    let pyth: PythInfo = serde_json::from_str(&std::fs::read_to_string(pyth_path).expect("pyth"))
        .expect("pyth json");
    let (vault, config, quote_state) = (
        addr(&state.vault),
        addr(&state.config),
        addr(&state.quote_state),
    );
    let (base_reserve, quote_reserve) = (addr(&state.base_reserve), addr(&state.quote_reserve));
    let (share_mint, share_lock) = (addr(&state.share_mint), addr(&state.share_lock));
    let (lp_base, lp_quote, lp_shares) = (
        addr(&state.lp_base),
        addr(&state.lp_quote),
        addr(&state.lp_shares),
    );
    let price_update = addr(&pyth.price_update);
    let user = payer.pubkey();

    // --- deposit (proportional) ---
    let deposit_ticket = pda(&[b"dep", vault.as_ref(), user.as_ref()], &program_id);
    let deposit = ix(
        program_id,
        arbswap::instruction::Deposit {
            base_amount: 1_000_000_000,
            quote_amount: 110_000_000,
            min_shares: 1,
        },
        arbswap::accounts::Deposit {
            user,
            vault,
            config,
            base_reserve,
            quote_reserve,
            share_mint,
            share_lock,
            user_base: lp_base,
            user_quote: lp_quote,
            user_shares: lp_shares,
            deposit_ticket,
            token_program: token,
            system_program: system,
        },
    );
    let sig = send(rpc_url, payer, &[payer], vec![deposit]);
    println!("deposit sig={sig}");

    // --- update_quote (consume the Pyth PriceUpdateV2) ---
    let keeper = payer;
    let base_avail = token_amount(rpc_url, &base_reserve) as u128;
    let quote_avail = token_amount(rpc_url, &quote_reserve) as u128;
    let price_q64: u128 = pyth.price_q64.parse().expect("price_q64");
    let tick = arbswap_keeper::OracleTick {
        slot: slot(rpc_url),
        publish_time: pyth.publish_time,
        price_q64,
        confidence_bps: pyth.conf_bps,
    };
    let kparams = arbswap_keeper::KeeperParams {
        base_atom_scale: 10u128.pow((BASE_DECIMALS - QUOTE_DECIMALS) as u32),
        ..Default::default()
    };
    let q = arbswap_keeper::compute_quote(
        tick,
        arbswap_keeper::VolatilityState::default(),
        base_avail,
        quote_avail,
        0,
        0,
        kparams,
    )
    .expect("keeper quote");
    let to_lu = |l: &arb_math::Level| arbswap::LevelUpdate {
        sqrt_lo: l.sqrt_lo,
        sqrt_hi: l.sqrt_hi,
        liquidity: l.liquidity,
    };
    let mut ask_levels = [arbswap::LevelUpdate::default(); 6];
    let mut bid_levels = [arbswap::LevelUpdate::default(); 6];
    for i in 0..6 {
        ask_levels[i] = to_lu(&q.ask_levels[i]);
        bid_levels[i] = to_lu(&q.bid_levels[i]);
    }
    let update = arbswap::QuoteUpdate {
        update_slot: tick.slot,
        oracle_publish_time: q.publish_time,
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
    };
    let keeper_bond = pda(
        &[b"keeper", vault.as_ref(), keeper.pubkey().as_ref()],
        &program_id,
    );
    let uq = ix(
        program_id,
        arbswap::instruction::UpdateQuote { update },
        arbswap::accounts::UpdateQuote {
            keeper: keeper.pubkey(),
            vault,
            config,
            quote_state,
            price_update,
            keeper_bond,
            base_reserve,
            quote_reserve,
        },
    );
    let sig = send(rpc_url, payer, &[payer], vec![uq]);
    println!("update_quote sig={sig}");

    // --- swaps both directions (payer acts as trader) ---
    let buy = ix(
        program_id,
        arbswap::instruction::Swap {
            side: arbswap::SwapSide::BuyBase,
            amount_in: 1_000_000,
            min_out: 0,
            min_version: 1,
        },
        arbswap::accounts::Swap {
            trader: user,
            vault,
            config,
            quote_state,
            base_reserve,
            quote_reserve,
            trader_base: lp_base,
            trader_quote: lp_quote,
            token_program: token,
        },
    );
    let sig = send(rpc_url, payer, &[payer], vec![buy]);
    println!("swap_buy sig={sig}");

    let sell = ix(
        program_id,
        arbswap::instruction::Swap {
            side: arbswap::SwapSide::SellBase,
            amount_in: 50_000,
            min_out: 0,
            min_version: 1,
        },
        arbswap::accounts::Swap {
            trader: user,
            vault,
            config,
            quote_state,
            base_reserve,
            quote_reserve,
            trader_base: lp_base,
            trader_quote: lp_quote,
            token_program: token,
        },
    );
    let sig = send(rpc_url, payer, &[payer], vec![sell]);
    println!("swap_sell sig={sig}");

    // --- withdraw: request -> crank_epoch -> claim ---
    wait_slots(rpc_url, 2); // warm-up
    let shares = token_amount(rpc_url, &lp_shares);
    let withdraw_ticket = pda(&[b"wd", vault.as_ref(), user.as_ref()], &program_id);
    let request = ix(
        program_id,
        arbswap::instruction::RequestWithdraw { shares },
        arbswap::accounts::RequestWithdraw {
            user,
            vault,
            share_lock,
            deposit_ticket,
            user_shares: lp_shares,
            withdraw_ticket,
            token_program: token,
            system_program: system,
        },
    );
    let sig = send(rpc_url, payer, &[payer], vec![request]);
    println!("request_withdraw sig={sig}");

    wait_slots(rpc_url, 12); // epoch
    let crank = ix(
        program_id,
        arbswap::instruction::CrankEpoch {},
        arbswap::accounts::CrankEpoch { vault, config },
    );
    let sig = send(rpc_url, payer, &[payer], vec![crank]);
    println!("crank_epoch sig={sig}");

    let claim = ix(
        program_id,
        arbswap::instruction::ClaimWithdraw {},
        arbswap::accounts::ClaimWithdraw {
            user,
            vault,
            base_reserve,
            quote_reserve,
            share_mint,
            share_lock,
            withdraw_ticket,
            user_base: lp_base,
            user_quote: lp_quote,
            token_program: token,
        },
    );
    let sig = send(rpc_url, payer, &[payer], vec![claim]);
    println!("claim_withdraw sig={sig}");
}

fn wait_slots(rpc_url: &str, n: u64) {
    let start = slot(rpc_url);
    loop {
        let now = slot(rpc_url);
        if now >= start + n {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
}
