import { AnchorProvider, Program, BN } from '@coral-xyz/anchor';
import type { Wallet } from '@coral-xyz/anchor/dist/cjs/provider';
import { Buffer } from 'buffer';
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import idl from '../idl/arbswap.json';
import { ARBSWAP_PROGRAM_ID, BASE_MINT, QUOTE_MINT, deriveVaultAddresses } from './solana';

export const PROGRAM_ID = ARBSWAP_PROGRAM_ID;
const SYSTEM_PROGRAM_ID = SystemProgram.programId;

/** Anchor program bound to a connection + wallet adapter. */
export function getProgram(connection: Connection, wallet: unknown): Program {
  const provider = new AnchorProvider(connection, wallet as Wallet, { commitment: 'confirmed' });
  return new Program(idl as never, provider);
}

interface AccountFetcher {
  fetch(address: PublicKey): Promise<Record<string, unknown>>;
}
function accounts(program: Program): Record<string, AccountFetcher> {
  return program.account as unknown as Record<string, AccountFetcher>;
}

export interface OnChainLevel {
  offsetBps: number;
  weightBps: number;
  sqrtLo: BN;
  sqrtHi: BN;
  liquidity: BN;
}

export interface OnChainVault {
  admin: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseReserve: PublicKey;
  quoteReserve: PublicKey;
  shareMint: PublicKey;
  shareLock: PublicKey;
  totalShares: BN;
  epoch: BN;
  epochStart: BN;
  status: number;
  insuranceBase: BN;
  insuranceQuote: BN;
  keeperBase: BN;
  keeperQuote: BN;
  protocolBase: BN;
  protocolQuote: BN;
  baseReserveAmount: BN;
  quoteReserveAmount: BN;
}

export interface OnChainQuote {
  version: BN;
  updateSlot: BN;
  expirySlot: BN;
  halfSpreadBps: number;
  askExtraBps: number;
  bidExtraBps: number;
  depthMultBps: number;
  oraclePrice: BN;
  anchorSqrtPrice: BN;
  pResSqrt: BN;
  oraclePublishTime: BN;
  oracleConfBps: number;
  askLevels: OnChainLevel[];
  bidLevels: OnChainLevel[];
}

export interface OnChainConfig {
  keeper: PublicKey;
  treasury: PublicKey;
  feeBps: number;
  minSpreadBps: number;
  maxSpreadBps: number;
  maxStalenessSeconds: BN;
  maxConfBps: number;
  maxAnchorStepBps: number;
  maxInventoryBps: number;
  utilizationMaxBps: number;
  minBond: BN;
  warmupSlots: BN;
  epochSlots: BN;
  graceSlots: BN;
  expirySlots: BN;
  maxEdgeLossBps: number;
  flowWindowSlots: BN;
  maxWindowFlowBps: number;
}

export interface OnChainProtocolState {
  exists: boolean;
  vault: PublicKey;
  config: PublicKey;
  quoteState: PublicKey;
  vaultData?: OnChainVault;
  quoteData?: OnChainQuote;
  configData?: OnChainConfig;
}

/**
 * Fetch + decode the vault/config/quote-state accounts for the configured pair.
 * NOTE: `program.account.*.fetch` returns Anchor-normalised camelCase fields.
 * Returns `exists:false` (no fabricated values) when there is no vault.
 */
