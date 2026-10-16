//! ArbSwap P3 keeper.
//!
//! Subcommands:
//! - `replay <csv>`: deterministic quote decisions from a recorded
//!   `slot,publish_time,price_q64,confidence_bps,base,quote` feed (or a raw
//!   `timestamp,price` CSV). No network.
//! - `single <price_q64> <base> <quote> [previous_price] [base_decimals] [quote_decimals]`:
//!   one quote for differential tests against the Python reference.
//! - `live <hermes_url> <rpc_url> <program_id> <vault> <config> <quote_state>
//!   <base_reserve> <quote_reserve> <price_update> <keeper_bond> <keeper.json>
//!   [priority_micro_lamports_per_cu]`: the streaming loop. Token decimals are
//!   read from the vault's mint accounts (authoritative).
//!
//! The default transports are dry-run/replay; nothing here embeds a private key.

use arbswap_keeper::{
    build_observe_volatility_transaction, build_update_quote_transaction, compute_quote,
    confidence_bps, encode_quote_update_body, encode_update_quote_instruction, pyth_decimal_to_q64,
    volatility_pda, volatility_spread_depth, DryRunSender, KeeperCore, KeeperParams,
    ObserveVolatilityPlan, OracleTick, PrevalidateBounds, QuoteSender, UpdateQuotePlan,
    VolatilityState, MAX_UPDATE_COMPUTE_UNITS,
};
use base64::Engine;
use solana_address::Address;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_signer::Signer;
use std::env;
use std::fs;
use std::path::Path;
use std::thread::sleep;
use std::time::{Duration, Instant};

fn main() {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("replay") => replay(args.next().expect("replay requires a CSV path")),
        Some("single") => single_quote(
            args.next().expect("single requires price_q64"),
            args.next().expect("single requires base"),
            args.next().expect("single requires quote"),
            args.next(),
            args.next(),
            args.next(),
        ),
        Some("quote-json") => quote_json(args.collect()),
        Some("live") => live(args.collect()),
        Some("init-program") => init_program(args.collect()),
        Some("init-vault") => init_vault_cmd(args.collect()),
        _ => {
            println!("arbswap-keeper replay <csv>");
            println!(
                "arbswap-keeper single <price_q64> <base_reserve> <quote_reserve> \
                      [previous_price_q64] [base_decimals] [quote_decimals]"
            );
            println!(
                "arbswap-keeper live <rpc_url> <program_id> <vault> <config> <quote_state> \
                 <base_reserve> <quote_reserve> <price_feed> <keeper_bond> <keeper.json> \
                 <feed_id_hex> [max_staleness_s] [max_conf_bps] \
                 [priority_micro_lamports_per_cu] [run_seconds] [max_vol_bps] [lvr_budget_bps]"
            );
            println!("arbswap-keeper init-vault <config.json> [--send]   (dry-run by default)");
            println!("CSV: slot,publish_time,price_q64,confidence_bps,base_reserve,quote_reserve");
        }
    }
}

fn single_quote(
    price: String,
    base: String,
    quote: String,
    previous: Option<String>,
    base_dec: Option<String>,
    quote_dec: Option<String>,
) {
    let tick = OracleTick {
        slot: 1,
        publish_time: 1,
        price_q64: price.parse().expect("price_q64"),
        confidence_bps: 1,
    };
    let previous_price_q64 = previous
        .map(|value| value.parse().expect("previous_price_q64"))
        .unwrap_or(0);
    let params = KeeperParams {
        base_decimals: base_dec
            .map(|value| value.parse().expect("base_decimals"))
            .unwrap_or(0),
        quote_decimals: quote_dec
            .map(|value| value.parse().expect("quote_decimals"))
            .unwrap_or(0),
        ..KeeperParams::default()
    };
    let next = compute_quote(
        tick,
        VolatilityState::default(),
        base.parse().expect("base"),
        quote.parse().expect("quote"),
        0,
        previous_price_q64,
        params,
    )
    .expect("quote");
    println!(
        "anchor={},reservation={},spread={},ask_extra={},bid_extra={},depth={}",
        next.anchor_sqrt_price,
        next.reservation_sqrt_price,
        next.half_spread_bps,
        next.ask_extra_bps,
        next.bid_extra_bps,
        next.depth_mult_bps
    );
    for (index, level) in next.ask_levels.iter().enumerate() {
        println!(
            "ask{index}={}, {}, {}",
            level.sqrt_lo, level.sqrt_hi, level.liquidity
        );
    }
    for (index, level) in next.bid_levels.iter().enumerate() {
        println!(
            "bid{index}={}, {}, {}",
            level.sqrt_lo, level.sqrt_hi, level.liquidity
        );
    }
}

