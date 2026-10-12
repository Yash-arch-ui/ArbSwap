import { AnchorProvider, Program, BN } from '@coral-xyz/anchor';
import type { Wallet } from '@coral-xyz/anchor/dist/cjs/provider';
import { Buffer } from 'buffer';
import {
  Connection,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import type { TransactionInstruction } from '@solana/web3.js';
import idl from '../idl/arbswap.json';
import { ARBSWAP_PROGRAM_ID, BASE_MINT, QUOTE_MINT } from './solana';
import { ACTIVE_VAULT } from './config';

export const PROGRAM_ID = ARBSWAP_PROGRAM_ID;
const SYSTEM_PROGRAM_ID = SystemProgram.programId;

/** Read-only Anchor program (no wallet) for account reads. */
function readOnlyProgram(connection: Connection): Program {
  const readOnlyWallet = {
    publicKey: PublicKey.default,
    signTransaction: async (t: unknown) => t,
    signAllTransactions: async (t: unknown[]) => t,
  };
  return new Program(
    idl as never,
    new AnchorProvider(connection, readOnlyWallet as unknown as Wallet, { commitment: 'confirmed' }),
  );
}

/** Anchor program bound to a connection + wallet (the wallet-adapter adapter). */
export function getProgram(connection: Connection, wallet: unknown): Program {
  const provider = new AnchorProvider(connection, wallet as Wallet, { commitment: 'confirmed' });
  return new Program(idl as never, provider);
}

// Anchor's `Program` loses its typed account namespace when the IDL is cast;
// this view restores the two `fetch` methods we use.
interface AccountFetcher {
  fetch(address: PublicKey): Promise<Record<string, unknown>>;
}
function accounts(program: Program): Record<string, AccountFetcher> {
  return program.account as unknown as Record<string, AccountFetcher>;
}

/** All PDA addresses for the configured vault pair (TEST TOKEN, devnet). */
export function deriveVaultAddresses(baseMint = BASE_MINT, quoteMint = QUOTE_MINT) {
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

/**
 * Assert the runtime-derived PDAs match the configured canonical vault. Call at
 * startup so a wrong mint/address cannot silently point the demo elsewhere.
 */
export function assertActiveVaultDerivation(): void {
  const { programId, vault, config, quoteState } = deriveVaultAddresses(
    ACTIVE_VAULT.baseMint,
    ACTIVE_VAULT.quoteMint,
  );
  if (
    !programId.equals(ARBSWAP_PROGRAM_ID) ||
    !vault.equals(ACTIVE_VAULT.vault) ||
    !config.equals(ACTIVE_VAULT.config) ||
    !quoteState.equals(ACTIVE_VAULT.quoteState)
  ) {
    throw new Error(
      `Deployment mismatch: derived vault accounts do not match ACTIVE_VAULT (${ACTIVE_VAULT.label})`,
    );
  }
}

/** Decoded user share-token balance (atoms), or null if the ATA is absent. */
export async function fetchShareBalance(
  connection: Connection,
  user: PublicKey,
): Promise<bigint | null> {
  const { vault } = deriveVaultAddresses();
  const program = readOnlyProgram(connection);
  const v = (await accounts(program).vault.fetch(vault)) as Record<string, unknown>;
  const shareMint = v.shareMint as PublicKey;
  const ata = getAssociatedTokenAddressSync(shareMint, user);
  try {
    const bal = await connection.getTokenAccountBalance(ata);
    return BigInt(bal.value.amount);
  } catch {
    return null;
  }
}

/** Raw DepositTicket account, or null if none exists for this user. */
export async function fetchDepositTicket(
  connection: Connection,
  user: PublicKey,
): Promise<Record<string, unknown> | null> {
  const { vault } = deriveVaultAddresses();
  const ticket = depositTicket(vault, user);
  const info = await connection.getAccountInfo(ticket);
  if (!info) return null;
  try {
    return (await accounts(readOnlyProgram(connection)).depositTicket.fetch(ticket)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Raw WithdrawTicket account, or null if none exists for this user. */
export async function fetchWithdrawTicket(
  connection: Connection,
  user: PublicKey,
): Promise<Record<string, unknown> | null> {
  const { vault } = deriveVaultAddresses();
  const ticket = withdrawTicket(vault, user);
  const info = await connection.getAccountInfo(ticket);
  if (!info) return null;
  try {
    return (await accounts(readOnlyProgram(connection)).withdrawTicket.fetch(ticket)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Decoded on-chain `Config` bounds (snake_case IDL fields -> camelCase). */
export interface OnChainConfig {
  keeper: PublicKey;
  treasury: PublicKey;
  feeBps: number;
  insuranceBps: number;
  keeperBps: number;
  protocolBps: number;
  minLiquidity: BN;
  warmupSlots: BN;
  epochSlots: BN;
  graceSlots: BN;
  expirySlots: BN;
  maxStalenessSeconds: BN;
  maxConfBps: number;
  maxAnchorStepBps: number;
  maxSpreadStepBps: number;
  minSpreadBps: number;
  maxSpreadBps: number;
  maxQuoteSize: BN;
  maxInventoryBps: number;
  utilizationMaxBps: number;
  minBond: BN;
  unbondCooldownSlots: BN;
  maxUpdateSlotAge: number;
  edgeWindowSlots: BN;
  maxEdgeLossBps: number;
  maxAnchorDevBps: number;
  flowWindowSlots: BN;
  maxWindowFlowBps: number;
}

export interface OnChainLevel {
  offsetBps: number;
  weightBps: number;
  sqrtLo: BN;
  sqrtHi: BN;
  liquidity: BN;
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

export interface OnChainProtocolState {
  exists: boolean;
  vault: PublicKey;
  config: PublicKey;
  quoteState: PublicKey;
  vaultData?: OnChainVault;
  quoteData?: OnChainQuote;
  configData?: OnChainConfig;
}

/** Fetch and decode the vault/config/quote-state accounts for the configured pair. */
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
  const info = await connection.getAccountInfo(vault);
  if (!info) return { exists: false, vault, config, quoteState };

  // NOTE: `program.account.*.fetch` returns Anchor-normalised **camelCase**
  // field names for this IDL (the raw `BorshCoder.accounts.decode` returns
  // snake_case instead).
  const v = (await accounts(program).vault.fetch(vault)) as Record<string, unknown>;
  const baseReserve = v.baseReserve as PublicKey;
  const quoteReserve = v.quoteReserve as PublicKey;
  const readAmount = async (acct: PublicKey): Promise<BN> => {
    try {
      const bal = await connection.getTokenAccountBalance(acct);
      return new BN(bal.value.amount);
    } catch {
      return new BN(0);
    }
  };
  const [baseReserveAmount, quoteReserveAmount] = await Promise.all([
    readAmount(baseReserve),
    readAmount(quoteReserve),
  ]);
  const vaultData: OnChainVault = {
    admin: v.admin as PublicKey,
    baseMint: v.baseMint as PublicKey,
    quoteMint: v.quoteMint as PublicKey,
    baseReserve,
    quoteReserve,
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
    baseReserveAmount,
    quoteReserveAmount,
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
  } catch { /* quote_state not written yet */ }

  let configData: OnChainConfig | undefined;
  try {
    const c = (await accounts(program).config.fetch(config)) as Record<string, unknown>;
    configData = {
      keeper: c.keeper as PublicKey,
      treasury: c.treasury as PublicKey,
      feeBps: c.feeBps as number,
      insuranceBps: c.insuranceBps as number,
      keeperBps: c.keeperBps as number,
      protocolBps: c.protocolBps as number,
      minLiquidity: c.minLiquidity as BN,
      warmupSlots: c.warmupSlots as BN,
      epochSlots: c.epochSlots as BN,
      graceSlots: c.graceSlots as BN,
      expirySlots: c.expirySlots as BN,
      maxStalenessSeconds: c.maxStalenessSeconds as BN,
      maxConfBps: c.maxConfBps as number,
      maxAnchorStepBps: c.maxAnchorStepBps as number,
      maxSpreadStepBps: c.maxSpreadStepBps as number,
      minSpreadBps: c.minSpreadBps as number,
      maxSpreadBps: c.maxSpreadBps as number,
      maxQuoteSize: c.maxQuoteSize as BN,
      maxInventoryBps: c.maxInventoryBps as number,
      utilizationMaxBps: c.utilizationMaxBps as number,
      minBond: c.minBond as BN,
      unbondCooldownSlots: c.unbondCooldownSlots as BN,
      maxUpdateSlotAge: c.maxUpdateSlotAge as number,
      edgeWindowSlots: c.edgeWindowSlots as BN,
      maxEdgeLossBps: c.maxEdgeLossBps as number,
      maxAnchorDevBps: c.maxAnchorDevBps as number,
      flowWindowSlots: c.flowWindowSlots as BN,
      maxWindowFlowBps: c.maxWindowFlowBps as number,
    };
  } catch { /* config decode failed; leave undefined */ }

  return { exists: true, vault, config, quoteState, vaultData, quoteData, configData };
}

/** Address of an ATA, plus an idempotent-create instruction if it is missing. */
async function ensureAta(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
): Promise<{ ata: PublicKey; createIx: TransactionInstruction | null }> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const info = await connection.getAccountInfo(ata);
  const createIx = info
    ? null
    : createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mint);
  return { ata, createIx };
}

/**
 * Build + send a `deposit` (both tokens) and return the signature.
 *
 * The program's `deposit` requires the user base/quote/share token accounts to
 * already exist, so missing ones are created idempotently in the same
 * transaction (as pre-instructions). `minShares` is the slippage floor the
 * caller computes from live state; it is never silently hardcoded here.
 */
export async function deposit(
  connection: Connection, wallet: unknown, baseAmount: bigint, quoteAmount: bigint, minShares: bigint,
): Promise<string> {
  const w = wallet as Wallet;
  const program = getProgram(connection, wallet);
  const { vault, config } = deriveVaultAddresses();
  const owner = w.publicKey;
  const state = await fetchProtocolState(connection);
  if (!state.vaultData) throw new Error(`vault not initialized for ${ACTIVE_VAULT.label}`);
  const base = await ensureAta(connection, BASE_MINT, owner);
  const quote = await ensureAta(connection, QUOTE_MINT, owner);
  const share = await ensureAta(connection, state.vaultData.shareMint, owner);
  const preInstructions = [base.createIx, quote.createIx, share.createIx].filter(
    (ix): ix is TransactionInstruction => ix !== null,
  );
  return program.methods
    .deposit(new BN(baseAmount.toString()), new BN(quoteAmount.toString()), new BN(minShares.toString()))
    .accounts({
      user: owner, vault, config,
      baseReserve: state.vaultData.baseReserve, quoteReserve: state.vaultData.quoteReserve,
      shareMint: state.vaultData.shareMint, shareLock: state.vaultData.shareLock,
      userBase: base.ata, userQuote: quote.ata, userShares: share.ata,
      depositTicket: depositTicket(vault, owner),
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SYSTEM_PROGRAM_ID,
    })
    .preInstructions(preInstructions)
    .rpc();
}

function bigintSqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n / 2n + 1n;
  let y = (x + n / x) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * Expected shares for a proportional deposit, mirroring the deployed program's
 * integer math (`deposit` in `vault/program/src/lib.rs`). Pure and testable; use
 * it to derive a conservative `min_shares` (never a hardcoded 1).
 */
export function expectedDepositShares(args: {
  baseAmount: bigint;
  quoteAmount: bigint;
  totalShares: bigint;
  baseNet: bigint;
  quoteNet: bigint;
  minLiquidity: bigint;
}): bigint {
  if (args.totalShares === 0n) {
    const root = bigintSqrt(args.baseAmount * args.quoteAmount);
    return root > args.minLiquidity ? root - args.minLiquidity : 0n;
  }
  if (args.baseNet === 0n || args.quoteNet === 0n) return 0n;
  const byBase = (args.baseAmount * args.totalShares) / args.baseNet;
  const byQuote = (args.quoteAmount * args.totalShares) / args.quoteNet;
  return byBase < byQuote ? byBase : byQuote;
}

export type SwapSide = { buyBase: Record<string, never> } | { sellBase: Record<string, never> };

/** Build + send a `swap`. `side` is `{ buyBase: {} }` or `{ sellBase: {} }`. */
export async function swap(
  connection: Connection, wallet: unknown, side: SwapSide,
  amountIn: bigint, minOut: bigint, minVersion: bigint,
): Promise<string> {
  const w = wallet as Wallet;
  const program = getProgram(connection, wallet);
  const { vault, config, quoteState } = deriveVaultAddresses();
  const owner = w.publicKey;
  const state = await fetchProtocolState(connection);
  if (!state.vaultData) throw new Error(`vault not initialized for ${ACTIVE_VAULT.label}`);
  const traderBase = (await ensureAta(connection, BASE_MINT, owner)).ata;
  const traderQuote = (await ensureAta(connection, QUOTE_MINT, owner)).ata;
  return program.methods
    .swap(side as never, new BN(amountIn.toString()), new BN(minOut.toString()), new BN(minVersion.toString()))
    .accounts({
      trader: owner, vault, config, quoteState,
      baseReserve: state.vaultData.baseReserve, quoteReserve: state.vaultData.quoteReserve,
      traderBase, traderQuote, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

export async function crankEpoch(connection: Connection, wallet: unknown): Promise<string> {
  const program = getProgram(connection, wallet);
  const { vault, config } = deriveVaultAddresses();
  return program.methods.crankEpoch().accounts({ vault, config }).rpc();
}

/** Queue a withdrawal (shares) for the next epoch. */
export async function requestWithdraw(
  connection: Connection, wallet: unknown, shares: bigint,
): Promise<string> {
  const w = wallet as Wallet;
  const program = getProgram(connection, wallet);
  const { vault } = deriveVaultAddresses();
  const owner = w.publicKey;
  const state = await fetchProtocolState(connection);
  if (!state.vaultData) throw new Error(`vault not initialized for ${ACTIVE_VAULT.label}`);
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
export async function claimWithdraw(connection: Connection, wallet: unknown): Promise<string> {
  const w = wallet as Wallet;
  const program = getProgram(connection, wallet);
  const { vault } = deriveVaultAddresses();
  const owner = w.publicKey;
  const state = await fetchProtocolState(connection);
  if (!state.vaultData) throw new Error(`vault not initialized for ${ACTIVE_VAULT.label}`);
  const base = await ensureAta(connection, BASE_MINT, owner);
  const quote = await ensureAta(connection, QUOTE_MINT, owner);
  const preInstructions = [base.createIx, quote.createIx].filter(
    (ix): ix is TransactionInstruction => ix !== null,
  );
  return program.methods
    .claimWithdraw()
    .accounts({
      user: owner, vault,
      baseReserve: state.vaultData.baseReserve, quoteReserve: state.vaultData.quoteReserve,
      shareMint: state.vaultData.shareMint, shareLock: state.vaultData.shareLock,
      withdrawTicket: withdrawTicket(vault, owner), userBase: base.ata, userQuote: quote.ata,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions(preInstructions)
    .rpc();
}

export { BN };
