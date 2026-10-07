//! ArbSwap P3 keeper.
//!
//! `replay <csv>` consumes `slot,publish_time,price_q64,confidence_bps,base,quote`
//! rows and emits deterministic quote decisions. The default sender is dry-run;
//! no private key or mainnet transport is embedded in the research keeper.

use arbswap_keeper::{
    compute_quote, encode_update_quote_instruction, priority_fee_lamports, should_update,
    DryRunSender, KeeperParams, OracleTick, QuoteSender, VolatilityState,
};
use std::env;
use std::fs;

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
        _ => {
            println!("arbswap-keeper replay <csv>");
            println!(
                "arbswap-keeper single <price_q64> <base_reserve> <quote_reserve> \
                 [previous_price_q64] [base_atom_scale]"
            );
            println!("CSV: slot,publish_time,price_q64,confidence_bps,base_reserve,quote_reserve");
        }
    }
}

fn single_quote(price: String, base: String, quote: String, previous: Option<String>,
                base_scale: Option<String>) {
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
            let fee =
                priority_fee_lamports(self.vol.sigma_q64(), self.priority_base, self.vol.jump);
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
