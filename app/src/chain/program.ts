import { AnchorProvider, Program, BN } from '@coral-xyz/anchor';
import type { Wallet } from '@coral-xyz/anchor/dist/cjs/provider';
import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import idl from '../idl/arbswap.json';
import { ARBSWAP_PROGRAM_ID, WSOL_MINT, USDC_MINT } from './solana';

export const PROGRAM_ID = ARBSWAP_PROGRAM_ID;
const SYSTEM_PROGRAM_ID = SystemProgram.programId;

/** Anchor program bound to a connection + wallet. */
export function getProgram(connection: Connection, wallet: Wallet): Program {
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  return new Program(idl as never, provider);
}

/** All PDA addresses for the canonical devnet WSOL/USDC vault. */
export function deriveVaultAddresses(baseMint = WSOL_MINT, quoteMint = USDC_MINT) {
  const programId = PROGRAM_ID;
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), baseMint.toBuffer(), quoteMint.toBuffer()],
    programId,
  );
  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config'), vault.toBuffer()], programId);
  const [quoteState] = PublicKey.findProgramAddressSync([Buffer.from('quote'), vault.toBuffer()], programId);
  const [bondVault] = PublicKey.findProgramAddressSync([Buffer.from('bond'), vault.toBuffer()], programId);
  const [programConfig] = PublicKey.findProgramAddressSync([Buffer.from('program')], programId);
  return { programId, vault, config, quoteState, bondVault, programConfig };
}

export function depositTicket(vault: PublicKey, user: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('dep'), vault.toBuffer(), user.toBuffer()], PROGRAM_ID)[0];
}
export function withdrawTicket(vault: PublicKey, user: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('wd'), vault.toBuffer(), user.toBuffer()], PROGRAM_ID)[0];
}

export interface OnChainProtocolState {
  exists: boolean;
  vault: PublicKey;
  config: PublicKey;
  quoteState: PublicKey;
  vaultData?: {
    baseMint: PublicKey; quoteMint: PublicKey;
    baseReserve: PublicKey; quoteReserve: PublicKey;
    shareMint: PublicKey; shareLock: PublicKey;
    totalShares: BN; status: number;
  };
  quoteData?: {
    version: BN; updateSlot: BN; expirySlot: BN;
    halfSpreadBps: number; depthMultBps: number;
    oraclePrice: BN; anchorSqrtPrice: BN; pResSqrt: BN;
    askLevels: unknown[]; bidLevels: unknown[];
  };
}

/** Fetch the vault/config/quote-state accounts for the WSOL/USDC vault. */
export async function fetchProtocolState(
  connection: Connection,
  baseMint = WSOL_MINT,
  quoteMint = USDC_MINT,
): Promise<OnChainProtocolState> {
  const { vault, config, quoteState } = deriveVaultAddresses(baseMint, quoteMint);
  const program = new Program(idl as never, new AnchorProvider(
    connection,
    { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t } as never,
    { commitment: 'confirmed' },
  ));
  const info = await connection.getAccountInfo(vault);
  if (!info) return { exists: false, vault, config, quoteState };
  const v = await program.account.vault.fetch(vault) as Record<string, never>;
  let quoteData: OnChainProtocolState['quoteData'];
  try {
    const q = await program.account.quoteState.fetch(quoteState) as Record<string, never>;
    quoteData = {
      version: q.version as BN, updateSlot: q.updateSlot as BN, expirySlot: q.expirySlot as BN,
      halfSpreadBps: q.halfSpreadBps as number, depthMultBps: q.depthMultBps as number,
      oraclePrice: q.oraclePrice as BN, anchorSqrtPrice: q.anchorSqrtPrice as BN, pResSqrt: q.pResSqrt as BN,
      askLevels: q.askLevels as unknown[], bidLevels: q.bidLevels as unknown[],
    };
  } catch { /* quote state not written yet */ }
  return {
    exists: true, vault, config, quoteState,
    vaultData: {
      baseMint: v.baseMint as unknown as PublicKey, quoteMint: v.quoteMint as unknown as PublicKey,
      baseReserve: v.baseReserve as unknown as PublicKey, quoteReserve: v.quoteReserve as unknown as PublicKey,
      shareMint: v.shareMint as unknown as PublicKey, shareLock: v.shareLock as unknown as PublicKey,
      totalShares: v.totalShares as unknown as BN, status: v.status as unknown as number,
    },
    quoteData,
  };
}

async function ensureAta(connection: Connection, wallet: Wallet, mint: PublicKey, owner: PublicKey) {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const info = await connection.getAccountInfo(ata);
  return { ata, needsCreate: !info };
}

