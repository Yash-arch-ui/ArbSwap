//! ArbSwap P3 keeper.
//!
//! `replay <csv>` consumes `slot,publish_time,price_q64,confidence_bps,base,quote`
//! rows and emits deterministic quote decisions. The default sender is dry-run;
//! no private key or mainnet transport is embedded in the research keeper.

use arbswap_keeper::{compute_quote, encode_update_quote_instruction, priority_fee_lamports, should_update, DryRunSender, KeeperParams, OracleTick, QuoteSender, VolatilityState};
use std::env;
use std::fs;

fn main() {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("replay") => replay(args.next().expect("replay requires a CSV path")),
        _ => {
            println!("arbswap-keeper replay <csv>");
            println!("CSV: slot,publish_time,price_q64,confidence_bps,base_reserve,quote_reserve");
        }
    }
}

fn replay(path: String) {
    let input = fs::read_to_string(path).expect("read replay CSV");
    let params = KeeperParams::default();
    let mut vol = VolatilityState::default();
    let mut previous = None;
    let mut sender = DryRunSender::default();
    for line in input.lines().skip(1) {
        if line.trim().is_empty() { continue; }
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() < 6 { continue; }
        let tick = OracleTick { slot: fields[0].parse().expect("slot"), publish_time: fields[1].parse().expect("publish_time"), price_q64: fields[2].parse().expect("price_q64"), confidence_bps: fields[3].parse().expect("confidence_bps") };
        let base: u128 = fields[4].parse().expect("base_reserve");
        let quote: u128 = fields[5].parse().expect("quote_reserve");
        vol = vol.update(tick.price_q64, 9400, 9900, 4);
        let Some(next) = compute_quote(tick, vol, base, quote, 0, params) else { continue };
        if should_update(previous, &next, 5, 10) {
            let fee = priority_fee_lamports(vol.sigma_q64(), 1_000, vol.jump);
            sender.send(next, fee).expect("dry-run sender");
            let payload = encode_update_quote_instruction(&next);
            let hex = payload.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
            println!("update,slot={},spread_bps={},depth_bps={},priority_lamports={},instruction_hex={}", next.slot, next.half_spread_bps, next.depth_mult_bps, fee, hex);
            previous = Some(next);
        }
    }
    eprintln!("replay complete: {} quote updates", sender.sent.len());
}
