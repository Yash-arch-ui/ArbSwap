//! ArbSwap P3 keeper.
//!
//! Subcommands:
//! - `replay <csv>`: deterministic quote decisions from a recorded
//!   `slot,publish_time,price_q64,confidence_bps,base,quote` feed (or a raw
//!   `timestamp,price` CSV). No network.
//! - `single <price_q64> <base> <quote> [previous_price] [base_atom_scale]`:
//!   one quote for differential tests against the Python reference.
//! - `live <hermes_url> <rpc_url> <program_id> <vault> <config> <quote_state>
//!   <base_reserve> <quote_reserve> <price_update> <keeper_bond> <keeper.json>
//!   [base_atom_scale] [priority_micro_lamports_per_cu]`: the streaming loop.
//!   Reads Pyth Hermes, reads reserves over JSON-RPC, and submits `update_quote`.
//!
//! The default transports are dry-run/replay; nothing here embeds a private key.

use arbswap_keeper::{
    build_update_quote_transaction, compute_quote, confidence_bps, encode_update_quote_instruction,
    pyth_decimal_to_q64, DryRunSender, KeeperCore, KeeperParams, OracleTick, QuoteSender,
    UpdateQuotePlan, VolatilityState, MAX_UPDATE_COMPUTE_UNITS,
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
        ),
        Some("live") => live(args.collect()),
        Some("init-program") => init_program(args.collect()),
        _ => {
            println!("arbswap-keeper replay <csv>");
            println!(
                "arbswap-keeper single <price_q64> <base_reserve> <quote_reserve> \
                      [previous_price_q64] [base_atom_scale]"
            );
            println!(
                "arbswap-keeper live <rpc_url> <program_id> <vault> <config> <quote_state> \
                 <base_reserve> <quote_reserve> <price_feed> <keeper_bond> <keeper.json> \
                 <feed_id_hex> [max_staleness_s] [max_conf_bps] [base_atom_scale] \
                 [priority_micro_lamports_per_cu] [run_seconds]"
            );
            println!("CSV: slot,publish_time,price_q64,confidence_bps,base_reserve,quote_reserve");
        }
    }
}

fn single_quote(
    price: String,
    base: String,
    quote: String,
    previous: Option<String>,
    base_scale: Option<String>,
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
        base_atom_scale: base_scale
            .map(|value| value.parse().expect("base_atom_scale"))
            .unwrap_or(1),
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
    rpc_call(rpc_url, "getSlot", serde_json::json!([]))
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
    let v = rpc_call(
        rpc_url,
        "getAccountInfo",
        serde_json::json!([feed_account.to_string(), {"encoding": "base64"}]),
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
    let expected_feed = parse_feed_id(&get(10, "feed_id"));
    let max_staleness: i64 = args
        .get(11)
        .map(|v| v.parse().expect("max_staleness"))
        .unwrap_or(60);
    let max_conf_bps: u32 = args
        .get(12)
        .map(|v| v.parse().expect("max_conf_bps"))
        .unwrap_or(50);
    let base_atom_scale: u128 = args
        .get(13)
        .map(|v| v.parse().expect("base_atom_scale"))
        .unwrap_or(1);
    let priority_micro_lamports_per_cu: u64 = args
        .get(14)
        .map(|v| v.parse().expect("priority"))
        .unwrap_or(1_000);
    let run_seconds: u64 = args
        .get(15)
        .map(|v| v.parse().expect("run_seconds"))
        .unwrap_or(0);
    let interval = Duration::from_millis(400);

    let params = KeeperParams {
        base_atom_scale,
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
        let tick = OracleTick {
            slot,
            publish_time: msg.publish_time,
            price_q64,
            confidence_bps: conf_bps,
        };
        let Some((next, _fee)) = core.step(tick, base_avail, quote_avail, 0, dt_millis) else {
            sleep(interval);
            continue;
        };
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
                None => core.previous = None,
            }
        }
        match sig {
            Some(s) => {
                let latency_ms = tx_start.elapsed().as_millis();
                let cu = rpc_transaction_cu(&rpc_url, &s).unwrap_or(0);
                submitted += 1;
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
