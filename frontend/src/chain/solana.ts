import { Connection, PublicKey } from '@solana/web3.js';
import type { QuoteState, VaultState } from '../types/protocol';
import { INITIAL_QUOTE_STATE } from '../data/mockData';

/** Devnet RPC used by the app and the wallet adapter. */
export const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com';

// ── Canonical Deployed Addresses on Solana Devnet (docs/DEVNET.md) ──────────
// Program id updated in commit 2a71c37 (2026-10-10) — old id CCR33… was closed/unreusable.
export const ARBSWAP_PROGRAM_ID = new PublicKey('2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm');
export const ARBSWAP_VAULT_PUBKEY = new PublicKey('8pubuchUdm9vmnXhxCRie32phFuDiiGi3skCa5okg4qU');
export const ARBSWAP_BASE_MINT = new PublicKey('Aiv3cxvMCrKq3VadsV9o72pHbuNKseN1jHF56QuGyWSc');
export const ARBSWAP_QUOTE_MINT = new PublicKey('EwGBJg2XqVYcPVnNDfvt5dSZwsFXL4meaMoFgK6FCz6a');

// Standard mints — WSOL is the canonical wrapped-SOL; USDC uses the devnet SPL token.
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
// LP share mint issued by initialize_vault (docs/DEVNET.md)
export const ARBSWAP_SHARE_MINT = new PublicKey('CtJyzcABFoFSihErnZMBp2BupkSMupkbbvYsfMzxJ4M3');

// Derived PDAs
export const [QUOTE_STATE_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from('quote'), ARBSWAP_VAULT_PUBKEY.toBuffer()],
  ARBSWAP_PROGRAM_ID
);

export const [CONFIG_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from('config'), ARBSWAP_VAULT_PUBKEY.toBuffer()],
  ARBSWAP_PROGRAM_ID
);

export const [PROGRAM_CONFIG_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from('program')],
  ARBSWAP_PROGRAM_ID
);

export interface ArbSwapChainConfig {
  programId: PublicKey;
  vaultPubkey: PublicKey;
  quotePda: PublicKey;
  configPda: PublicKey;
  cluster: 'devnet' | 'mainnet-beta' | 'localnet';
  pythFeedId: string;
}

export const ARBSWAP_CHAIN_CONFIG: ArbSwapChainConfig = {
  programId: ARBSWAP_PROGRAM_ID,
  vaultPubkey: ARBSWAP_VAULT_PUBKEY,
  quotePda: QUOTE_STATE_PDA,
  configPda: CONFIG_PDA,
  cluster: 'devnet',
  pythFeedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', // SOL/USD Pyth feed
};

export const solanaConnection = new Connection(SOLANA_DEVNET_RPC, {
  commitment: 'confirmed',
});

// ── On-chain Binary Account Decoders ────────────────────────────────────────

export function decodeOnChainVault(buf: Buffer): Partial<VaultState> {
  if (buf.length < 306) return {};
  try {
    const totalShares = Number(buf.readBigUInt64LE(232));
    const insuranceQuote = Number(buf.readBigUInt64LE(248)) / 1e6;
    const keeperQuote = Number(buf.readBigUInt64LE(264)) / 1e6;
    const protocolQuote = Number(buf.readBigUInt64LE(280)) / 1e6;
    const epoch = Number(buf.readBigUInt64LE(288));
    const status = buf.readUInt8(304);

    return {
      totalShares,
      epoch,
      insuranceBufferUsd: insuranceQuote,
      keeperPoolUsd: keeperQuote,
      protocolFeesUsd: protocolQuote,
      status: status === 0 ? 'Active' : 'Paused', // ACTIVE = 0 in Anchor program
    };
  } catch (err) {
    console.warn('Failed to parse on-chain Vault buffer:', err);
    return {};
  }
}

export function decodeOnChainQuote(buf: Buffer, currentSlot: number): Partial<QuoteState> {
  if (buf.length < 120) return {};
  try {
    const version = Number(buf.readBigUInt64LE(8));
    const updateSlot = Number(buf.readBigUInt64LE(16));
    const expirySlot = Number(buf.readBigUInt64LE(24));
    const halfSpreadBps = buf.readUInt32LE(64);
    const askExtraBps = buf.readUInt32LE(68);
    const bidExtraBps = buf.readUInt32LE(72);
    const oraclePublishTime = Number(buf.readBigInt64LE(104));
    const oracleConfBps = buf.readUInt32LE(112);

    const isAging = currentSlot >= expirySlot;

    return {
      version: version > 0 ? version : INITIAL_QUOTE_STATE.version,
      updateSlot,
      expirySlot,
      halfSpreadBps: halfSpreadBps > 0 ? halfSpreadBps : 2.41,
      askExtraBps,
      bidExtraBps,
      oraclePublishTime,
      oracleConfBps: oracleConfBps > 0 ? oracleConfBps : 1.8,
      status: isAging ? 'Aging' : 'Fresh',
    };
  } catch (err) {
    console.warn('Failed to parse on-chain QuoteState buffer:', err);
    return {};
  }
}

