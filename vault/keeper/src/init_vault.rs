//! S2.3C — vault-initialization client.
//!
//! Builds (and, only with explicit `--send`, submits) the one-time
//! `initialize_vault` transaction for the ArbSwap devnet vault, using the
//! program's own `InitParams`/accounts types so the payload can never drift
//! from the on-chain ABI. Dry-run is the default: it derives every PDA, builds
//! and inspects the instruction, and prints the plan without submitting.
//!
//! TEST TOKEN, devnet. No keys are embedded; all keypair paths live outside
//! the repo. Nothing here mints, deposits, or starts the keeper.

use std::path::Path;

use anchor_lang::{InstructionData, ToAccountMetas};
use serde::Deserialize;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_keypair::Keypair;

const TOKEN_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_ID: &str = "11111111111111111111111111111111";
const RENT_ID: &str = "SysvarRent111111111111111111111111111111111";

/// Configuration file accepted by `init-vault`.
#[derive(Debug, Clone, Deserialize)]
pub struct InitVaultFile {
    pub rpc_url: String,
    pub program_id: String,
    /// Path to the admin/upgrade-authority keypair (must equal `program_config.admin`).
    pub admin_keypair: String,
    pub base_mint: String,
    pub quote_mint: String,
    /// Optional pre-generated keypair paths; missing ones are generated.
    #[serde(default)]
    pub signer_keypairs: SignerPaths,
    pub params: Params,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SignerPaths {
    pub base_reserve: Option<String>,
    pub quote_reserve: Option<String>,
    pub share_mint: Option<String>,
    pub share_lock: Option<String>,
}

/// `InitParams` (minus the mints, which are top-level) as a serde struct.
#[derive(Debug, Clone, Deserialize)]
pub struct Params {
    pub keeper: String,
    pub treasury: String,
    pub pyth_feed_id_hex: String,
    pub fee_bps: u16,
    pub insurance_bps: u16,
    pub keeper_bps: u16,
    pub protocol_bps: u16,
    pub min_liquidity: u64,
    pub warmup_slots: u64,
    pub epoch_slots: u64,
    pub grace_slots: u64,
    pub expiry_slots: u64,
    pub max_staleness_seconds: i64,
    pub max_conf_bps: u32,
    pub max_anchor_step_bps: u32,
    pub max_spread_step_bps: u32,
    pub min_spread_bps: u32,
    pub max_spread_bps: u32,
    pub max_quote_size: u64,
    pub max_inventory_bps: u32,
    pub utilization_max_bps: u32,
    pub min_bond: u64,
    pub unbond_cooldown_slots: u64,
    pub max_update_slot_age: u32,
    pub edge_window_slots: u64,
    pub max_edge_loss_bps: u32,
    pub max_anchor_dev_bps: u32,
    pub flow_window_slots: u64,
    pub max_window_flow_bps: u32,
    pub offsets_bps: [u32; 6],
    pub weights_bps: [u32; 6],
}

/// The public keys that must sign `initialize_vault`.
#[derive(Debug, Clone)]
pub struct InitSigners {
    pub admin: Address,
    pub base_reserve: Address,
    pub quote_reserve: Address,
    pub share_mint: Address,
    pub share_lock: Address,
}

pub const ACCOUNT_NAMES: [&str; 14] = [
    "admin",
    "program_config",
    "vault",
    "config",
    "quote_state",
    "base_mint",
    "quote_mint",
    "base_reserve",
    "quote_reserve",
    "share_mint",
    "share_lock",
    "token_program",
    "system_program",
    "rent",
];

#[derive(Debug, Clone)]
pub struct InitPlan {
    pub program_id: Address,
    pub vault: Address,
    pub config: Address,
    pub quote_state: Address,
    pub program_config: Address,
    /// (name, pubkey, is_signer, is_writable) in instruction order.
    pub accounts: Vec<(String, String, bool, bool)>,
    pub signers: Vec<String>,
    pub data_hex: String,
}

fn parse_pk(s: &str) -> Result<Address, String> {
    s.trim()
        .parse::<Address>()
        .map_err(|_| format!("invalid pubkey: {s}"))
}

fn hex32(s: &str) -> Result<[u8; 32], String> {
    let s = s.trim().trim_start_matches("0x");
    if s.len() != 64 {
        return Err(format!(
            "expected 32-byte hex feed id, got {} chars",
            s.len()
        ));
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
            .map_err(|_| format!("invalid hex in feed id at byte {i}"))?;
    }
    Ok(out)
}

/// Validate the whole configuration against the program's own `initialize_vault`
/// checks (mirroring `vault/program/src/lib.rs`). No transaction is built here.
pub fn validate(file: &InitVaultFile) -> Result<(), String> {
    let base = parse_pk(&file.base_mint)?;
    let quote = parse_pk(&file.quote_mint)?;
    if base == quote {
        return Err("base_mint must differ from quote_mint".into());
    }
    parse_pk(&file.program_id).map_err(|e| format!("program_id: {e}"))?;
    parse_pk(&file.params.keeper).map_err(|e| format!("keeper: {e}"))?;
    parse_pk(&file.params.treasury).map_err(|e| format!("treasury: {e}"))?;
    hex32(&file.params.pyth_feed_id_hex)?;

    let p = &file.params;
    if p.min_liquidity == 0 {
        return Err("min_liquidity must be > 0".into());
    }
    let split = p.insurance_bps as u32 + p.keeper_bps as u32 + p.protocol_bps as u32;
    if split > 10_000 {
        return Err(format!("fee split {split} bps exceeds 10000"));
    }
    if p.weights_bps.iter().map(|w| *w as u64).sum::<u64>() != 10_000 {
        return Err("weights_bps must sum to 10000".into());
    }
    if !p.offsets_bps.windows(2).all(|w| w[0] < w[1]) {
        return Err("offsets_bps must be strictly increasing".into());
    }
    if p.expiry_slots <= p.grace_slots {
        return Err("expiry_slots must exceed grace_slots".into());
    }
    if p.min_spread_bps > p.max_spread_bps {
        return Err("min_spread_bps must be <= max_spread_bps".into());
    }
    if p.utilization_max_bps > 8_000 {
        return Err("utilization_max_bps must be <= 8000 (0.8 of reserves)".into());
    }
    Ok(())
}

fn init_params(file: &InitVaultFile) -> Result<arbswap::InitParams, String> {
    let p = &file.params;
    Ok(arbswap::InitParams {
        base_mint: parse_pk(&file.base_mint)?,
        quote_mint: parse_pk(&file.quote_mint)?,
        keeper: parse_pk(&p.keeper)?,
        treasury: parse_pk(&p.treasury)?,
        pyth_feed_id: hex32(&p.pyth_feed_id_hex)?,
        fee_bps: p.fee_bps,
        insurance_bps: p.insurance_bps,
        keeper_bps: p.keeper_bps,
        protocol_bps: p.protocol_bps,
        min_liquidity: p.min_liquidity,
        warmup_slots: p.warmup_slots,
        epoch_slots: p.epoch_slots,
        grace_slots: p.grace_slots,
        expiry_slots: p.expiry_slots,
        max_staleness_seconds: p.max_staleness_seconds,
        max_conf_bps: p.max_conf_bps,
        max_anchor_step_bps: p.max_anchor_step_bps,
        max_spread_step_bps: p.max_spread_step_bps,
        min_spread_bps: p.min_spread_bps,
        max_spread_bps: p.max_spread_bps,
        max_quote_size: p.max_quote_size,
        max_inventory_bps: p.max_inventory_bps,
        utilization_max_bps: p.utilization_max_bps,
        min_bond: p.min_bond,
        unbond_cooldown_slots: p.unbond_cooldown_slots,
        max_update_slot_age: p.max_update_slot_age,
        edge_window_slots: p.edge_window_slots,
        max_edge_loss_bps: p.max_edge_loss_bps,
        max_anchor_dev_bps: p.max_anchor_dev_bps,
        flow_window_slots: p.flow_window_slots,
        max_window_flow_bps: p.max_window_flow_bps,
        offsets_bps: p.offsets_bps,
        weights_bps: p.weights_bps,
    })
}

/// Derive every PDA from the source-defined seeds.
pub fn derive_pdas(
    program_id: Address,
    base_mint: Address,
    quote_mint: Address,
) -> (Address, Address, Address, Address) {
    let (vault, _) = Address::find_program_address(
        &[b"vault", base_mint.as_ref(), quote_mint.as_ref()],
        &program_id,
    );
    let (config, _) = Address::find_program_address(&[b"config", vault.as_ref()], &program_id);
    let (quote_state, _) = Address::find_program_address(&[b"quote", vault.as_ref()], &program_id);
    let (program_config, _) = Address::find_program_address(&[b"program"], &program_id);
    (vault, config, quote_state, program_config)
}

/// Build the raw instruction plus the ordered signer keys (admin + 4 init keys).
pub fn build_instruction(
    file: &InitVaultFile,
    signers: &InitSigners,
) -> Result<(Instruction, Vec<Address>), String> {
    validate(file)?;
    let program_id = parse_pk(&file.program_id)?;
    let base_mint = parse_pk(&file.base_mint)?;
    let quote_mint = parse_pk(&file.quote_mint)?;
    let params = init_params(file)?;
    let (vault, config, quote_state, program_config) =
        derive_pdas(program_id, base_mint, quote_mint);

    let accounts = arbswap::accounts::InitializeVault {
        admin: signers.admin,
        program_config,
        vault,
        config,
        quote_state,
        base_mint,
        quote_mint,
        base_reserve: signers.base_reserve,
        quote_reserve: signers.quote_reserve,
        share_mint: signers.share_mint,
        share_lock: signers.share_lock,
        token_program: parse_pk(TOKEN_ID)?,
        system_program: parse_pk(SYSTEM_ID)?,
        rent: parse_pk(RENT_ID)?,
    };
    let ix = Instruction {
        program_id,
        accounts: accounts.to_account_metas(None),
        data: arbswap::instruction::InitializeVault { params }.data(),
    };
    Ok((
        ix,
        vec![
            signers.admin,
            signers.base_reserve,
            signers.quote_reserve,
            signers.share_mint,
            signers.share_lock,
        ],
    ))
}

/// Build the instruction payload + account list for `initialize_vault`.
pub fn build_plan(file: &InitVaultFile, signers: &InitSigners) -> Result<InitPlan, String> {
    let (ix, signer_keys) = build_instruction(file, signers)?;
    let base_mint = parse_pk(&file.base_mint)?;
    let quote_mint = parse_pk(&file.quote_mint)?;
    let (vault, config, quote_state, program_config) =
        derive_pdas(ix.program_id, base_mint, quote_mint);
    if ix.accounts.len() != ACCOUNT_NAMES.len() {
        return Err(format!(
            "expected {} accounts, got {}",
            ACCOUNT_NAMES.len(),
            ix.accounts.len()
        ));
    }
    let accounts: Vec<(String, String, bool, bool)> = ACCOUNT_NAMES
        .iter()
        .zip(ix.accounts.iter())
        .map(|(name, m)| {
            (
                name.to_string(),
                m.pubkey.to_string(),
                m.is_signer,
                m.is_writable,
            )
        })
        .collect();

    Ok(InitPlan {
        program_id: ix.program_id,
        vault,
        config,
        quote_state,
        program_config,
        accounts,
        signers: signer_keys.iter().map(|k| k.to_string()).collect(),
        data_hex: ix.data.iter().map(|b| format!("{b:02x}")).collect(),
    })
}

/// Expand a leading `~` or `$HOME` (keeps keypair paths outside the repo).
fn expand_path(p: &str) -> String {
    for prefix in ["~/", "$HOME/"] {
        if let Some(rest) = p.strip_prefix(prefix) {
            if let Ok(home) = std::env::var("HOME") {
                return format!("{home}/{rest}");
            }
        }
    }
    p.to_string()
}

/// Read a keypair JSON file (32-byte seed + pubkey), as written by `solana-keygen`.
pub fn read_keypair(path: &str) -> Result<Keypair, String> {
    let path = expand_path(path);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
    let bytes: Vec<u8> = serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
    if bytes.len() < 32 {
        return Err(format!("{path}: keypair too short"));
    }
    let seed: [u8; 32] = bytes[..32].try_into().unwrap();
    Ok(Keypair::new_from_array(seed))
}

/// Load a keypair from `path`, or generate one when no path is given.
pub fn load_or_generate(path: &Option<String>) -> Result<Keypair, String> {
    match path {
        Some(p) if Path::new(&expand_path(p)).exists() => read_keypair(p),
        Some(p) => Err(format!(
            "signer keypair {p} does not exist; remove the path to generate a fresh one"
        )),
        None => Ok(Keypair::new()),
    }
}

pub fn load_file(path: &str) -> Result<InitVaultFile, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;
    use solana_signer::Signer;

