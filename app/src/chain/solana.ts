import { Connection, PublicKey } from '@solana/web3.js';

/** Devnet RPC used by the app and the wallet adapter. */
export const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com';

/**
 * Deployed ArbSwap program id (matches `vault/program/src/lib.rs` `declare_id!`
 * and `Anchor.toml`). Kept in sync with the deployed HEAD build.
 */
export const ARBSWAP_PROGRAM_ID = new PublicKey('2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm');

// Vault pair. These MUST match the deployed vault's configured base/quote
// mints. On this devnet deployment they are the ArbSwap test tokens
// (TEST TOKEN, devnet — worthless): tSOL (9 dp) / tUSDC (6 dp).
export const BASE_MINT = new PublicKey('76XvqdSVi2LhYWgeWjx6E1V2c7oBeB6ndUEp6xC44jp2'); // tSOL
export const QUOTE_MINT = new PublicKey('q3xHxvxCBvYCMwuA6dFtTDHHwbqkrruTYWAWXdPuNFX'); // tUSDC

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
 * Read the connected wallet's native SOL (fees), and the vault pair balances
 * (tSOL base / tUSDC quote — TEST TOKEN, devnet). Human units; missing accounts
 * read as 0.
 */
export async function loadWalletBalances(
  connection: Connection,
  owner: PublicKey,
): Promise<{ sol: number; base: number; quote: number }> {
  const LAMPORTS = 1_000_000_000;
  const sol = (await connection.getBalance(owner)) / LAMPORTS;
  const read = async (mint: PublicKey): Promise<number> => {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { mint });
    const amount = res.value[0]?.account.data.parsed.info.tokenAmount.uiAmount;
    return amount ?? 0;
  };
  const [base, quote] = await Promise.all([read(BASE_MINT), read(QUOTE_MINT)]);
  return { sol, base, quote };
}
