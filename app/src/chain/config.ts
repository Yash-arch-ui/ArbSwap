import { PublicKey } from '@solana/web3.js';
import { resolveFrontendRpc, redactRpcUrl } from './rpcConfig';

/**
 * Single source of truth for the ArbSwap deployment the app talks to.
 *
 * Everything (program id, cluster, mints, decimals, vault/account addresses,
 * oracle feed) lives here so pages and the chain client cannot drift out of
 * sync. See `docs/INTEGRATION.md` and `docs/PIPELINE.md`.
 *
 * The public demo reads the **canonical funded WSOL/USDC vault** on Devnet.
 * The older custom test-token vault (tSOL/tUSDC) is kept below, clearly
 * labelled, and is NOT used by the public demo.
 */

export type Cluster = 'devnet' | 'localnet' | 'mainnet-beta';

export interface VaultDeployment {
  /** Human label; shown in the UI where relevant. */
  label: string;
  /** True for the vault the public demo reads/writes. */
  canonical: boolean;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  shareDecimals: number;
  vault: PublicKey;
  config: PublicKey;
  quoteState: PublicKey;
  /** Pyth feed id (hex, no 0x) required by the deployed program. */
  pythFeedId: string;
}

/** RPC endpoints resolved from env (`VITE_SOLANA_RPC_URL[_FALLBACKS]`). */
const RPC = resolveFrontendRpc(
  ((import.meta as unknown as { env?: Record<string, string | undefined> }).env) ?? {},
);

/** Primary Devnet RPC used by the app and the wallet adapter. */
export const SOLANA_DEVNET_RPC = RPC.endpoints[0];
/** Optional read-only fallback endpoints (availability only). */
export const SOLANA_RPC_FALLBACKS = RPC.endpoints.slice(1);
export { redactRpcUrl };

export const CLUSTER: Cluster = RPC.cluster;

/**
 * Deployed ArbSwap program id (matches `vault/program/src/lib.rs`
 * `declare_id!`, `Anchor.toml`, and the committed IDL). Verified against the
 * live Devnet program and the preserved SBF artifact hash.
 */
export const ARBSWAP_PROGRAM_ID = new PublicKey('2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm');

/** Pyth SOL/USD feed id configured in the deployed vault `Config`. */
export const SOL_USD_FEED_ID =
  'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

/** Deployed program's oracle freshness requirement (seconds), from Config. */
export const MAX_STALENESS_SECONDS = 2;

/**
 * S2-32 read-only integration mode. The frontend is connected to real on-chain
 * and artifact data but must NOT submit transactions. Every action surface is
 * disabled and labelled. Set `VITE_ARBSWAP_READ_ONLY=0` only for a future,
 * explicitly-approved transaction-enabled build.
 */
export const READ_ONLY_MODE =
  ((import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_ARBSWAP_READ_ONLY ?? '1') !== '0';

/** Canonical Devnet genesis hash — verified before on-chain data is trusted. */
export const EXPECTED_GENESIS_HASH =
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/**
 * Canonical public-demo vault: WSOL / Circle Devnet USDC. Funded on Devnet
 * (deposit tx `3BEeTcuq…`); reserves and shares are read live, never assumed.
 */
export const CANONICAL_VAULT: VaultDeployment = {
  label: 'WSOL/USDC (canonical public demo)',
  canonical: true,
  baseMint: new PublicKey('So11111111111111111111111111111111111111112'),
  quoteMint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  baseDecimals: 9,
  quoteDecimals: 6,
  shareDecimals: 9,
  vault: new PublicKey('8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt'),
  config: new PublicKey('ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT'),
  quoteState: new PublicKey('5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG'),
  pythFeedId: SOL_USD_FEED_ID,
};

/**
 * Legacy custom test-token vault (tSOL/tUSDC). Kept for reference only and
 * explicitly NOT used by the public demo. Do not point pages at this vault
 * without an explicit decision and a funded reserve.
 */
export const LEGACY_TEST_VAULT: VaultDeployment = {
  label: 'tSOL/tUSDC (legacy custom test tokens — not used)',
  canonical: false,
  baseMint: new PublicKey('76XvqdSVi2LhYWgeWjx6E1V2c7oBeB6ndUEp6xC44jp2'),
  quoteMint: new PublicKey('q3xHxvxCBvYCMwuA6dFtTDHHwbqkrruTYWAWXdPuNFX'),
  baseDecimals: 9,
  quoteDecimals: 6,
  shareDecimals: 9,
  vault: new PublicKey('52cNnsipn9R3P6Bcsf4vxSAM4k1gyyJpCoHcFyHCWCUK'),
  config: new PublicKey('HhBCf2Xor5pgLBRP6SvkuiTL3G4j1i87hGNwx9GryZf8'),
  quoteState: new PublicKey('4mSBaDguULxqxgr4riAtTxC4LjeXYVArNwCDvUT6hJtf'),
  pythFeedId: SOL_USD_FEED_ID,
};

/** The vault the app reads and writes. */
export const ACTIVE_VAULT: VaultDeployment = CANONICAL_VAULT;

/** Base/quote mints for the active vault (convenience re-exports). */
export const BASE_MINT = ACTIVE_VAULT.baseMint;
export const QUOTE_MINT = ACTIVE_VAULT.quoteMint;

/** Devnet explorer link helpers. */
export function explorerTxUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}?cluster=devnet`;
}

export function explorerAddressUrl(address: string): string {
  return `https://solscan.io/account/${address}?cluster=devnet`;
}