    const PROGRAM: &str = "2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm";
    const ADMIN: &str = "8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH";
    const TSOL: &str = "76XvqdSVi2LhYWgeWjx6E1V2c7oBeB6ndUEp6xC44jp2";
    const TUSDC: &str = "q3xHxvxCBvYCMwuA6dFtTDHHwbqkrruTYWAWXdPuNFX";

    fn sample() -> InitVaultFile {
        InitVaultFile {
            rpc_url: "https://api.devnet.solana.com".into(),
            program_id: PROGRAM.into(),
            admin_keypair: "/tmp/none".into(),
            base_mint: TSOL.into(),
            quote_mint: TUSDC.into(),
            signer_keypairs: SignerPaths::default(),
            params: Params {
                keeper: ADMIN.into(),
                treasury: ADMIN.into(),
                pyth_feed_id_hex:
                    "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d".into(),
                fee_bps: 1,
                insurance_bps: 3333,
                keeper_bps: 3333,
                protocol_bps: 3334,
                min_liquidity: 1000,
                warmup_slots: 150,
                epoch_slots: 1500,
                grace_slots: 2,
                expiry_slots: 10,
                max_staleness_seconds: 2,
                max_conf_bps: 10,
                max_anchor_step_bps: 50,
                max_spread_step_bps: 10,
                min_spread_bps: 1,
                max_spread_bps: 50,
                max_quote_size: 100_000_000_000,
                max_inventory_bps: 2000,
                utilization_max_bps: 5000,
                min_bond: 0,
                unbond_cooldown_slots: 216_000,
                max_update_slot_age: 25,
                edge_window_slots: 216_000,
                max_edge_loss_bps: 50,
                max_anchor_dev_bps: 25,
                flow_window_slots: 216_000,
                max_window_flow_bps: 1000,
                offsets_bps: [2, 5, 10, 20, 40, 80],
                weights_bps: [1000, 1500, 2000, 2000, 2000, 1500],
            },
        }
    }