/// S2-11: emit a complete `QuoteUpdate` payload as JSON (snake_case, u128 fields
/// as decimal strings) so the staged-quote live driver can stage exactly the
/// quote this engine computed. Args:
/// `quote-json <price_q64> <base> <quote> [prev_price] [base_dec] [quote_dec]
///  [publish_time] [slot] [confidence_bps]`.
fn quote_json(args: Vec<String>) {
    let get = |index: usize, name: &str| -> String {
        args.get(index)
            .unwrap_or_else(|| panic!("quote-json requires {name}"))
            .clone()
    };
    let price_q64: u128 = get(0, "price_q64").parse().expect("price_q64");
    let base: u128 = get(1, "base").parse().expect("base");
    let quote: u128 = get(2, "quote").parse().expect("quote");
    let previous_price_q64: u128 = args
        .get(3)
        .map(|value| value.parse().expect("previous_price_q64"))
        .unwrap_or(0);
    let base_decimals: u8 = args
        .get(4)
        .map(|value| value.parse().expect("base_decimals"))
        .unwrap_or(0);
    let quote_decimals: u8 = args
        .get(5)
        .map(|value| value.parse().expect("quote_decimals"))
        .unwrap_or(0);
    let publish_time: i64 = args
        .get(6)
        .map(|value| value.parse().expect("publish_time"))
        .unwrap_or(0);
    let slot: u64 = args
        .get(7)
        .map(|value| value.parse().expect("slot"))
        .unwrap_or(0);
    let confidence_bps: u32 = args
        .get(8)
        .map(|value| value.parse().expect("confidence_bps"))
        .unwrap_or(1);
    let params = KeeperParams {
        base_decimals,
        quote_decimals,
        ..KeeperParams::default()
    };
    let tick = OracleTick {
        slot,
        publish_time,
        price_q64,
        confidence_bps,
    };
    let next = compute_quote(
        tick,
        VolatilityState::default(),
        base,
        quote,
        0,
        previous_price_q64,
        params,
    )
    .expect("quote");
    let levels = |ls: &[arbswap_keeper::Level]| {
        ls.iter()
            .map(|l| {
                serde_json::json!({
                    "sqrt_lo": l.sqrt_lo.to_string(),
                    "sqrt_hi": l.sqrt_hi.to_string(),
                    "liquidity": l.liquidity.to_string(),
                })
            })
            .collect::<Vec<_>>()
    };
    let out = serde_json::json!({
        "update_slot": next.slot,
        "oracle_publish_time": next.publish_time,
        "oracle_conf_bps": next.confidence_bps,
        "anchor_sqrt_price": next.anchor_sqrt_price.to_string(),
        "p_res_sqrt": next.reservation_sqrt_price.to_string(),
        "half_spread_bps": next.half_spread_bps,
        "ask_extra_bps": next.ask_extra_bps,
        "bid_extra_bps": next.bid_extra_bps,
        "depth_mult_bps": next.depth_mult_bps,
        "offsets_bps": next.offsets_bps,
        "weights_bps": next.weights_bps,
        "ask_levels": levels(&next.ask_levels),
        "bid_levels": levels(&next.bid_levels),
        // The exact Borsh payload shared by `update_quote`/`stage_quote`, so the
        // live driver can build `stage_quote` without re-encoding in another
        // language (and without depending on the JS IDL coder).
        "body_hex": encode_quote_update_body(&next)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
    });
    println!("{out}");
}

/// The replay transport wraps the shared [`KeeperCore`] (h6): the CSV path and
/// the live path run the *same* per-tick logic.
struct ReplayKeeper {
    core: KeeperCore,
    sender: DryRunSender,
}

impl ReplayKeeper {
    fn process(&mut self, tick: OracleTick, base: u128, quote: u128, dt_millis: u64) {
        if let Some((next, fee)) = self.core.step(tick, base, quote, 0, dt_millis) {
            self.sender.send(next, fee).expect("dry-run sender");
            let payload = encode_update_quote_instruction(&next);
            let hex = payload
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            println!(
                "update,slot={},spread_bps={},depth_bps={},priority_lamports={},instruction_hex={}",
                next.slot, next.half_spread_bps, next.depth_mult_bps, fee, hex
            );
        }
    }
}