export async function fetchProtocolState(
  connection: Connection,
  baseMint = BASE_MINT,
  quoteMint = QUOTE_MINT,
): Promise<OnChainProtocolState> {
  const { vault, config, quoteState } = deriveVaultAddresses(baseMint, quoteMint);
  const readOnlyWallet = {
    publicKey: PublicKey.default,
    signTransaction: async (t: unknown) => t,
    signAllTransactions: async (t: unknown[]) => t,
  };
  const program = new Program(idl as never, new AnchorProvider(
    connection, readOnlyWallet as unknown as Wallet, { commitment: 'confirmed' }));
  if (!(await connection.getAccountInfo(vault))) {
    return { exists: false, vault, config, quoteState };
  }

  const v = (await accounts(program).vault.fetch(vault)) as Record<string, unknown>;
  const baseReserve = v.baseReserve as PublicKey;
  const quoteReserve = v.quoteReserve as PublicKey;
  const readAmount = async (acct: PublicKey): Promise<BN> => {
    try {
      return new BN((await connection.getTokenAccountBalance(acct)).value.amount);
    } catch {
      return new BN(0);
    }
  };
  const [baseReserveAmount, quoteReserveAmount] = await Promise.all([
    readAmount(baseReserve), readAmount(quoteReserve),
  ]);
  const vaultData: OnChainVault = {
    admin: v.admin as PublicKey,
    baseMint: v.baseMint as PublicKey,
    quoteMint: v.quoteMint as PublicKey,
    baseReserve, quoteReserve,
    shareMint: v.shareMint as PublicKey,
    shareLock: v.shareLock as PublicKey,
    totalShares: v.totalShares as BN,
    epoch: v.epoch as BN,
    epochStart: v.epochStart as BN,
    status: v.status as number,
    insuranceBase: v.insuranceBase as BN,
    insuranceQuote: v.insuranceQuote as BN,
    keeperBase: v.keeperBase as BN,
    keeperQuote: v.keeperQuote as BN,
    protocolBase: v.protocolBase as BN,
    protocolQuote: v.protocolQuote as BN,
    baseReserveAmount, quoteReserveAmount,
  };

  let quoteData: OnChainQuote | undefined;
  try {
    const q = (await accounts(program).quoteState.fetch(quoteState)) as Record<string, unknown>;
    quoteData = {
      version: q.version as BN,
      updateSlot: q.updateSlot as BN,
      expirySlot: q.expirySlot as BN,
      halfSpreadBps: q.halfSpreadBps as number,
      askExtraBps: q.askExtraBps as number,
      bidExtraBps: q.bidExtraBps as number,
      depthMultBps: q.depthMultBps as number,
      oraclePrice: q.oraclePrice as BN,
      anchorSqrtPrice: q.anchorSqrtPrice as BN,
      pResSqrt: q.pResSqrt as BN,
      oraclePublishTime: q.oraclePublishTime as BN,
      oracleConfBps: q.oracleConfBps as number,
      askLevels: (q.askLevels as OnChainLevel[]) ?? [],
      bidLevels: (q.bidLevels as OnChainLevel[]) ?? [],
    };
  } catch { /* quote not written yet */ }

  let configData: OnChainConfig | undefined;
  try {
    const c = (await accounts(program).config.fetch(config)) as Record<string, unknown>;
    configData = {
      keeper: c.keeper as PublicKey,
      treasury: c.treasury as PublicKey,
      feeBps: c.feeBps as number,
      minSpreadBps: c.minSpreadBps as number,
      maxSpreadBps: c.maxSpreadBps as number,
      maxStalenessSeconds: c.maxStalenessSeconds as BN,
      maxConfBps: c.maxConfBps as number,
      maxAnchorStepBps: c.maxAnchorStepBps as number,
      maxInventoryBps: c.maxInventoryBps as number,
      utilizationMaxBps: c.utilizationMaxBps as number,
      minBond: c.minBond as BN,
      warmupSlots: c.warmupSlots as BN,
      epochSlots: c.epochSlots as BN,
      graceSlots: c.graceSlots as BN,
      expirySlots: c.expirySlots as BN,
      maxEdgeLossBps: c.maxEdgeLossBps as number,
      flowWindowSlots: c.flowWindowSlots as BN,
      maxWindowFlowBps: c.maxWindowFlowBps as number,
    };
  } catch { /* config decode failed */ }

  return { exists: true, vault, config, quoteState, vaultData, quoteData, configData };
}