    fn signers() -> InitSigners {
        let k = |_: ()| Keypair::new();
        InitSigners {
            admin: ADMIN.parse().unwrap(),
            base_reserve: k(()).pubkey(),
            quote_reserve: k(()).pubkey(),
            share_mint: k(()).pubkey(),
            share_lock: k(()).pubkey(),
        }
    }

    #[test]
    fn derives_the_documented_pdas() {
        let s = signers();
        let plan = build_plan(&sample(), &s).unwrap();
        assert_eq!(
            plan.vault.to_string(),
            "52cNnsipn9R3P6Bcsf4vxSAM4k1gyyJpCoHcFyHCWCUK"
        );
        assert_eq!(
            plan.config.to_string(),
            "HhBCf2Xor5pgLBRP6SvkuiTL3G4j1i87hGNwx9GryZf8"
        );
        assert_eq!(
            plan.quote_state.to_string(),
            "4mSBaDguULxqxgr4riAtTxC4LjeXYVArNwCDvUT6hJtf"
        );
        assert_eq!(
            plan.program_config.to_string(),
            "J6MGfX1YvGq6yCP3eAqzbugpF83CTaBcTLKcmrxmBSok"
        );
    }

    #[test]
    fn payload_has_anchor_discriminator_and_five_signers() {
        let s = signers();
        let plan = build_plan(&sample(), &s).unwrap();
        let disc = &sha2::Sha256::digest(b"global:initialize_vault")[..8];
        let disc_hex: String = disc.iter().map(|b| format!("{b:02x}")).collect();
        assert!(
            plan.data_hex.starts_with(&disc_hex),
            "discriminator mismatch"
        );
        assert_eq!(plan.signers.len(), 5);
        // admin + 4 init keypairs must be flagged as signers in the metas.
        let signer_metas = plan
            .accounts
            .iter()
            .filter(|(_, _, is_signer, _)| *is_signer)
            .count();
        assert_eq!(signer_metas, 5);
    }

    #[test]
    fn rejects_invalid_configs() {
        let mut f = sample();
        f.quote_mint = TSOL.into();
        assert!(validate(&f).unwrap_err().contains("must differ"));

        let mut f = sample();
        f.params.weights_bps = [1, 1, 1, 1, 1, 1];
        assert!(validate(&f).unwrap_err().contains("weights_bps"));

        let mut f = sample();
        f.params.utilization_max_bps = 9_000;
        assert!(validate(&f).unwrap_err().contains("utilization_max_bps"));

        let mut f = sample();
        f.params.min_spread_bps = 60;
        assert!(validate(&f).unwrap_err().contains("min_spread_bps"));

        let mut f = sample();
        f.params.offsets_bps = [2, 2, 10, 20, 40, 80];
        assert!(validate(&f).unwrap_err().contains("strictly increasing"));

        let mut f = sample();
        f.params.pyth_feed_id_hex = "deadbeef".into();
        assert!(validate(&f).unwrap_err().contains("32-byte"));
    }

    #[test]
    fn generated_signers_do_not_touch_disk() {
        // load_or_generate(None) must not create files and returns a usable key.
        let kp = load_or_generate(&None).unwrap();
        assert!(!kp.pubkey().to_string().is_empty());
    }
}
