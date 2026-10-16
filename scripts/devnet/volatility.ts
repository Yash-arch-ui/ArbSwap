// On-chain volatility support for the live TypeScript keeper.
//
// Pure, side-effect-free helpers shared by `keeper_live.ts` and its regression
// tests: the vault-bound PDA, the account layout, the fixed-point limit math
// (mirrored bit-for-bit from `arb_math::volatility` / the program guard), and the
// exact instruction account lists for `stage_quote`, `commit_quote`, and
// `observe_volatility`.
//
// This module never treats a keeper-local value as protocol truth: it only reads
// the on-chain account and the program remains the enforcement authority.
import { AccountMeta, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createHash } from "crypto";

/** Seed of the vault-bound volatility PDA. */
export const VOL_SEED = Buffer.from("vol");
/** Seed of the timelocked pending-volatility PDA. */
export const VOL_PENDING_SEED = Buffer.from("vol_pending");
/** Serialized length: 8-byte discriminator + 167-byte payload. */
export const VOLATILITY_ACCOUNT_LEN = 175;

const Q64 = 1n << 64n;
const BPS_DENOM = 10_000n;

const disc = (name: string): Buffer =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const meta = (pubkey: PublicKey, writable = false, signer = false): AccountMeta => ({
  pubkey,
  isWritable: writable,
  isSigner: signer,
});

/** `[b"vol", vault]` for the given program id. */
export function volatilityPda(vault: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VOL_SEED, vault.toBuffer()], programId)[0];
}

/** `[b"vol_pending", vault]` for the given program id. */
export function pendingVolatilityPda(vault: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VOL_PENDING_SEED, vault.toBuffer()], programId)[0];
}

/** Decoded on-chain `VolatilityState` (mirrors the Anchor account layout). */
export interface OnChainVolatility {
  vault: string;
  shortEwmaQ64: bigint;
  mediumEwmaQ64: bigint;
  lastPriceQ64: bigint;
  lastPublishTime: bigint;
  lastObservationSlot: bigint;
  observationNonce: bigint;
  jumpDetected: boolean;
  jumpUntilSlot: bigint;
  jumpMultiple: number;
  maxSigmaQ64: bigint;
  jumpCooldownSlots: bigint;
  volSpreadCoeffBps: number;
  volDepthCoeffBps: number;
  maxObservationAgeSlots: bigint;
  enabled: boolean;
  bump: number;
}

function readU128LE(d: Buffer, o: number): bigint {
  return d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n);
}

/** Decode a raw `VolatilityState`, or `null` when the buffer is too short. */
export function decodeVolatilityState(d: Buffer): OnChainVolatility | null {
  if (!d || d.length < VOLATILITY_ACCOUNT_LEN) return null;
  try {
    return {
      vault: new PublicKey(d.subarray(8, 40)).toBase58(),
      shortEwmaQ64: readU128LE(d, 40),
      mediumEwmaQ64: readU128LE(d, 56),
      lastPriceQ64: readU128LE(d, 72),
      lastPublishTime: d.readBigInt64LE(88),
      lastObservationSlot: d.readBigUInt64LE(96),
      observationNonce: d.readBigUInt64LE(104),
      jumpDetected: d.readUInt8(112) !== 0,
      jumpUntilSlot: d.readBigUInt64LE(113),
      jumpMultiple: d.readUInt32LE(129),
      maxSigmaQ64: readU128LE(d, 133),
      jumpCooldownSlots: d.readBigUInt64LE(149),
      volSpreadCoeffBps: d.readUInt32LE(157),
      volDepthCoeffBps: d.readUInt32LE(161),
      maxObservationAgeSlots: d.readBigUInt64LE(165),
      enabled: d.readUInt8(173) !== 0,
      bump: d.readUInt8(174),
    };
  } catch {
    return null;
  }
}

/** Floor integer square root of a non-negative bigint. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** Q64.64 sigma from a Q64.64 per-second variance: `sqrt(v * 2^64)`. */
export function sigmaQ64(varianceQ64: bigint): bigint {
  if (varianceQ64 <= 0n) return 0n;
  return isqrt(varianceQ64 << 64n);
}

/** `sigma` in bps (floor), matching the program's `sigma * 10_000 / 2^64`. */
export function sigmaBps(varianceQ64: bigint): bigint {
  return (sigmaQ64(varianceQ64) * BPS_DENOM) / Q64;
}

/** `ceil(a * bps / 10_000)`, matching the program helper `mul_bps_ceil`. */
export function mulBpsCeil(a: bigint, bps: bigint): bigint {
  return (a * bps + (BPS_DENOM - 1n)) / BPS_DENOM;
}

export interface VolatilityLimits {
  floorBps: bigint;
  capBps: bigint;
  overCeiling: boolean;
}

/**
 * The program's volatility spread floor and depth cap for the current state,
 * mirrored from `volatility_guard_core`. `currentSlot` drives jump activity.
 */
export function volatilityLimits(
  vol: OnChainVolatility,
  currentSlot: bigint,
  minSpreadBps: bigint,
): VolatilityLimits {
  const sigma = sigmaQ64(vol.shortEwmaQ64);
  const overCeiling = sigma > vol.maxSigmaQ64;
  const sigmaB = (sigma * BPS_DENOM) / Q64;
  const jumpActive = vol.jumpDetected || currentSlot < vol.jumpUntilSlot;
  const mult = jumpActive ? BigInt(vol.jumpMultiple) : 1n;
  const effective = sigmaB * mult;
  const volFloor = mulBpsCeil(effective, BigInt(vol.volSpreadCoeffBps));
  const floorBps = volFloor > minSpreadBps ? volFloor : minSpreadBps;
  const depthCut = mulBpsCeil(effective, BigInt(vol.volDepthCoeffBps));
  const capped = depthCut > BPS_DENOM ? BPS_DENOM : depthCut;
  return { floorBps, capBps: BPS_DENOM - capped, overCeiling };
}