export type SwapSide = { buyBase: Record<string, never> } | { sellBase: Record<string, never> };

async function ensureAta(connection: Connection, mint: PublicKey, owner: PublicKey) {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  if (!(await connection.getAccountInfo(ata))) {
    throw new Error('missing token account — fund the wallet with tSOL/tUSDC TEST TOKENs (devnet)');
  }
  return ata;
}

/** Build + send a `swap` against the live ladder. */
export async function swap(
  connection: Connection, wallet: unknown, side: SwapSide,
  amountIn: bigint, minOut: bigint, minVersion: bigint,
): Promise<string> {
  const w = wallet as Wallet;
  const program = getProgram(connection, wallet);
  const { vault, config, quoteState } = deriveVaultAddresses();
  const owner = w.publicKey;
  const state = await fetchProtocolState(connection);
  if (!state.vaultData) throw new Error('vault not initialized for the configured pair');
  const traderBase = await ensureAta(connection, BASE_MINT, owner);
  const traderQuote = await ensureAta(connection, QUOTE_MINT, owner);
  return program.methods
    .swap(side as never, new BN(amountIn.toString()), new BN(minOut.toString()), new BN(minVersion.toString()))
    .accounts({
      trader: owner, vault, config, quoteState,
      baseReserve: state.vaultData.baseReserve, quoteReserve: state.vaultData.quoteReserve,
      traderBase, traderQuote, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

function depositTicket(vault: PublicKey, user: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('dep'), vault.toBuffer(), user.toBuffer()], PROGRAM_ID)[0];
}
function withdrawTicket(vault: PublicKey, user: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('wd'), vault.toBuffer(), user.toBuffer()], PROGRAM_ID)[0];
}

export async function deposit(
  connection: Connection, wallet: unknown, baseAmount: bigint, quoteAmount: bigint, minShares = 1n,
): Promise<string> {
  const w = wallet as Wallet;
  const program = getProgram(connection, wallet);
  const { vault, config } = deriveVaultAddresses();
  const owner = w.publicKey;
  const state = await fetchProtocolState(connection);
  if (!state.vaultData) throw new Error('vault not initialized for the configured pair');
  const userBase = await ensureAta(connection, BASE_MINT, owner);
  const userQuote = await ensureAta(connection, QUOTE_MINT, owner);
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

export async function requestWithdraw(
  connection: Connection, wallet: unknown, shares: bigint,
): Promise<string> {
  const w = wallet as Wallet;
  const program = getProgram(connection, wallet);
  const { vault } = deriveVaultAddresses();
  const owner = w.publicKey;
  const state = await fetchProtocolState(connection);
  if (!state.vaultData) throw new Error('vault not initialized for the configured pair');
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

export async function claimWithdraw(connection: Connection, wallet: unknown): Promise<string> {
  const w = wallet as Wallet;
  const program = getProgram(connection, wallet);
  const { vault } = deriveVaultAddresses();
  const owner = w.publicKey;
  const state = await fetchProtocolState(connection);
  if (!state.vaultData) throw new Error('vault not initialized for the configured pair');
  return program.methods
    .claimWithdraw()
    .accounts({
      user: owner, vault,
      baseReserve: state.vaultData.baseReserve, quoteReserve: state.vaultData.quoteReserve,
      shareMint: state.vaultData.shareMint, shareLock: state.vaultData.shareLock,
      withdrawTicket: withdrawTicket(vault, owner),
      userBase: getAssociatedTokenAddressSync(BASE_MINT, owner),
      userQuote: getAssociatedTokenAddressSync(QUOTE_MINT, owner),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

export async function crankEpoch(connection: Connection, wallet: unknown): Promise<string> {
  const program = getProgram(connection, wallet);
  const { vault, config } = deriveVaultAddresses();
  return program.methods.crankEpoch().accounts({ vault, config }).rpc();
}

export { BN };