export async function fetchLiveDevnetState(): Promise<{
  slot: number;
  vaultPartial: Partial<VaultState>;
  quotePartial: Partial<QuoteState>;
  isLive: boolean;
}> {
  try {
    const [slot, accounts] = await Promise.all([
      solanaConnection.getSlot(),
      solanaConnection.getMultipleAccountsInfo([ARBSWAP_VAULT_PUBKEY, QUOTE_STATE_PDA]),
    ]);

    const vaultInfo = accounts[0];
    const quoteInfo = accounts[1];

    const vaultPartial = vaultInfo ? decodeOnChainVault(Buffer.from(vaultInfo.data)) : {};
    const quotePartial = quoteInfo ? decodeOnChainQuote(Buffer.from(quoteInfo.data), slot) : {};

    return {
      slot,
      vaultPartial,
      quotePartial,
      isLive: Boolean(vaultInfo && quoteInfo),
    };
  } catch (err) {
    console.warn('Devnet RPC unavailable or rate-limited; utilizing local verified state:', err);
    return {
      slot: 509530267,
      vaultPartial: {},
      quotePartial: {},
      isLive: false,
    };
  }
}

// ── Transaction Instruction Builders ─────────────────────────────────────────

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ARBSWAP_BASE_RESERVE = new PublicKey('2dXz913D7GQ8YrR9yaAh4ekdVrrsDvg53ykjwMc1L4SM');
export const ARBSWAP_QUOTE_RESERVE = new PublicKey('9LzJ9u7yJs4rhpF8gN9sfxuKo4EnoXc85GtABiinQYiS');

export interface SwapParams {
  trader: PublicKey;
  traderBaseTokenAccount?: PublicKey;
  traderQuoteTokenAccount?: PublicKey;
  side: 'buyBase' | 'sellBase';
  amountInUnits: number;
  minOutUnits: number;
  minVersion: number;
}

export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return address;
}

export function buildSwapInstruction(params: SwapParams): {
  programId: PublicKey;
  keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
  data: Buffer;
} {
  // Discriminator: sha256("global:swap")[0..8] = f8c69e91e17587c8
  const disc = Buffer.from('f8c69e91e17587c8', 'hex');
  const data = Buffer.alloc(8 + 1 + 8 + 8 + 8);
  disc.copy(data, 0);
  data.writeUInt8(params.side === 'buyBase' ? 0 : 1, 8);
  data.writeBigUInt64LE(BigInt(Math.max(1, Math.floor(params.amountInUnits))), 9);
  data.writeBigUInt64LE(BigInt(Math.max(1, Math.floor(params.minOutUnits))), 17);
  data.writeBigUInt64LE(BigInt(params.minVersion), 25);

  const traderBase = params.traderBaseTokenAccount || getAssociatedTokenAddress(ARBSWAP_BASE_MINT, params.trader);
  const traderQuote = params.traderQuoteTokenAccount || getAssociatedTokenAddress(ARBSWAP_QUOTE_MINT, params.trader);

  return {
    programId: ARBSWAP_PROGRAM_ID,
    keys: [
      { pubkey: params.trader, isSigner: true, isWritable: true },
      { pubkey: ARBSWAP_VAULT_PUBKEY, isSigner: false, isWritable: true },
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
      { pubkey: QUOTE_STATE_PDA, isSigner: false, isWritable: true },
      { pubkey: ARBSWAP_BASE_RESERVE, isSigner: false, isWritable: true },
      { pubkey: ARBSWAP_QUOTE_RESERVE, isSigner: false, isWritable: true },
      { pubkey: traderBase, isSigner: false, isWritable: true },
      { pubkey: traderQuote, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  };
}

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

/**
 * Read the connected wallet's ArbSwap LP share balance over RPC.
 * Returns human units (0 if no account exists).
 */
export async function loadShareBalance(
  connection: Connection,
  owner: PublicKey,
): Promise<number> {
  try {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { mint: ARBSWAP_SHARE_MINT });
    const amount = res.value[0]?.account.data.parsed.info.tokenAmount.uiAmount;
    return amount ?? 0;
  } catch {
    return 0;
  }
}
