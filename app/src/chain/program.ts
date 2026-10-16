import { AnchorProvider, Program, BN } from '@coral-xyz/anchor';
import type { Wallet } from '@coral-xyz/anchor/dist/cjs/provider';
import { Buffer } from 'buffer';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  type AccountInfo,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import type { TransactionInstruction } from '@solana/web3.js';
import { wrapSolInstructions, unwrapSolInstructions } from './wrappedSol';
import idl from '../idl/arbswap.json';
import { ARBSWAP_PROGRAM_ID, BASE_MINT, QUOTE_MINT } from './solana';
import { ACTIVE_VAULT, EXPECTED_GENESIS_HASH } from './config';

export const PROGRAM_ID = ARBSWAP_PROGRAM_ID;
const SYSTEM_PROGRAM_ID = SystemProgram.programId;
const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';

/**
 * Verify the connected cluster is Devnet (genesis hash) before any on-chain
 * value is presented as trusted. Read-only; never throws — returns the observed
 * hash and whether it matched so the UI can fail honestly.
 */
export async function verifyCluster(
  connection: Connection,
): Promise<{ verified: boolean; genesisHash: string | null }> {
  try {
    const genesisHash = await connection.getGenesisHash();
    return { verified: genesisHash === EXPECTED_GENESIS_HASH, genesisHash };
  } catch {
    return { verified: false, genesisHash: null };
  }
}

/**
 * Verify the deployed program account exists, is executable, and is owned by the
 * upgradeable BPF loader. Prevents presenting data from a wrong/absent program.
 */
export async function verifyProgram(
  connection: Connection,
): Promise<{ verified: boolean; owner: string | null; executable: boolean }> {
  try {
    const info = await connection.getAccountInfo(ARBSWAP_PROGRAM_ID);
    const owner = info?.owner.toBase58() ?? null;
    const executable = info?.executable ?? false;
    return { verified: executable && owner === BPF_LOADER_UPGRADEABLE, owner, executable };
  } catch {
    return { verified: false, owner: null, executable: false };
  }
}

/** Read-only Anchor program (no wallet) for account reads. */
function readOnlyProgram(connection: Connection, commitment: 'processed' | 'confirmed' = 'confirmed'): Program {
  const readOnlyWallet = {
    publicKey: PublicKey.default,
    signTransaction: async (t: unknown) => t,
    signAllTransactions: async (t: unknown[]) => t,
  };
  return new Program(
    idl as never,
    new AnchorProvider(connection, readOnlyWallet as unknown as Wallet, { commitment }),
  );
}

/** Map a decoded QuoteState account to the typed view (camelCase IDL fields). */
export function mapQuote(q: Record<string, unknown>): OnChainQuote {
  return {
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
    keeper: (q.keeper as PublicKey | undefined) ?? PublicKey.default,
    askLevels: (q.askLevels as OnChainLevel[]) ?? [],
    bidLevels: (q.bidLevels as OnChainLevel[]) ?? [],
  };
}

/**
 * Normalise the value returned by `useWallet().wallet` into an Anchor `Wallet`.
 *
 * In `@solana/wallet-adapter-react` >=0.15 the context `wallet` is
 * `{ adapter, readyState }`, NOT the adapter itself, so `wallet.publicKey` is
 * `undefined` and `wallet.signTransaction` does not exist. Unwrap `.adapter`
 * when present so callers can pass either shape safely.
 */
function anchorWallet(wallet: unknown): Wallet {
  if (wallet && typeof wallet === 'object' && 'adapter' in wallet) {
    return (wallet as { adapter: Wallet }).adapter;
  }
  return wallet as Wallet;
}

/** Anchor program bound to a connection + wallet (the wallet-adapter adapter). */
export function getProgram(connection: Connection, wallet: unknown): Program {
  const provider = new AnchorProvider(connection, anchorWallet(wallet), { commitment: 'confirmed' });
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

/** S2-24: per-keeper reward PDA `[b"reward", vault, keeper]`. */
export function keeperRewardPda(vault: PublicKey, keeper: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('reward'), vault.toBuffer(), keeper.toBuffer()],
    PROGRAM_ID,
  )[0];
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
  // Distinguish "no share ATA yet" (null) from a real RPC failure (throws, so
  // callers can retain the last-known value instead of showing "no account").
  const info = await connection.getAccountInfo(ata);
  if (!info) return null;
  const bal = await connection.getTokenAccountBalance(ata);
  return BigInt(bal.value.amount);
}

