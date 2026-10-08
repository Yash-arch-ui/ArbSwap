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
    adaptive_priority_fee, compute_quote, encode_update_quote_instruction, parse_hermes,
    should_update, DryRunSender, KeeperParams, OracleTick, QuoteSender, UpdateQuotePlan,
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
use std::time::Duration;

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
        _ => {
            println!("arbswap-keeper replay <csv>");
            println!(
                "arbswap-keeper single <price_q64> <base_reserve> <quote_reserve> \
                      [previous_price_q64] [base_atom_scale]"
            );
            println!(
                "arbswap-keeper live <hermes_url> <rpc_url> <program_id> <vault> <config> \
                 <quote_state> <base_reserve> <quote_reserve> <price_update> <keeper_bond> \
                 <keeper.json> [base_atom_scale] [priority_micro_lamports_per_cu]"
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
    for (index, level) in next.levels.iter().enumerate() {
        println!(
            "level{index}={}, {}, {}",
            level.sqrt_lo, level.sqrt_hi, level.liquidity
        );
    }
}

/// Mutable keeper state carried across replay rows. Grouping it keeps the
/// per-tick entry point small enough to stay clippy-clean.
struct ReplayKeeper {
    params: KeeperParams,
    vol: VolatilityState,
    previous: Option<arbswap_keeper::QuoteUpdate>,
    sender: DryRunSender,
    priority_base: u64,
}

impl ReplayKeeper {
    fn process(&mut self, tick: OracleTick, base: u128, quote: u128) {
        let previous_price = self.vol.previous_price_q64;
        self.vol = self.vol.update(tick.price_q64, 9400, 9900, 4);
        let Some(next) = compute_quote(tick, self.vol, base, quote, 0, previous_price, self.params)
        else {
            return;
        };
        if should_update(self.previous, &next, 5, 10) {
            let fee = adaptive_priority_fee(
                self.vol.sigma_q64(),
                self.priority_base,
                self.vol.jump,
                1_000,
                50_000,
            );
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
            self.previous = Some(next);
        }
    }
}

fn replay(path: String) {
    let input = fs::read_to_string(path).expect("read replay CSV");
    let mut keeper = ReplayKeeper {
        params: KeeperParams::default(),
        vol: VolatilityState::default(),
        previous: None,
        sender: DryRunSender::default(),
        priority_base: 1_000,
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
            keeper.process(tick, 1_000, 150_000);
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
        keeper.process(tick, base, quote);
    }
    eprintln!(
        "replay complete: {} quote updates",
        keeper.sender.sent.len()
    );
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
) -> Option<()> {
    let bytes = wincode::serialize(transaction).ok()?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let value = rpc_call(
        rpc_url,
        "sendTransaction",
        serde_json::json!([encoded, {"encoding": "base64"}]),
    )?;
    if value.get("error").is_some() {
        None
    } else {
        Some(())
    }
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

/// The streaming loop (Build Plan §7.1). Stale/wide/absent prices are skipped,
/// so a keeper outage simply lets the on-chain quote expire (safe).
fn live(args: Vec<String>) {
    let get = |index: usize, name: &str| -> String {
        args.get(index)
            .unwrap_or_else(|| panic!("live requires {name}"))
            .clone()
    };
    let hermes_url = get(0, "hermes_url");
    let rpc_url = get(1, "rpc_url");
    let program_id: Address = get(2, "program_id").parse().expect("program_id");
    let vault: Address = get(3, "vault").parse().expect("vault");
    let config: Address = get(4, "config").parse().expect("config");
    let quote_state: Address = get(5, "quote_state").parse().expect("quote_state");
    let base_reserve: Address = get(6, "base_reserve").parse().expect("base_reserve");
    let quote_reserve: Address = get(7, "quote_reserve").parse().expect("quote_reserve");
    let price_update: Address = get(8, "price_update").parse().expect("price_update");
    let keeper_bond: Address = get(9, "keeper_bond").parse().expect("keeper_bond");
    let keeper = read_keypair(&get(10, "keeper_keypair"));
    let base_atom_scale: u128 = args
        .get(11)
        .map(|value| value.parse().expect("base_atom_scale"))
        .unwrap_or(1);
    let priority_micro_lamports_per_cu: u64 = args
        .get(12)
        .map(|value| value.parse().expect("priority_micro_lamports_per_cu"))
        .unwrap_or(1_000);
    let interval = Duration::from_millis(400);

    let params = KeeperParams {
        base_atom_scale,
        ..KeeperParams::default()
    };
    let mut vol = VolatilityState::default();
    let mut previous: Option<arbswap_keeper::QuoteUpdate> = None;

    eprintln!("keeper live: rpc={rpc_url} hermes={hermes_url}");
    loop {
        let Some(blockhash) = rpc_blockhash(&rpc_url) else {
            sleep(interval);
            continue;
        };
        let slot = rpc_slot(&rpc_url);
        let Some(body) = ureq::get(&hermes_url)
            .call()
            .ok()
            .and_then(|response| response.into_string().ok())
        else {
            sleep(interval);
            continue;
        };
        let Some(tick) = parse_hermes(&body, slot) else {
            sleep(interval);
            continue;
        };
        let (Some(base), Some(quote)) = (
            rpc_token_amount(&rpc_url, &base_reserve),
            rpc_token_amount(&rpc_url, &quote_reserve),
        ) else {
            sleep(interval);
            continue;
        };
        let previous_price = vol.previous_price_q64;
        vol = vol.update(tick.price_q64, 9400, 9900, 4);
        let Some(next) = compute_quote(tick, vol, base, quote, 0, previous_price, params) else {
            sleep(interval);
            continue;
        };
        if should_update(previous, &next, 5, 10) {
            let plan = UpdateQuotePlan {
                program_id,
                keeper: keeper.pubkey(),
                vault,
                config,
                quote_state,
                price_update,
                keeper_bond,
                base_reserve,
                quote_reserve,
                recent_blockhash: blockhash,
                compute_unit_limit: MAX_UPDATE_COMPUTE_UNITS,
            };
            let transaction = arbswap_keeper::build_update_quote_transaction(
                &plan,
                &keeper,
                &next,
                priority_micro_lamports_per_cu,
            );
            match rpc_send_transaction(&rpc_url, &transaction) {
                Some(()) => {
                    eprintln!("update landed slot={}", next.slot);
                    previous = Some(next);
                }
                None => eprintln!("sendTransaction failed; will retry next tick"),
            }
        }
        sleep(interval);
    }
}
