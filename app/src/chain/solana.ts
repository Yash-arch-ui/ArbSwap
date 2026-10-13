import { Connection, PublicKey } from '@solana/web3.js';
import {
  ACTIVE_VAULT,
  ARBSWAP_PROGRAM_ID,
  BASE_MINT,
  CLUSTER,
  QUOTE_MINT,
} from './config';

export {
  SOLANA_DEVNET_RPC,
  ARBSWAP_PROGRAM_ID,
  BASE_MINT,
  QUOTE_MINT,
  ACTIVE_VAULT,
  CLUSTER,
  CANONICAL_VAULT,
  LEGACY_TEST_VAULT,
  SOL_USD_FEED_ID,
  MAX_STALENESS_SECONDS,
  explorerTxUrl,
  explorerAddressUrl,
} from './config';

export interface ArbSwapConfig {
  programId: PublicKey;
  cluster: 'devnet' | 'mainnet-beta' | 'localnet';
  pythFeedId: string;
}

export const ARBSWAP_CONFIG: ArbSwapConfig = {
  programId: ARBSWAP_PROGRAM_ID,
  cluster: CLUSTER,
  pythFeedId: ACTIVE_VAULT.pythFeedId,
};

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/** Base/quote human symbols for the active vault. */
export const BASE_SYMBOL = ACTIVE_VAULT.baseMint.equals(new PublicKey(WSOL_MINT))
  ? 'WSOL'
  : 'BASE';
export const QUOTE_SYMBOL = ACTIVE_VAULT.quoteMint.equals(new PublicKey(USDC_MINT))
  ? 'USDC'
  : 'QUOTE';

/**
 * Read the connected wallet's native SOL (for fees), and the active vault pair
 * balances. Human units, for display only; transaction amounts use integer
 * atoms (see `amounts.ts`). Missing accounts read as 0. Raw atom balances are
 * returned too, so guards (e.g. "do you actually hold enough WSOL?") can use
 * exact integers rather than rounded display values.
 */
export async function loadWalletBalances(
  connection: Connection,
  owner: PublicKey,
): Promise<{ sol: number; base: number; quote: number; baseAtoms: bigint; quoteAtoms: bigint }> {
  const LAMPORTS = 1_000_000_000;
  const sol = (await connection.getBalance(owner)) / LAMPORTS;
  const read = async (mint: PublicKey): Promise<{ ui: number; atoms: bigint }> => {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { mint });
    const info = res.value[0]?.account.data.parsed.info.tokenAmount;
    return { ui: info?.uiAmount ?? 0, atoms: BigInt(info?.amount ?? '0') };
  };
  const [base, quote] = await Promise.all([read(BASE_MINT), read(QUOTE_MINT)]);
  return { sol, base: base.ui, quote: quote.ui, baseAtoms: base.atoms, quoteAtoms: quote.atoms };
}