/** Raw DepositTicket account, or null if none exists for this user. */
export async function fetchDepositTicket(
  connection: Connection,
  user: PublicKey,
): Promise<Record<string, unknown> | null> {
  const { vault } = deriveVaultAddresses();
  const ticket = depositTicket(vault, user);
  // A network error here propagates so the caller keeps the last-known ticket;
  // only a genuinely missing account returns null.
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
  // A network error here propagates so the caller keeps the last-known ticket;
  // only a genuinely missing account returns null.
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
  /** S2-19: the keeper that authored the active quote (reward attribution). */
  keeper: PublicKey;
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
  vaultInfo?: AccountInfo<Buffer> | null,
): Promise<OnChainProtocolState> {
  const { vault, config, quoteState } = deriveVaultAddresses(baseMint, quoteMint);
  const readOnlyWallet = {
    publicKey: PublicKey.default,
    signTransaction: async (t: unknown) => t,
    signAllTransactions: async (t: unknown[]) => t,
  };
  const program = new Program(idl as never, new AnchorProvider(
    connection, readOnlyWallet as unknown as Wallet, { commitment: 'confirmed' }));
  // Accept a pre-read vault account so callers can classify a single
  // authoritative read (RPC error vs missing vs invalid) without a second fetch.
  const info = vaultInfo !== undefined ? vaultInfo : await connection.getAccountInfo(vault);
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
    quoteData = mapQuote(q);
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

/**
 * S2-35: read the *current* on-chain quote at submission time. The deployed
 * quote expires after only `Config.expiry_slots` slots, so the cached poll state
 * can be older than the live quote. Returns the live version/expiry and whether
 * it is still fresh at `processed`; the swap uses this version and refuses to
 * submit against an expired quote with a precise reason.
 */
export interface FreshQuote {
  version: bigint;
  expirySlot: bigint;
  currentSlot: bigint;
  /** Strictly `version > 0` and `current_slot < expiry_slot`, as the program requires. */
  fresh: boolean;
  keeper: PublicKey;
  /** The committed ask ladder (buy base) at this version, for an exact min_out. */
  askLevels: OnChainLevel[];
  /** The committed bid ladder (sell base) at this version, for an exact min_out. */
  bidLevels: OnChainLevel[];
}

export async function fetchFreshQuote(connection: Connection): Promise<FreshQuote | null> {
  const { quoteState } = deriveVaultAddresses();
  const program = readOnlyProgram(connection, 'processed');
  const [slot, q] = await Promise.all([
    connection.getSlot("processed"),
    accounts(program).quoteState.fetch(quoteState).catch(() => null),
  ]);
  if (!q) return null;
  const version = BigInt((q.version as BN).toString());
  const expirySlot = BigInt((q.expirySlot as BN).toString());
  return {
    version,
    expirySlot,
    currentSlot: BigInt(slot),
    fresh: version > 0n && BigInt(slot) < expirySlot,
    keeper: (q.keeper as PublicKey | undefined) ?? PublicKey.default,
    askLevels: (q.askLevels as OnChainLevel[]) ?? [],
    bidLevels: (q.bidLevels as OnChainLevel[]) ?? [],
  };
}

/**
 * S2-36: read ONLY the QuoteState account at the `processed` commitment (one
 * RPC), matching the program's own freshness semantics. Used by the live quote
 * feed so the frontend observes a newly committed version within ~1 slot instead
 * of behind the multi-call vault/config read. Returns null when no quote exists
 * or the read fails (never a fabricated quote).
 */
export async function fetchQuoteOnly(connection: Connection): Promise<OnChainQuote | null> {
  const { quoteState } = deriveVaultAddresses();
  try {
    const q = (await accounts(readOnlyProgram(connection, 'processed')).quoteState.fetch(quoteState)) as Record<string, unknown>;
    return mapQuote(q);
  } catch {
    return null;
  }
}

/** Address of an ATA, plus an idempotent-create instruction if it is missing. */
async function ensureAta(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
): Promise<{ ata: PublicKey; createIx: TransactionInstruction | null; exists: boolean }> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const info = await connection.getAccountInfo(ata);
  const createIx = info
    ? null
    : createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mint);
  return { ata, createIx, exists: info !== null };
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
  const w = anchorWallet(wallet);
  const program = getProgram(connection, wallet);
  const { vault, config } = deriveVaultAddresses();
  const owner = w.publicKey;
  const state = await fetchProtocolState(connection);
  if (!state.vaultData) throw new Error(`vault not initialized for ${ACTIVE_VAULT.label}`);
  const base = await ensureAta(connection, BASE_MINT, owner);
  const quote = await ensureAta(connection, QUOTE_MINT, owner);
  const share = await ensureAta(connection, state.vaultData.shareMint, owner);
  const preInstructions: TransactionInstruction[] = [];
  // Auto-wrap: the base mint is native WSOL, so fund the WSOL ATA from the
  // wallet's native SOL (create ATA if needed + transfer + syncNative) before the
  // deposit pulls base tokens. Only the shortfall not already held as WSOL is
  // wrapped, so existing WSOL is used first and SOL is kept for fees. No manual
  // "wrap in Phantom" step is required.
  if (BASE_MINT.equals(NATIVE_MINT)) {
    const held = await readAtaAmount(connection, base.ata);
    const shortfall = baseAmount > held ? baseAmount - held : 0n;
    if (shortfall > 0n) {
      preInstructions.push(...wrapSolInstructions(owner, shortfall, base.exists));
    } else if (base.createIx) {
      preInstructions.push(base.createIx);
    }
  } else if (base.createIx) {
    preInstructions.push(base.createIx);
  }
  if (quote.createIx) preInstructions.push(quote.createIx);
  if (share.createIx) preInstructions.push(share.createIx);
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