/** True while the stored observation is within the configured slot age. */
export function observationFresh(vol: OnChainVolatility, currentSlot: bigint): boolean {
  if (vol.lastPriceQ64 <= 0n) return false;
  return currentSlot - vol.lastObservationSlot <= vol.maxObservationAgeSlots;
}

export type VolatilityAction = "blocked-absent" | "observe-baseline" | "observe-stale" | "quote";

/**
 * Pure gating decision. `null` means the PDA is absent (the keeper must stop
 * quote maintenance; it must never treat a missing account as zero volatility).
 * `refreshAtSlots` is the age (slots) at which the keeper proactively refreshes.
 */
export function volatilityAction(
  vol: OnChainVolatility | null,
  currentSlot: bigint,
): VolatilityAction {
  if (vol === null) return "blocked-absent";
  if (vol.lastPriceQ64 <= 0n) return "observe-baseline";
  const age = currentSlot - vol.lastObservationSlot;
  // Refresh before the guard's window closes (half the configured age).
  const refreshAt = vol.maxObservationAgeSlots / 2n;
  if (age > refreshAt) return "observe-stale";
  return "quote";
}

/** Byte offsets of `half_spread_bps` / `depth_mult_bps` in the 692-byte body. */
export const BODY_HALF_SPREAD_OFFSET = 52;
export const BODY_DEPTH_MULT_OFFSET = 64;

/**
 * Return a copy of the engine's `QuoteUpdate` body with the spread raised to
 * `floorBps` and the depth lowered to `capBps` (the program's guard is the
 * authority; this only anticipates it). Widening the spread widens the ladder
 * band, and lowering depth only shrinks it, so the existing ladder stays valid.
 */
export function clampQuoteBody(body: Buffer, floorBps: bigint, capBps: bigint): Buffer {
  const out = Buffer.from(body);
  const half = out.readUInt32LE(BODY_HALF_SPREAD_OFFSET);
  const depth = out.readUInt32LE(BODY_DEPTH_MULT_OFFSET);
  const newHalf = BigInt(half) > floorBps ? BigInt(half) : floorBps;
  const newDepth = BigInt(depth) < capBps ? BigInt(depth) : capBps;
  out.writeUInt32LE(Number(newHalf), BODY_HALF_SPREAD_OFFSET);
  out.writeUInt32LE(Number(newDepth), BODY_DEPTH_MULT_OFFSET);
  return out;
}

export interface StageKeyArgs {
  programId: PublicKey;
  keeper: PublicKey;
  vault: PublicKey;
  config: PublicKey;
  quoteState: PublicKey;
  pendingQuote: PublicKey;
  baseReserve: PublicKey;
  quoteReserve: PublicKey;
  keeperBond: PublicKey;
  volatilityState: PublicKey;
  systemProgram: PublicKey;
}

/** `stage_quote` account list with the volatility PDA immediately before SYSTEM. */
export function buildStageKeys(a: StageKeyArgs): AccountMeta[] {
  return [
    meta(a.keeper, true, true),
    meta(a.vault),
    meta(a.config),
    meta(a.quoteState),
    meta(a.pendingQuote, true),
    meta(a.baseReserve),
    meta(a.quoteReserve),
    meta(a.keeperBond),
    meta(a.volatilityState),
    meta(a.systemProgram),
  ];
}

export interface CommitKeyArgs {
  programId: PublicKey;
  keeper: PublicKey;
  vault: PublicKey;
  config: PublicKey;
  quoteState: PublicKey;
  pendingQuote: PublicKey;
  priceUpdate: PublicKey;
  baseReserve: PublicKey;
  quoteReserve: PublicKey;
  keeperBond: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  volatilityState: PublicKey;
  /** Extra trailing account(s) the Pyth push needs; ignored by `commit_quote`. */
  extraTrailing?: PublicKey[];
}

/** `commit_quote` account list with the volatility PDA last of the 12 program accounts. */
export function buildCommitKeys(a: CommitKeyArgs): AccountMeta[] {
  return [
    meta(a.keeper, true, true),
    meta(a.vault),
    meta(a.config),
    meta(a.quoteState, true),
    meta(a.pendingQuote, true),
    meta(a.priceUpdate),
    meta(a.baseReserve),
    meta(a.quoteReserve),
    meta(a.keeperBond),
    meta(a.baseMint),
    meta(a.quoteMint),
    meta(a.volatilityState),
    ...(a.extraTrailing ?? []).map((p) => meta(p)),
  ];
}

export interface ObserveKeyArgs {
  programId: PublicKey;
  observer: PublicKey;
  vault: PublicKey;
  config: PublicKey;
  volatilityState: PublicKey;
  priceUpdate: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
}

/** The permissionless `observe_volatility` instruction. */
export function buildObserveIx(a: ObserveKeyArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId: a.programId,
    data: disc("observe_volatility"),
    keys: [
      meta(a.observer, false, true),
      meta(a.vault),
      meta(a.config),
      meta(a.volatilityState, true),
      meta(a.priceUpdate),
      meta(a.baseMint),
      meta(a.quoteMint),
    ],
  });
}
