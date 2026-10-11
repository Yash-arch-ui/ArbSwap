import { Connection, PublicKey } from '@solana/web3.js';

/** Devnet RPC used by the app and the wallet adapter. */
export const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com';

/** Deployed ArbSwap program id (`vault/program/src/lib.rs` declare_id). */
export const ARBSWAP_PROGRAM_ID = new PublicKey('2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm');

// Vault pair — MUST match the deployed vault's configured base/quote mints.
// On this deployment they are the ArbSwap TEST TOKENs (devnet, worthless):
// tSOL (9 dp) / tUSDC (6 dp).
export const BASE_MINT = new PublicKey('76XvqdSVi2LhYWgeWjx6E1V2c7oBeB6ndUEp6xC44jp2'); // tSOL
export const QUOTE_MINT = new PublicKey('q3xHxvxCBvYCMwuA6dFtTDHHwbqkrruTYWAWXdPuNFX'); // tUSDC

// Standard mints (kept for reference/faucets; not the vault pair).
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

/** Pyth SOL/USD price feed id (verified; devnet receiver `rec5EKMGg6…`). */
export const PYTH_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

/** All vault PDAs, derived from the pair (never hardcoded). */
export function deriveVaultAddresses(baseMint = BASE_MINT, quoteMint = QUOTE_MINT) {
  const programId = ARBSWAP_PROGRAM_ID;
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), baseMint.toBuffer(), quoteMint.toBuffer()], programId);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config'), vault.toBuffer()], programId);
  const [quoteState] = PublicKey.findProgramAddressSync([Buffer.from('quote'), vault.toBuffer()], programId);
  const [bondVault] = PublicKey.findProgramAddressSync([Buffer.from('bond'), vault.toBuffer()], programId);
  const [programConfig] = PublicKey.findProgramAddressSync([Buffer.from('program')], programId);
  return { programId, vault, config, quoteState, bondVault, programConfig };
}

export const {
  vault: ARBSWAP_VAULT_PUBKEY,
  config: CONFIG_PDA,
  quoteState: QUOTE_STATE_PDA,
  programConfig: PROGRAM_CONFIG_PDA,
} = deriveVaultAddresses();

export const ARBSWAP_CHAIN_CONFIG = {
  programId: ARBSWAP_PROGRAM_ID,
  vaultPubkey: ARBSWAP_VAULT_PUBKEY,
  quotePda: QUOTE_STATE_PDA,
  configPda: CONFIG_PDA,
  cluster: 'devnet' as const,
  pythFeedId: PYTH_FEED_ID,
};

export const solanaConnection = new Connection(SOLANA_DEVNET_RPC, { commitment: 'confirmed' });

export function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

/** Native SOL (fees) + vault-pair balances (TEST TOKEN, devnet). */
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

/** LP share balance for a given share mint (0 if the ATA does not exist). */
export async function loadShareBalance(
  connection: Connection,
  owner: PublicKey,
  shareMint: PublicKey,
): Promise<number> {
  try {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { mint: shareMint });
    const amount = res.value[0]?.account.data.parsed.info.tokenAmount.uiAmount;
    return amount ?? 0;
  } catch {
    return 0;
  }
}