fn replay(path: String) {
    let input = fs::read_to_string(path).expect("read replay CSV");
    let mut keeper = ReplayKeeper {
        core: KeeperCore::new(KeeperParams::default()),
        sender: DryRunSender::default(),
    };
    let raw_price_csv = input
        .lines()
        .next()
        .map(|header| header.contains("price") && !header.contains("price_q64"))
        .unwrap_or(false);
    for (index, line) in input.lines().skip(1).enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split(',').collect();
        if raw_price_csv {
            if fields.len() < 2 {
                continue;
            }
            let timestamp = fields[0].parse::<u64>().expect("timestamp");
            let price_q64 = decimal_to_q64(fields[1]).expect("decimal price");
            let tick = OracleTick {
                slot: (index as u64 + 1) * 2,
                publish_time: if timestamp > 100_000_000_000 {
                    (timestamp / 1_000) as i64
                } else {
                    timestamp as i64
                },
                price_q64,
                confidence_bps: 2,
            };
            keeper.process(tick, 1_000, 150_000, 1_000);
            continue;
        }
        if fields.len() < 6 {
            continue;
        }
        let tick = OracleTick {
            slot: fields[0].parse().expect("slot"),
            publish_time: fields[1].parse().expect("publish_time"),
            price_q64: fields[2].parse().expect("price_q64"),
            confidence_bps: fields[3].parse().expect("confidence_bps"),
        };
        let base: u128 = fields[4].parse().expect("base_reserve");
        let quote: u128 = fields[5].parse().expect("quote_reserve");
        keeper.process(tick, base, quote, 1_000);
    }
    eprintln!(
        "replay complete: {} quote updates",
        keeper.sender.sent.len()
    );
}

/// Claim the one-time program admin (`initialize_program`) so `initialize_vault`
/// cannot be front-run. Minimal client: builds the Anchor instruction by hand.
fn init_program(args: Vec<String>) {
    use sha2::{Digest, Sha256};
    use solana_instruction::{AccountMeta, Instruction};
    use solana_message::Message;
    use solana_transaction::Transaction;

    let get = |i: usize, n: &str| -> String {
        args.get(i)
            .unwrap_or_else(|| panic!("init-program requires {n}"))
            .clone()
    };
    let rpc_url = get(0, "rpc_url");
    let program_id: Address = get(1, "program_id").parse().expect("program_id");
    let admin = read_keypair(&get(2, "admin_keypair"));
    // `find_program_address` is on-chain-only in this crate, so the caller
    // supplies the `[b"program"]` PDA (deterministic from the program id).
    let program_config: Address = get(3, "program_config").parse().expect("program_config");
    let data = Sha256::digest(b"global:initialize_program")[..8].to_vec();
    let system_program: Address = "11111111111111111111111111111111".parse().unwrap();
    let instruction = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new(program_config, false),
            AccountMeta::new_readonly(system_program, false),
        ],
        data,
    };
    let blockhash = rpc_blockhash(&rpc_url).expect("blockhash");
    let transaction = Transaction::new(
        &[&admin],
        Message::new(&[instruction], Some(&admin.pubkey())),
        blockhash,
    );
    match rpc_send_transaction(&rpc_url, &transaction) {
        Some(sig) => println!("initialize_program sent; sig={sig} program_config={program_config}"),
        None => eprintln!("sendTransaction failed (already initialized?)"),
    }
}