/** Current SPL token-account amount (atoms), or 0n when the account is absent. */
async function readAtaAmount(connection: Connection, ata: PublicKey): Promise<bigint> {
  try {
    const bal = await connection.getTokenAccountBalance(ata);
    return BigInt(bal.value.amount);
  } catch {
    return 0n;
  }
}

/**
 * Resolve all accounts and return the `swap` method builder plus the wrap/unwrap
 * and idempotent ATA-creation instructions. Exposed so tests can build the
 * transaction for the *connected* wallet and assert its accounts without
 * broadcasting.
 *
 * The program's `trader_base`/`trader_quote` are plain `TokenAccount`s (not
 * `init_if_needed`), so a fresh wallet — e.g. buying WSOL for the first time —
 * must have its ATAs created in the same transaction or the swap fails.
 *
 * The base mint is native WSOL, so a sell wraps the wallet's native SOL into WSOL
 * *before* the swap and a buy closes (unwraps) the WSOL ATA *after* the swap, so
 * the trader pays/receives native SOL without a manual wrap step.
 */
export async function swapMethod(
  connection: Connection, wallet: unknown, side: SwapSide,
  amountIn: bigint, minOut: bigint, minVersion: bigint,
) {
  const w = anchorWallet(wallet);
  const program = getProgram(connection, wallet);
  const { vault, config, quoteState } = deriveVaultAddresses();
  const owner = w.publicKey;
  const state = await fetchProtocolState(connection);
  if (!state.vaultData) throw new Error(`vault not initialized for ${ACTIVE_VAULT.label}`);
  const base = await ensureAta(connection, BASE_MINT, owner);
  const quote = await ensureAta(connection, QUOTE_MINT, owner);
  const isNativeBase = BASE_MINT.equals(NATIVE_MINT);
  const isSellBase = 'sellBase' in (side as object);
  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];
  if (isNativeBase) {
    if (isSellBase) {
      // Sell base: wrap only the native-SOL shortfall not already held as WSOL,
      // so any existing WSOL is used first and the swap can pull base tokens.
      const held = await readAtaAmount(connection, base.ata);
      const shortfall = amountIn > held ? amountIn - held : 0n;
      if (shortfall > 0n) {
        preInstructions.push(...wrapSolInstructions(owner, shortfall, base.exists));
      } else if (base.createIx) {
        preInstructions.push(base.createIx);
      }
    } else {
      // Buy base: create the WSOL ATA up front, then close (unwrap) it after so
      // the trader receives native SOL instead of WSOL (also sweeps any dust).
      if (base.createIx) preInstructions.push(base.createIx);
      postInstructions.push(...unwrapSolInstructions(owner).instructions);
    }
  } else if (base.createIx) {
    preInstructions.push(base.createIx);
  }
  if (quote.createIx) preInstructions.push(quote.createIx);
  // S2-19: the keeper reward PDA for the keeper attributed to the active quote.
  const attributedKeeper = state.quoteData?.keeper ?? PublicKey.default;
  const [keeperReward] = PublicKey.findProgramAddressSync(
    [Buffer.from('reward'), vault.toBuffer(), attributedKeeper.toBuffer()],
    PROGRAM_ID,
  );
  const builder = program.methods
    .swap(side as never, new BN(amountIn.toString()), new BN(minOut.toString()), new BN(minVersion.toString()))
    .accounts({
      trader: owner, vault, config, quoteState,
      baseReserve: state.vaultData.baseReserve, quoteReserve: state.vaultData.quoteReserve,
      traderBase: base.ata, traderQuote: quote.ata, keeperReward, systemProgram: SYSTEM_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
    });
  return { builder, preInstructions, postInstructions };
}

