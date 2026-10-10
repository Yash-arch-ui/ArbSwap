import { Connection, PublicKey } from '@solana/web3.js';

/** Devnet RPC used by the app and the wallet adapter. */
export const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com';

/**
 * Deployed ArbSwap program id (matches `vault/program/src/lib.rs` `declare_id!`
 * and `Anchor.toml`). Kept in sync with the deployed HEAD build.
 */
export const ARBSWAP_PROGRAM_ID = new PublicKey('2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm');

// Mints the vault trades. On devnet these must match the vault's configured
// base/quote mints; the defaults below are the canonical devnet SOL/USDC.
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

export interface ArbSwapConfig {
  programId: PublicKey;
  cluster: 'devnet' | 'mainnet-beta' | 'localnet';
  pythFeedId: string;
}

export const ARBSWAP_CONFIG: ArbSwapConfig = {
  programId: ARBSWAP_PROGRAM_ID,
  cluster: 'devnet',
  pythFeedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', // SOL/USD feed
};

/**
 * Read the connected wallet's SOL, wrapped-SOL and USDC balances over RPC.
 * Returns human units (not lamports/atoms). Missing token accounts read as 0.
 */
export async function loadWalletBalances(
  connection: Connection,
  owner: PublicKey,
): Promise<{ sol: number; wsol: number; usdc: number }> {
  const LAMPORTS = 1_000_000_000;
  const sol = (await connection.getBalance(owner)) / LAMPORTS;
  const read = async (mint: PublicKey): Promise<number> => {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { mint });
    const amount = res.value[0]?.account.data.parsed.info.tokenAmount.uiAmount;
    return amount ?? 0;
  };
  const [wsol, usdc] = await Promise.all([read(WSOL_MINT), read(USDC_MINT)]);
  return { sol, wsol, usdc };
}
