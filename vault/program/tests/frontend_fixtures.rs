//! P1.2(iii): emit deterministic account fixtures for the frontend decoding
//! tests. The bytes come from the program's own `AccountSerialize` impl (the
//! exact on-chain layout) — they are never hand-written. Regenerate with
//! `scripts/gen_frontend_fixtures.sh`; CI fails if the committed fixture is
//! stale (`cargo test -p arbswap --test frontend_fixtures && git diff --exit-code`).

use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::AccountSerialize;
use arbswap::{Config, Level, QuoteState, Vault, ID};

const LEVELS: usize = 6;

fn pk(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn encode<T: AccountSerialize>(value: &T) -> String {
    let mut data = Vec::new();
    value.try_serialize(&mut data).expect("account serialize");
    hex(&data)
}

fn level(offset_bps: u32, weight_bps: u32, tag: u128) -> Level {
    Level {
        offset_bps,
        weight_bps,
        sqrt_lo: 225_887_000_000_000_000_000 + tag,
        sqrt_hi: 225_887_100_000_000_000_000 + tag,
        liquidity: 10_000_000_000 + tag,
    }
}

fn ask_levels() -> [Level; LEVELS] {
    [
        level(0, 1000, 0),
        level(2, 1500, 1),
        level(5, 2000, 2),
        level(10, 2000, 3),
        level(20, 2000, 4),
        level(40, 1500, 5),
    ]
}

fn bid_levels() -> [Level; LEVELS] {
    [
        level(0, 1000, 100),
        level(2, 1500, 101),
        level(5, 2000, 102),
        level(10, 2000, 103),
        level(20, 2000, 104),
        level(40, 1500, 105),
    ]
}

fn vault() -> Vault {
    Vault {
        admin: pk(1),
        base_mint: pk(2),
        quote_mint: pk(3),
        base_reserve: pk(4),
        quote_reserve: pk(5),
        share_mint: pk(6),
        share_lock: pk(7),
        total_shares: 1_234_567_890,
        insurance_base: 11,
        insurance_quote: 22,
        keeper_base: 33,
        keeper_quote: 44,
        protocol_base: 55,
        protocol_quote: 66,
        epoch: 42,
        epoch_start: 4_242,
        status: 1,
        bump: 254,
    }
}

fn config() -> Config {
    Config {
        admin: pk(1),
        keeper: pk(8),
        treasury: pk(9),
        pyth_feed_id: [7u8; 32],
        fee_bps: 100,
        insurance_bps: 3333,
        keeper_bps: 3333,
        protocol_bps: 3334,
        min_liquidity: 1000,
        warmup_slots: 150,
        epoch_slots: 216_000,
        grace_slots: 9_000,
        expiry_slots: 10,
        max_staleness_seconds: 30,
        max_conf_bps: 10,
        max_anchor_step_bps: 50,
        max_spread_step_bps: 10,
        min_spread_bps: 2,
        max_spread_bps: 50,
        max_quote_size: 1_000_000_000,
        max_inventory_bps: 6000,
        utilization_max_bps: 9000,
        min_bond: 0,
        unbond_cooldown_slots: 216_000,
        max_update_slot_age: 25,
        edge_window_slots: 216_000,
        max_edge_loss_bps: 50,
        max_anchor_dev_bps: 25,
        flow_window_slots: 216_000,
        max_window_flow_bps: 10_000,
        pending_admin: Pubkey::default(),
        admin_activate_slot: 0,
        bump: 253,
    }
}

fn quote_state() -> QuoteState {
    QuoteState {
        version: 7,
        update_slot: 1000,
        expiry_slot: 1010,
        anchor_sqrt_price: 225_887_000_000_000_000_000,
        p_res_sqrt: 225_887_000_000_000_000_001,
        half_spread_bps: 5,
        ask_extra_bps: 0,
        bid_extra_bps: 0,
        depth_mult_bps: 10_000,
        window_start_slot: 900,
        window_base_sold: 123,
        window_base_bought: 456,
        oracle_publish_time: 1_700_000_000,
        oracle_conf_bps: 1,
        oracle_price: 225_887_000_000_000_000_000,
        edge_window_start_slot: 800,
        realized_edge: -5,
        flow_n: 7,
        ask_levels: ask_levels(),
        bid_levels: bid_levels(),
        bump: 252,
        keeper: Pubkey::default(),
    }
}

#[test]
fn emit_frontend_fixtures() {
    let json = format!(
        "{{\n  \"programId\": \"{}\",\n  \"vault\": \"{}\",\n  \"config\": \"{}\",\n  \"quoteState\": \"{}\"\n}}\n",
        ID,
        encode(&vault()),
        encode(&config()),
        encode(&quote_state()),
    );

    let out = std::env::var("ARBSWAP_FIXTURES_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../app/test/fixtures/accounts.json")
        });
    std::fs::create_dir_all(out.parent().expect("fixture dir")).expect("mkdir fixtures");
    std::fs::write(&out, json).expect("write fixtures");
    println!("wrote {}", out.display());
}