/// S2.3C: build (and only with `--send`, submit) the one-time `initialize_vault`.
fn init_vault_cmd(args: Vec<String>) {
    use arbswap_keeper::init_vault::{self, InitSigners};
    use solana_message::Message;
    use solana_transaction::Transaction;

    let config_path = args
        .first()
        .cloned()
        .unwrap_or_else(|| panic!("init-vault requires <config.json> [--send]"));
    let do_send = args.iter().any(|a| a == "--send");

    let file = init_vault::load_file(&config_path).expect("config file");
    init_vault::validate(&file).expect("valid configuration");
    let admin = init_vault::read_keypair(&file.admin_keypair).expect("admin keypair");
    let base_reserve =
        init_vault::load_or_generate(&file.signer_keypairs.base_reserve).expect("base_reserve");
    let quote_reserve =
        init_vault::load_or_generate(&file.signer_keypairs.quote_reserve).expect("quote_reserve");
    let share_mint =
        init_vault::load_or_generate(&file.signer_keypairs.share_mint).expect("share_mint");
    let share_lock =
        init_vault::load_or_generate(&file.signer_keypairs.share_lock).expect("share_lock");
    let signers = InitSigners {
        admin: admin.pubkey(),
        base_reserve: base_reserve.pubkey(),
        quote_reserve: quote_reserve.pubkey(),
        share_mint: share_mint.pubkey(),
        share_lock: share_lock.pubkey(),
    };
    let plan = init_vault::build_plan(&file, &signers).expect("plan");

    println!("init-vault plan (TEST TOKEN, devnet)");
    println!("  program_id     {}", plan.program_id);
    println!("  vault          {}", plan.vault);
    println!("  config         {}", plan.config);
    println!("  quote_state    {}", plan.quote_state);
    println!("  program_config {}", plan.program_config);
    println!("  signers        {}", plan.signers.join(", "));
    println!(
        "  data ({} bytes) {}",
        plan.data_hex.len() / 2,
        plan.data_hex
    );
    for (name, pk, is_signer, is_writable) in &plan.accounts {
        println!("  account {name:<14} {pk} signer={is_signer} writable={is_writable}");
    }
    if !do_send {
        println!(
            "DRY-RUN: instruction built and inspected; nothing submitted. Pass --send to submit."
        );
        return;
    }
    let (ix, _keys) = init_vault::build_instruction(&file, &signers).expect("instruction");
    let blockhash = rpc_blockhash(&file.rpc_url).expect("blockhash");
    let transaction = Transaction::new(
        &[
            &admin,
            &base_reserve,
            &quote_reserve,
            &share_mint,
            &share_lock,
        ],
        Message::new(&[ix], Some(&admin.pubkey())),
        blockhash,
    );
    match rpc_send_transaction(&file.rpc_url, &transaction) {
        Some(sig) => println!("initialize_vault submitted; sig={sig}"),
        None => eprintln!("sendTransaction failed"),
    }
}

fn decimal_to_q64(value: &str) -> Option<u128> {
    let (whole, fraction) = value.trim().split_once('.').unwrap_or((value.trim(), ""));
    let whole_value: u128 = whole.parse().ok()?;
    let mut scale = 1u128;
    let mut fraction_value = 0u128;
    for byte in fraction.bytes().take(18) {
        if !byte.is_ascii_digit() {
            return None;
        }
        fraction_value = fraction_value
            .checked_mul(10)?
            .checked_add((byte - b'0') as u128)?;
        scale = scale.checked_mul(10)?;
    }
    whole_value.checked_mul(arbswap_keeper::Q64)?.checked_add(
        fraction_value
            .checked_mul(arbswap_keeper::Q64)?
            .checked_div(scale)?,
    )
}

// --- live loop -------------------------------------------------------------

fn rpc_call(rpc_url: &str, method: &str, params: serde_json::Value) -> Option<serde_json::Value> {
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params
    });
    let response = ureq::post(rpc_url)
        .send_json(body)
        .ok()?
        .into_string()
        .ok()?;
    serde_json::from_str(&response).ok()
}

fn rpc_blockhash(rpc_url: &str) -> Option<Hash> {
    let value = rpc_call(rpc_url, "getLatestBlockhash", serde_json::json!([]))?;
    let encoded = value
        .get("result")?
        .get("value")?
        .get("blockhash")?
        .as_str()?;
    let bytes = bs58::decode(encoded).into_vec().ok()?;
    let array: [u8; 32] = bytes.try_into().ok()?;
    Some(Hash::new_from_array(array))
}

fn rpc_token_amount(rpc_url: &str, account: &Address) -> Option<u128> {
    let value = rpc_call(
        rpc_url,
        "getTokenAccountBalance",
        serde_json::json!([account.to_string()]),
    )?;
    value
        .get("result")?
        .get("value")?
        .get("amount")?
        .as_str()?
        .parse()
        .ok()
}

fn rpc_slot(rpc_url: &str) -> u64 {
    rpc_call(
        rpc_url,
        "getSlot",
        serde_json::json!([{"commitment": "processed"}]),
    )
    .and_then(|value| value.get("result")?.as_u64())
    .unwrap_or(0)
}

fn rpc_send_transaction(
    rpc_url: &str,
    transaction: &solana_transaction::Transaction,
) -> Option<String> {
    let bytes = wincode::serialize(transaction).ok()?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let value = rpc_call(
        rpc_url,
        "sendTransaction",
        serde_json::json!([encoded, {"encoding": "base64", "skipPreflight": false}]),
    )?;
    if let Some(err) = value.get("error") {
        eprintln!("sendTransaction error: {err}");
        None
    } else {
        value.get("result")?.as_str().map(str::to_string)
    }
}