/** Build + send a `swap`. `side` is `{ buyBase: {} }` or `{ sellBase: {} }`. */
export async function swap(
  connection: Connection, wallet: unknown, side: SwapSide,
  amountIn: bigint, minOut: bigint, minVersion: bigint,
): Promise<string> {
  const { builder, preInstructions, postInstructions } = await swapMethod(connection, wallet, side, amountIn, minOut, minVersion);
  return builder.preInstructions(preInstructions).postInstructions(postInstructions).rpc();
}

/** Build (unsigned) the swap transaction for the connected wallet, for preview/simulation. */
export async function buildSwapTransaction(
  connection: Connection, wallet: unknown, side: SwapSide,
  amountIn: bigint, minOut: bigint, minVersion: bigint,
): Promise<Transaction> {
  const { builder, preInstructions, postInstructions } = await swapMethod(connection, wallet, side, amountIn, minOut, minVersion);
  const tx = await builder.preInstructions(preInstructions).postInstructions(postInstructions).transaction();
  return attachFeePayer(connection, wallet, tx);
}

/**
 * Anchor 0.31's `MethodBuilder.transaction()` returns a bare `Transaction` with no
 * fee payer or blockhash (only `.rpc()` fills them via the provider, see
 * `provider.js`). Attach both so the built tx compiles for simulation and wallet
 * signing instead of failing with "Transaction fee payer required".
 */
export async function attachFeePayer(
  connection: Connection, wallet: unknown, tx: Transaction,
): Promise<Transaction> {
  const owner = anchorWallet(wallet).publicKey;
  if (!owner) throw new Error('Wallet is not connected.');
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.feePayer = owner;
  tx.recentBlockhash = blockhash;
  return tx;
}

/** Human, actionable explanations for the deployed program's swap error codes. */
const SWAP_ERRORS: Record<number, string> = {
  6012: 'Integer math overflow — amount is out of range.',
  6013: 'The vault is paused by the circuit breaker (Paused).',
  6015: 'The oracle update is stale or invalid (InvalidOracle). A fresh quote is required.',
  6021: 'The per-window one-sided flow cap would be exceeded (FlowCapExceeded).',
  6030: 'The on-chain quote expired before submission (QuoteExpired). Re-open Swap and submit against a fresh quote.',
  6031: 'The on-chain quote version is older than required (VersionTooOld). Refresh and retry.',
  6032: 'The fill would be worse than your minimum output (SlippageExceeded).',
  6033: 'The committed ladder cannot fill this size (CapacityExceeded). Reduce the amount.',
  6037: 'The quote update slot is too old (UpdateSlotTooOld).',
  6039: 'The staged quote expired before commit (StalePendingQuote).',
  6041: 'Quote attribution mismatch (QuoteAttributionMismatch).',
  6042: 'The active quote has no keeper attribution (UnattributedQuote).',
};

