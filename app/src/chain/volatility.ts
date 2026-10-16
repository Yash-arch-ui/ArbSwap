// On-chain volatility regime read (Phase 5 of the on-chain EWMA/jump plan).
//
// The `[b"vol", vault]` PDA is the only authoritative source of the volatility
// regime. This module decodes and validates that account by hand (owner +
// length + vault binding) so it never depends on a regenerated IDL, and never
// substitutes a keeper-local estimate for the on-chain value.
import type { AccountInfo, Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { deriveVaultAddresses, PROGRAM_ID } from './program';
import { ACTIVE_VAULT } from './config';
import { sourceErrorFromException, type SourceError } from './dataState';

/** Seed of the vault-bound volatility PDA. */
export const VOL_SEED = 'vol';

/** Serialized byte length: 8-byte discriminator + 167-byte payload. */
export const VOLATILITY_ACCOUNT_LEN = 175;

const Q64 = 1n << 64n;
const BPS_DENOM = 10_000n;

/** Decoded on-chain volatility account (camelCase view of the IDL layout). */
export interface OnChainVolatility {
  vault: string;
  shortEwmaQ64: bigint;
  mediumEwmaQ64: bigint;
  lastPriceQ64: bigint;
  /** Pyth publish time of the last observation (unix seconds). */
  lastPublishTime: number;
  lastObservationSlot: number;
  observationNonce: number;
  jumpDetected: boolean;
  jumpUntilSlot: number;
  shortLambdaBps: number;
  mediumLambdaBps: number;
  jumpMultiple: number;
  maxSigmaQ64: bigint;
  jumpCooldownSlots: number;
  volSpreadCoeffBps: number;
  volDepthCoeffBps: number;
  maxObservationAgeSlots: number;
  enabled: boolean;
  bump: number;
}

/** Derived addresses for the volatility read. */
export function deriveVolatilityAddress(
  baseMint = ACTIVE_VAULT.baseMint,
  quoteMint = ACTIVE_VAULT.quoteMint,
): { vault: PublicKey; volatility: PublicKey } {
  const { vault } = deriveVaultAddresses(baseMint, quoteMint);
  const [volatility] = PublicKey.findProgramAddressSync(
    [Buffer.from(VOL_SEED), vault.toBuffer()],
    PROGRAM_ID,
  );
  return { vault, volatility };
}

function readU64LE(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset) as unknown as bigint;
}

function readI64LE(data: Buffer, offset: number): bigint {
  return data.readBigInt64LE(offset) as unknown as bigint;
}

function readU128LE(data: Buffer, offset: number): bigint {
  const lo = readU64LE(data, offset);
  const hi = readU64LE(data, offset + 8);
  return lo | (hi << 64n);
}

/**
 * Decode a raw `VolatilityState` account, or return null when the buffer is too
 * short / malformed. Pure and total: never throws.
 */
export function decodeVolatilityState(data: Buffer): OnChainVolatility | null {
  if (!data || data.length < VOLATILITY_ACCOUNT_LEN) return null;
  try {
    let o = 8; // 8-byte Anchor discriminator
    const vault = new PublicKey(data.subarray(o, o + 32)).toBase58();
    o += 32;
    const shortEwmaQ64 = readU128LE(data, o);
    o += 16;
    const mediumEwmaQ64 = readU128LE(data, o);
    o += 16;
    const lastPriceQ64 = readU128LE(data, o);
    o += 16;
    const lastPublishTime = Number(readI64LE(data, o));
    o += 8;
    const lastObservationSlot = Number(readU64LE(data, o));
    o += 8;
    const observationNonce = Number(readU64LE(data, o));
    o += 8;
    const jumpDetected = data.readUInt8(o) !== 0;
    o += 1;
    const jumpUntilSlot = Number(readU64LE(data, o));
    o += 8;
    const shortLambdaBps = data.readUInt32LE(o);
    o += 4;
    const mediumLambdaBps = data.readUInt32LE(o);
    o += 4;
    const jumpMultiple = data.readUInt32LE(o);
    o += 4;
    const maxSigmaQ64 = readU128LE(data, o);
    o += 16;
    const jumpCooldownSlots = Number(readU64LE(data, o));
    o += 8;
    const volSpreadCoeffBps = data.readUInt32LE(o);
    o += 4;
    const volDepthCoeffBps = data.readUInt32LE(o);
    o += 4;
    const maxObservationAgeSlots = Number(readU64LE(data, o));
    o += 8;
    const enabled = data.readUInt8(o) !== 0;
    o += 1;
    const bump = data.readUInt8(o);
    return {
      vault,
      shortEwmaQ64,
      mediumEwmaQ64,
      lastPriceQ64,
      lastPublishTime,
      lastObservationSlot,
      observationNonce,
      jumpDetected,
      jumpUntilSlot,
      shortLambdaBps,
      mediumLambdaBps,
      jumpMultiple,
      maxSigmaQ64,
      jumpCooldownSlots,
      volSpreadCoeffBps,
      volDepthCoeffBps,
      maxObservationAgeSlots,
      enabled,
      bump,
    };
  } catch {
    return null;
  }
}

/** Integer square root (floor) of a non-negative bigint. */
export function bigintSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('sqrt of negative');
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/** `ceil(a * bps / 10_000)`; mirrors the program helper. */
export function mulBpsCeil(a: bigint, bps: bigint): bigint {
  return (a * bps + (BPS_DENOM - 1n)) / BPS_DENOM;
}