/// Compute units consumed by a confirmed transaction.
fn rpc_transaction_cu(rpc_url: &str, signature: &str) -> Option<u64> {
    let v = rpc_call(
        rpc_url,
        "getTransaction",
        serde_json::json!([signature, {"encoding": "json", "maxSupportedTransactionVersion": 0}]),
    )?;
    v.get("result")?
        .get("meta")?
        .get("computeUnitsConsumed")?
        .as_u64()
}

/// Read and decode a Pyth persistent price-feed account via the receiver SDK.
fn read_price_feed(
    rpc_url: &str,
    feed_account: &Address,
) -> Option<pyth_solana_receiver_sdk::price_update::PriceUpdateV2> {
    use anchor_lang::AccountDeserialize;
    // Read at `processed` so the publish_time the keeper signs matches the
    // account the program reads at execution (a finalized read lags the
    // poster's latest update and causes a systematic InvalidOracle mismatch).
    let v = rpc_call(
        rpc_url,
        "getAccountInfo",
        serde_json::json!([feed_account.to_string(), {"encoding": "base64", "commitment": "processed"}]),
    )?;
    let value = v.get("result")?.get("value")?;
    if value.is_null() {
        return None;
    }
    if value.get("owner")?.as_str()? != pyth_solana_receiver_sdk::ID.to_string() {
        return None;
    }
    let b64 = value.get("data")?.as_array()?.first()?.as_str()?;
    let data = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let mut slice: &[u8] = &data;
    pyth_solana_receiver_sdk::price_update::PriceUpdateV2::try_deserialize(&mut slice).ok()
}
/// Read the vault account to exclude the fee buckets from ladder capacity.
fn read_vault(rpc_url: &str, vault: &Address) -> Option<arbswap::Vault> {
    use anchor_lang::AccountDeserialize;
    let v = rpc_call(
        rpc_url,
        "getAccountInfo",
        serde_json::json!([vault.to_string(), {"encoding": "base64"}]),
    )?;
    let b64 = v
        .get("result")?
        .get("value")?
        .get("data")?
        .as_array()?
        .first()?
        .as_str()?;
    let data = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    arbswap::Vault::try_deserialize(&mut &data[..]).ok()
}

/// S2.3: read an SPL mint's `decimals` byte (Mint layout offset 44) via RPC.
/// Used so the human oracle price is normalized with authoritative decimals.
fn rpc_mint_decimals(rpc_url: &str, mint: &anchor_lang::prelude::Pubkey) -> Option<u8> {
    let v = rpc_call(
        rpc_url,
        "getAccountInfo",
        serde_json::json!([mint.to_string(), {"encoding": "base64"}]),
    )?;
    let b64 = v
        .get("result")?
        .get("value")?
        .get("data")?
        .as_array()?
        .first()?
        .as_str()?;
    let data = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    // SPL Mint: mint_authority COption (4+32) + supply (8) => decimals at 44.
    data.get(44).copied()
}

/// Read the vault `Config` so the keeper can mirror the on-chain `update_quote`
/// bounds offline (F6). A missing/undecodable config means "do not quote".
fn read_config(rpc_url: &str, config: &Address) -> Option<arbswap::Config> {
    use anchor_lang::AccountDeserialize;
    let v = rpc_call(
        rpc_url,
        "getAccountInfo",
        serde_json::json!([config.to_string(), {"encoding": "base64"}]),
    )?;
    let b64 = v
        .get("result")?
        .get("value")?
        .get("data")?
        .as_array()?
        .first()?
        .as_str()?;
    let data = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    arbswap::Config::try_deserialize(&mut &data[..]).ok()
}

/// Read the vault-bound volatility PDA. `None` means the account does not exist
/// (pre-upgrade program, or a vault that has not run `initialize_volatility`),
/// in which case the keeper omits it so the legacy program keeps working.
fn read_volatility(rpc_url: &str, volatility_state: &Address) -> Option<arbswap::VolatilityState> {
    use anchor_lang::AccountDeserialize;
    let v = rpc_call(
        rpc_url,
        "getAccountInfo",
        serde_json::json!([volatility_state.to_string(), {"encoding": "base64"}]),
    )?;
    let b64 = v
        .get("result")?
        .get("value")?
        .get("data")?
        .as_array()?
        .first()?
        .as_str()?;
    let data = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    arbswap::VolatilityState::try_deserialize(&mut &data[..]).ok()
}