/** Extract a program error code from a `simulateTransaction` result or thrown error. */
export function explainSwapError(err: unknown): string {
  const anyErr = err as {
    InstructionError?: [number, { Custom?: number } | string];
    value?: { err?: unknown; logs?: string[] };
    logs?: string[];
    message?: string;
  };
  const instr = anyErr?.InstructionError ?? (anyErr?.value?.err as { InstructionError?: [number, { Custom?: number } | string] })?.InstructionError;
  const code = Array.isArray(instr) && instr[1] && typeof instr[1] === 'object' ? (instr[1] as { Custom?: number }).Custom : undefined;
  if (typeof code === 'number' && SWAP_ERRORS[code]) return SWAP_ERRORS[code];
  const logs = anyErr?.logs ?? anyErr?.value?.logs ?? [];
  const logLine = logs.find((l) => /Error Code:|custom program error/.test(l));
  if (logLine) return `Program error: ${logLine.replace(/^Program log: /, '').slice(0, 160)}`;
  if (typeof code === 'number') return `Program rejected the swap (code ${code}).`;
  return anyErr?.message?.slice(0, 160) ?? 'The transaction simulation failed.';
}

export interface SwapSimulation {
  ok: boolean;
  err: unknown;
  logs: string[];
  unitsConsumed?: number;
  reason: string | null;
}

/** Simulate a built swap transaction (read-only preflight before wallet signing). */
export async function simulateSwap(connection: Connection, tx: Transaction): Promise<SwapSimulation> {
  const sim = await connection.simulateTransaction(tx);
  const logs = sim.value.logs ?? [];
  return {
    ok: sim.value.err === null,
    err: sim.value.err,
    logs,
    unitsConsumed: sim.value.unitsConsumed ?? undefined,
    reason: sim.value.err === null ? null : explainSwapError(sim.value),
  };
}

/**
 * Sign with the connected wallet and submit, then wait for a confirmed status.
 * Never reports success before chain confirmation.
 */
export async function sendSwapTransaction(
  connection: Connection, wallet: unknown, tx: Transaction,
): Promise<string> {
  const w = anchorWallet(wallet);
  const signed = await w.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: true, maxRetries: 3, preflightCommitment: 'confirmed',
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const st = await connection.getSignatureStatuses([sig], { searchTransactionHistory: false }).catch(() => null);
    const v = st?.value?.[0];
    if (v?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(v.err)}`);
    if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) return sig;
    if (Date.now() > deadline) {
      throw new Error(`Confirmation timed out for ${sig.slice(0, 8)}… (it may still land; verify on the explorer).`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
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
  const w = anchorWallet(wallet);
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
  const w = anchorWallet(wallet);
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

/**
 * S2-24: the connected wallet's claimable keeper reward (base/quote atoms), or
 * `null` when it has no `KeeperReward` account (not a keeper, or never authored a
 * committed quote). Never fabricates an entitlement.
 */
export async function fetchKeeperReward(
  connection: Connection,
  owner: PublicKey,
): Promise<{ base: bigint; quote: bigint } | null> {
  const { vault } = deriveVaultAddresses();
  try {
    const r = (await accounts(readOnlyProgram(connection)).keeperReward.fetch(
      keeperRewardPda(vault, owner),
    )) as Record<string, unknown>;
    return { base: BigInt((r.base as BN).toString()), quote: BigInt((r.quote as BN).toString()) };
  } catch {
    return null;
  }
}

/**
 * S2-24: claim the connected keeper's own accrued reward. The program pays only
 * the signer's `KeeperReward` PDA and caps the claim by the vault's aggregate
 * keeper buckets, so a keeper can never claim another keeper's accrual.
 */
export async function claimKeeperReward(connection: Connection, wallet: unknown): Promise<string> {
  const w = anchorWallet(wallet);
  const program = getProgram(connection, wallet);
  const { vault } = deriveVaultAddresses();
  const owner = w.publicKey;
  const state = await fetchProtocolState(connection);
  if (!state.vaultData) throw new Error(`vault not initialized for ${ACTIVE_VAULT.label}`);
  const keeperBase = getAssociatedTokenAddressSync(BASE_MINT, owner);
  const keeperQuote = getAssociatedTokenAddressSync(QUOTE_MINT, owner);
  return program.methods
    .claimKeeperReward()
    .accounts({
      keeper: owner, vault,
      keeperReward: keeperRewardPda(vault, owner),
      baseReserve: state.vaultData.baseReserve, quoteReserve: state.vaultData.quoteReserve,
      keeperBase, keeperQuote, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

export { BN };