/** Build + send a `deposit` (both tokens) and return the signature. */
export async function deposit(
  connection: Connection, wallet: Wallet, baseAmount: bigint, quoteAmount: bigint, minShares = 1n,
): Promise<string> {
  const program = getProgram(connection, wallet);
  const { vault, config } = deriveVaultAddresses();
  const owner = wallet.publicKey;
  const state = await fetchProtocolState(connection);
  if (!state.vaultData) throw new Error('vault not initialized (no state for WSOL/USDC)');
  const userBase = (await ensureAta(connection, wallet, WSOL_MINT, owner)).ata;
  const userQuote = (await ensureAta(connection, wallet, USDC_MINT, owner)).ata;
  const userShares = getAssociatedTokenAddressSync(state.vaultData.shareMint, owner);
  return program.methods
    .deposit(new BN(baseAmount.toString()), new BN(quoteAmount.toString()), new BN(minShares.toString()))
    .accounts({
      user: owner, vault, config,
      baseReserve: state.vaultData.baseReserve, quoteReserve: state.vaultData.quoteReserve,
      shareMint: state.vaultData.shareMint, shareLock: state.vaultData.shareLock,
      userBase, userQuote, userShares,
      depositTicket: depositTicket(vault, owner),
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SYSTEM_PROGRAM_ID,
    })
    .rpc();
}

export type SwapSide = { buyBase: Record<string, never> } | { sellBase: Record<string, never> };

/** Build + send a `swap`. `side` is `{ buyBase: {} }` or `{ sellBase: {} }`. */
export async function swap(
  connection: Connection, wallet: Wallet, side: SwapSide,
  amountIn: bigint, minOut: bigint, minVersion: bigint,
): Promise<string> {
  const program = getProgram(connection, wallet);
  const { vault, config, quoteState } = deriveVaultAddresses();
  const owner = wallet.publicKey;
  const state = await fetchProtocolState(connection);
  if (!state.vaultData) throw new Error('vault not initialized (no state for WSOL/USDC)');
  const traderBase = (await ensureAta(connection, wallet, WSOL_MINT, owner)).ata;
  const traderQuote = (await ensureAta(connection, wallet, USDC_MINT, owner)).ata;
  return program.methods
    .swap(side as never, new BN(amountIn.toString()), new BN(minOut.toString()), new BN(minVersion.toString()))
    .accounts({
      trader: owner, vault, config, quoteState,
      baseReserve: state.vaultData.baseReserve, quoteReserve: state.vaultData.quoteReserve,
      traderBase, traderQuote, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

export async function crankEpoch(connection: Connection, wallet: Wallet): Promise<string> {
  const program = getProgram(connection, wallet);
  const { vault, config } = deriveVaultAddresses();
  return program.methods.crankEpoch().accounts({ vault, config }).rpc();
}

/** Queue a withdrawal (shares) for the next epoch. */
export async function requestWithdraw(
  connection: Connection, wallet: Wallet, shares: bigint,
): Promise<string> {
  const program = getProgram(connection, wallet);
  const { vault } = deriveVaultAddresses();
  const owner = wallet.publicKey;
  const state = await fetchProtocolState(connection);
  if (!state.vaultData) throw new Error('vault not initialized (no state for WSOL/USDC)');
  const userShares = getAssociatedTokenAddressSync(state.vaultData.shareMint, owner);
  return program.methods
    .requestWithdraw(new BN(shares.toString()))
    .accounts({
      user: owner, vault, shareLock: state.vaultData.shareLock,
      depositTicket: depositTicket(vault, owner), userShares,
      withdrawTicket: withdrawTicket(vault, owner),
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SYSTEM_PROGRAM_ID,
    })
    .rpc();
}

/** Claim a settled withdrawal for the current epoch. */
export async function claimWithdraw(connection: Connection, wallet: Wallet): Promise<string> {
  const program = getProgram(connection, wallet);
  const { vault } = deriveVaultAddresses();
  const owner = wallet.publicKey;
  const state = await fetchProtocolState(connection);
  if (!state.vaultData) throw new Error('vault not initialized (no state for WSOL/USDC)');
  const userBase = getAssociatedTokenAddressSync(WSOL_MINT, owner);
  const userQuote = getAssociatedTokenAddressSync(USDC_MINT, owner);
  return program.methods
    .claimWithdraw()
    .accounts({
      user: owner, vault,
      baseReserve: state.vaultData.baseReserve, quoteReserve: state.vaultData.quoteReserve,
      shareMint: state.vaultData.shareMint, shareLock: state.vaultData.shareLock,
      withdrawTicket: withdrawTicket(vault, owner), userBase, userQuote,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

export { BN };