fn read_keypair(path: &str) -> Keypair {
    let text = fs::read_to_string(Path::new(path)).expect("read keeper keypair");
    let bytes: Vec<u8> = serde_json::from_str(&text).expect("keypair JSON array");
    let seed: [u8; 32] = bytes
        .get(..32)
        .expect("keypair has at least 32 bytes")
        .try_into()
        .unwrap();
    Keypair::new_from_array(seed)
}

fn parse_feed_id(hex: &str) -> [u8; 32] {
    let h = hex.trim_start_matches("0x");
    let mut out = [0u8; 32];
    for k in 0..32 {
        out[k] = u8::from_str_radix(&h[k * 2..k * 2 + 2], 16).expect("feed id hex");
    }
    out
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The streaming loop (Build Plan §7.1). Reads the persistent Pyth price-feed
/// account over RPC, decodes it with the receiver SDK, rejects stale / invalid /
/// wide observations, updates volatility only on a genuinely new publish time,
/// and submits `update_quote` within the program's bounds. A keeper outage
/// simply lets the on-chain quote expire (safe failure).
fn live(args: Vec<String>) {
    let get = |index: usize, name: &str| -> String {
        args.get(index)
            .unwrap_or_else(|| panic!("live requires {name}"))
            .clone()
    };
    let rpc_url = get(0, "rpc_url");
    let program_id: Address = get(1, "program_id").parse().expect("program_id");
    let vault: Address = get(2, "vault").parse().expect("vault");
    let config: Address = get(3, "config").parse().expect("config");
    let quote_state: Address = get(4, "quote_state").parse().expect("quote_state");
    let base_reserve: Address = get(5, "base_reserve").parse().expect("base_reserve");
    let quote_reserve: Address = get(6, "quote_reserve").parse().expect("quote_reserve");
    let price_feed: Address = get(7, "price_feed").parse().expect("price_feed");
    let keeper_bond: Address = get(8, "keeper_bond").parse().expect("keeper_bond");
    let keeper = read_keypair(&get(9, "keeper_keypair"));
    let volatility_state = volatility_pda(&vault, &program_id);
    let expected_feed = parse_feed_id(&get(10, "feed_id"));
    let max_staleness: i64 = args
        .get(11)
        .map(|v| v.parse().expect("max_staleness"))
        .unwrap_or(60);
    let max_conf_bps: u32 = args
        .get(12)
        .map(|v| v.parse().expect("max_conf_bps"))
        .unwrap_or(50);
    // S2.3: token decimals are read from the vault's mint accounts
    // (authoritative), not supplied by the caller, so the human oracle price is
    // normalized to the raw quote-atoms-per-base-atom price exactly once.
    let vault_meta = read_vault(&rpc_url, &vault)
        .unwrap_or_else(|| panic!("vault {vault} not found; cannot read mint decimals"));
    let base_decimals = rpc_mint_decimals(&rpc_url, &vault_meta.base_mint)
        .unwrap_or_else(|| panic!("base mint {} not found", vault_meta.base_mint));
    let quote_decimals = rpc_mint_decimals(&rpc_url, &vault_meta.quote_mint)
        .unwrap_or_else(|| panic!("quote mint {} not found", vault_meta.quote_mint));
    let base_mint_addr = Address::new_from_array(vault_meta.base_mint.to_bytes());
    let quote_mint_addr = Address::new_from_array(vault_meta.quote_mint.to_bytes());
    let priority_micro_lamports_per_cu: u64 = args
        .get(13)
        .map(|v| v.parse().expect("priority"))
        .unwrap_or(1_000);
    let run_seconds: u64 = args
        .get(14)
        .map(|v| v.parse().expect("run_seconds"))
        .unwrap_or(0);
    // P0/I2-I3: operator policy for the depth throttle. `max_vol_bps = 0`
    // disables the volatility kill-switch; `lvr_budget_bps` is the active-depth
    // cap from the LVR budget (10_000 = full depth, neutral default).
    let max_vol_bps: u32 = args
        .get(15)
        .map(|v| v.parse().expect("max_vol_bps"))
        .unwrap_or(0);
    let lvr_budget_bps: u32 = args
        .get(16)
        .map(|v| v.parse().expect("lvr_budget_bps"))
        .unwrap_or(10_000);
    let interval = Duration::from_millis(400);

    let params = KeeperParams {
        base_decimals,
        quote_decimals,
        max_vol_q64: if max_vol_bps == 0 {
            u128::MAX
        } else {
            (max_vol_bps as u128) * arbswap_keeper::Q64 / 10_000
        },
        lvr_budget_bps,
        ..KeeperParams::default()
    };
    let mut core = KeeperCore::new(params);
    let mut last_publish_time: i64 = 0;
    let mut last_publish_wall: u64 = 0;
    let mut submitted: u64 = 0;
    let mut skipped: u64 = 0;
    let mut failures: u64 = 0;
    let start = Instant::now();

    eprintln!("keeper live: rpc={rpc_url} feed={price_feed}");
    loop {
        if run_seconds > 0 && start.elapsed().as_secs() >= run_seconds {
            break;
        }
        let wall = now_unix();
        let Some(pu) = read_price_feed(&rpc_url, &price_feed) else {
            skipped += 1;
            sleep(interval);
            continue;
        };
        let msg = &pu.price_message;
        if msg.feed_id != expected_feed {
            skipped += 1;
            sleep(interval);
            continue;
        }
        let age = wall as i64 - msg.publish_time;
        if msg.price <= 0 || age > max_staleness {
            skipped += 1;
            sleep(interval);
            continue;
        }
        let conf_bps = confidence_bps(msg.conf, msg.price);
        if conf_bps > max_conf_bps {
            skipped += 1;
            sleep(interval);
            continue;
        }
        // Only a genuinely new observation advances the EWMA/jump state.
        if msg.publish_time <= last_publish_time {
            sleep(interval);
            continue;
        }
        let dt_millis = if last_publish_wall == 0 {
            1_000
        } else {
            (wall.saturating_sub(last_publish_wall) * 1_000).max(1)
        };
        last_publish_time = msg.publish_time;
        last_publish_wall = wall;
        let Some(price_q64) = pyth_decimal_to_q64(msg.price, msg.exponent) else {
            sleep(interval);
            continue;
        };
        let slot = rpc_slot(&rpc_url);
        // Advance the vault-bound on-chain volatility state with the new
        // observation. Best-effort and independent of the quote: a rejected
        // quote must never roll back a valid observation. Only attempted when
        // the PDA exists (pre-upgrade programs have no such account).
        let mut vol_onchain = read_volatility(&rpc_url, &volatility_state);
        if vol_onchain.is_some() {
            if let Some(blockhash) = rpc_blockhash(&rpc_url) {
                let obs_plan = ObserveVolatilityPlan {
                    program_id,
                    observer: keeper.pubkey(),
                    vault,
                    config,
                    volatility_state,
                    price_update: price_feed,
                    base_mint: base_mint_addr,
                    quote_mint: quote_mint_addr,
                    recent_blockhash: blockhash,
                    compute_unit_limit: MAX_UPDATE_COMPUTE_UNITS,
                };
                let tx = build_observe_volatility_transaction(
                    &obs_plan,
                    &keeper,
                    priority_micro_lamports_per_cu,
                );
                match rpc_send_transaction(&rpc_url, &tx) {
                    Some(s) => eprintln!("observe,sig={s}"),
                    None => eprintln!("observe failed (continuing)"),
                }
                vol_onchain = read_volatility(&rpc_url, &volatility_state);
            }
        }
        let (Some(base), Some(quote)) = (
            rpc_token_amount(&rpc_url, &base_reserve),
            rpc_token_amount(&rpc_url, &quote_reserve),
        ) else {
            sleep(interval);
            continue;
        };
        // Size the ladder from the LP-available reserves (net of the fee
        // buckets), matching the program's utilization cap (Item 3).
        let Some(vs) = read_vault(&rpc_url, &vault) else {
            sleep(interval);
            continue;
        };
        let (base_avail, quote_avail) = arbswap_keeper::available_reserves(
            base,
            quote,
            vs.insurance_base as u128,
            vs.insurance_quote as u128,
            vs.keeper_base as u128,
            vs.keeper_quote as u128,
            vs.protocol_base as u128,
            vs.protocol_quote as u128,
        );
        // F6: mirror the on-chain `update_quote` bounds offline so the keeper
        // never spends a transaction on a quote the program would reject for a
        // knowable reason (spread/anchor/inventory/capacity/slot/confidence).
        let Some(cfg) = read_config(&rpc_url, &config) else {
            skipped += 1;
            sleep(interval);
            continue;
        };
        core.bounds = Some(PrevalidateBounds {
            min_spread_bps: cfg.min_spread_bps,
            max_spread_bps: cfg.max_spread_bps,
            max_anchor_step_bps: cfg.max_anchor_step_bps,
            max_anchor_dev_bps: cfg.max_anchor_dev_bps,
            max_inventory_bps: cfg.max_inventory_bps,
            utilization_max_bps: cfg.utilization_max_bps,
            max_conf_bps: cfg.max_conf_bps,
            max_update_slot_age: cfg.max_update_slot_age as u64,
            max_staleness_seconds: cfg.max_staleness_seconds,
            now_publish_time: wall as i64,
            previous_anchor_sqrt_price: core.accepted_anchor_sqrt_price,
            available_base: base_avail,
            available_quote: quote_avail,
            now_slot: slot,
        });
        let tick = OracleTick {
            slot,
            publish_time: msg.publish_time,
            price_q64,
            confidence_bps: conf_bps,
        };
        let Some((mut next, _fee)) = core.step(tick, base_avail, quote_avail, 0, dt_millis) else {
            sleep(interval);
            continue;
        };
        // When the on-chain volatility PDA is enabled, size the quote to the
        // program's spread floor and depth cap so the transaction is accepted
        // rather than rejected. A sigma above the configured ceiling is the
        // program's kill-switch: quote nothing.
        if let Some(vso) = &vol_onchain {
            if vso.enabled {
                let Ok(sigma_q64) = arb_math::fixed::sqrt_q64(vso.short_ewma_q64) else {
                    skipped += 1;
                    sleep(interval);
                    continue;
                };
                if sigma_q64 > vso.max_sigma_q64 {
                    skipped += 1;
                    eprintln!("skip: on-chain sigma above configured ceiling");
                    sleep(interval);
                    continue;
                }
                let sigma_bps = sigma_q64.saturating_mul(10_000) / (1u128 << 64);
                let jump_active = vso.jump_detected || slot < vso.jump_until_slot;
                let mult = if jump_active {
                    vso.jump_multiple as u128
                } else {
                    1
                };
                let (floor, cap) = volatility_spread_depth(
                    sigma_bps,
                    mult,
                    vso.vol_spread_coeff_bps,
                    vso.vol_depth_coeff_bps,
                    cfg.min_spread_bps,
                );
                if floor > cfg.max_spread_bps {
                    skipped += 1;
                    eprintln!("skip: volatility floor exceeds configured max spread");
                    sleep(interval);
                    continue;
                }
                next.half_spread_bps = next.half_spread_bps.max(floor).min(cfg.max_spread_bps);
                next.depth_mult_bps = next.depth_mult_bps.min(cap);
            }
        }
        let Some(blockhash) = rpc_blockhash(&rpc_url) else {
            failures += 1;
            sleep(interval);
            continue;
        };
        let plan = UpdateQuotePlan {
            program_id,
            keeper: keeper.pubkey(),
            vault,
            config,
            quote_state,
            price_update: price_feed,
            keeper_bond,
            base_reserve,
            quote_reserve,
            base_mint: base_mint_addr,
            quote_mint: quote_mint_addr,
            volatility_state: vol_onchain.as_ref().map(|_| volatility_state),
            recent_blockhash: blockhash,
            compute_unit_limit: MAX_UPDATE_COMPUTE_UNITS,
        };
        let tx_start = Instant::now();
        let mut attempt = 0u32;
        let mut sig: Option<String> = None;
        while attempt < 3 {
            attempt += 1;
            let transaction = build_update_quote_transaction(
                &plan,
                &keeper,
                &next,
                priority_micro_lamports_per_cu,
            );
            match rpc_send_transaction(&rpc_url, &transaction) {
                Some(s) => {
                    sig = Some(s);
                    break;
                }
                None => core.on_send_failure(),
            }
        }
        match sig {
            Some(s) => {
                let latency_ms = tx_start.elapsed().as_millis();
                let cu = rpc_transaction_cu(&rpc_url, &s).unwrap_or(0);
                submitted += 1;
                // Only a sent quote advances the anchor used by the next bound.
                core.accepted_anchor_sqrt_price = next.anchor_sqrt_price;
                println!(
                    "update,sig={s},publish_time={},version_slot={},latency_ms={latency_ms},cu={cu},attempts={attempt},err=none",
                    next.publish_time, next.slot
                );
            }
            None => {
                failures += 1;
                eprintln!("update failed after {attempt} attempts");
            }
        }
        sleep(interval);
    }
    eprintln!("keeper live done: submitted={submitted} skipped={skipped} failures={failures}");
}