/** Q64.64 sigma from a Q64.64 per-second variance (`sqrt(v · 2^64)`). */
export function sigmaQ64Of(varianceQ64: bigint): bigint {
  if (varianceQ64 <= 0n) return 0n;
  return bigintSqrt(varianceQ64 << 64n);
}

/** Sigma expressed in bps (integer), saturated at the JS integer ceiling. */
export function sigmaBpsOf(varianceQ64: bigint): number {
  const bps = (sigmaQ64Of(varianceQ64) * BPS_DENOM) / Q64;
  return Number(bps > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : bps);
}

/** Display/compliance view derived from the on-chain account. */
export interface VolatilityView {
  /** Per-second sigma in bps (integer), for the calm regime. */
  sigmaBps: number;
  /** True while a jump is flagged or its cooldown is still running. */
  jumpActive: boolean;
  /** True when the account is enabled but its observation is stale. */
  stale: boolean;
  /** True when `enabled` and a verified, fresh observation exists. */
  verified: boolean;
  /** True when sigma exceeds the configured ceiling (program would stop). */
  overCeiling: boolean;
  observationAgeSlots: number;
  spreadFloorBps: number;
  depthCapBps: number;
}

/**
 * Derive the display view. `minSpreadBps` mirrors `Config.min_spread_bps`.
 * Deterministic integer math, no floating point.
 */
export function volatilityView(
  state: OnChainVolatility,
  currentSlot: number,
  minSpreadBps = 0,
): VolatilityView {
  const sigmaQ64 = sigmaQ64Of(state.shortEwmaQ64);
  const sigmaBpsBig = (sigmaQ64 * BPS_DENOM) / Q64;
  const sigmaBps = Number(sigmaBpsBig > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : sigmaBpsBig);
  const jumpActive = state.jumpDetected || currentSlot < state.jumpUntilSlot;
  // An unknown slot feed (`currentSlot <= 0`, or behind the observation) must
  // not be read as a fresh observation: clamping the age to 0 would otherwise
  // label a state "verified" before the clock is known. Fail to "stale".
  const slotKnown = currentSlot > 0 && currentSlot >= state.lastObservationSlot;
  const observationAgeSlots = Math.max(0, currentSlot - state.lastObservationSlot);
  const stale =
    !slotKnown || state.lastPriceQ64 <= 0n || observationAgeSlots > state.maxObservationAgeSlots;
  const mult = jumpActive ? BigInt(state.jumpMultiple) : 1n;
  const effectiveBps = sigmaBpsBig * mult;
  const volFloor = mulBpsCeil(effectiveBps, BigInt(state.volSpreadCoeffBps));
  const floor = volFloor > BigInt(minSpreadBps) ? volFloor : BigInt(minSpreadBps);
  const spreadFloorBps = Number(floor);
  const depthCut = mulBpsCeil(effectiveBps, BigInt(state.volDepthCoeffBps));
  const cappedCut = depthCut > BPS_DENOM ? BPS_DENOM : depthCut;
  const depthCapBps = Number(BPS_DENOM - cappedCut);
  const overCeiling = sigmaQ64 > state.maxSigmaQ64;
  return {
    sigmaBps,
    jumpActive,
    stale,
    verified: state.enabled && !stale,
    overCeiling,
    observationAgeSlots,
    spreadFloorBps,
    depthCapBps,
  };
}

export type VolatilityReadResult =
  | { kind: 'ready'; state: OnChainVolatility; address: PublicKey; info: AccountInfo<Buffer> }
  | { kind: 'not_found'; address: PublicKey }
  | { kind: 'invalid'; address: PublicKey; reason: string; errorKind: SourceError }
  | { kind: 'rpc_error'; address: PublicKey; reason: string; errorKind: SourceError };

/**
 * Classified read of the volatility PDA. A transport failure is never treated as
 * "absent"; only a successful empty lookup is `not_found`.
 */
export async function readVolatility(
  connection: Connection,
  baseMint = ACTIVE_VAULT.baseMint,
  quoteMint = ACTIVE_VAULT.quoteMint,
): Promise<VolatilityReadResult> {
  const { vault, volatility } = deriveVolatilityAddress(baseMint, quoteMint);
  let info: AccountInfo<Buffer> | null;
  try {
    info = await connection.getAccountInfo(volatility);
  } catch (error) {
    const { kind, reason } = sourceErrorFromException(error);
    return { kind: 'rpc_error', address: volatility, reason, errorKind: kind };
  }
  if (!info) return { kind: 'not_found', address: volatility };
  if (!info.owner.equals(PROGRAM_ID)) {
    return {
      kind: 'invalid',
      address: volatility,
      reason: `Account is owned by ${info.owner.toBase58().slice(0, 6)}…, not the ArbSwap program.`,
      errorKind: 'invalid_owner',
    };
  }
  const state = decodeVolatilityState(info.data);
  if (!state) {
    return {
      kind: 'invalid',
      address: volatility,
      reason: 'Volatility account could not be decoded with the expected layout.',
      errorKind: 'invalid_layout',
    };
  }
  if (state.vault !== vault.toBase58()) {
    return {
      kind: 'invalid',
      address: volatility,
      reason: 'Volatility account is not bound to the configured vault.',
      errorKind: 'invalid_layout',
    };
  }
  return { kind: 'ready', state, address: volatility, info };
}
