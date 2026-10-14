/**
 * Integer-exact swap amount math derived from the **on-chain quote parameters**.
 *
 * The authoritative output of a swap is produced by the deployed program
 * (`vault/program/src/lib.rs::swap` → `arb_math::walk_ladder`). This module does
 * not reproduce the full ladder walk; it derives a *conservative floor* from the
 * on-chain reservation sqrt price and the amount, in integer atoms, so the
 * transaction never carries a floating-point `min_out`. The program enforces
 * `out >= min_out`, so a too-high floor reverts rather than over-paying.
 *
 * All amounts are token atoms (`bigint`). No JavaScript floating point is used.
 */

const Q64 = 1n << 64n;
const Q128 = 1n << 128n;

export type SwapSideName = 'buyBase' | 'sellBase';

/** `ceil(amount_in * fee_bps / 10_000)`, matching the program's fee rule. */
export function feeAtoms(amountInAtoms: bigint, feeBps: number): bigint {
  if (amountInAtoms <= 0n || feeBps <= 0) return 0n;
  const bps = BigInt(feeBps);
  return (amountInAtoms * bps + 9999n) / 10000n;
}

/**
 * Expected output atoms from the Q64.64 reservation sqrt price.
 * `price = pResSqrt^2 / 2^64` (quote atoms per base atom, Q64).
 * Sell base: `out = net_in * price`; buy base: `out = net_in / price`.
 */
export function expectedOutAtoms(
  side: SwapSideName,
  netInAtoms: bigint,
  pResSqrtQ64: bigint,
): bigint {
  if (netInAtoms <= 0n || pResSqrtQ64 <= 0n) return 0n;
  const priceQ64 = (pResSqrtQ64 * pResSqrtQ64) / Q64;
  if (priceQ64 <= 0n) return 0n;
  return side === 'sellBase' ? (netInAtoms * priceQ64) / Q64 : (netInAtoms * Q64) / priceQ64;
}

/** Conservative output floor after slippage (integer, floors down). */
export function minOutWithSlippage(expectedOutAtoms: bigint, slippageBps: number): bigint {
  const clamped = Math.min(Math.max(slippageBps, 0), 10_000);
  return (expectedOutAtoms * BigInt(10_000 - clamped)) / 10000n;
}

export interface SwapAmounts {
  fee: bigint;
  netIn: bigint;
  expectedOut: bigint;
  minOut: bigint;
}

/** Full integer amount plan for one swap direction. */
export function swapAmounts(args: {
  side: SwapSideName;
  amountInAtoms: bigint;
  feeBps: number;
  slippageBps: number;
  pResSqrtQ64: bigint;
}): SwapAmounts {
  const fee = feeAtoms(args.amountInAtoms, args.feeBps);
  const netIn = args.amountInAtoms > fee ? args.amountInAtoms - fee : 0n;
  const expectedOut = expectedOutAtoms(args.side, netIn, args.pResSqrtQ64);
  const minOut = minOutWithSlippage(expectedOut, args.slippageBps);
  return { fee, netIn, expectedOut, minOut };
}

/**
 * Raw ladder segment (Q64.64 sqrt bounds + integer liquidity), mirroring
 * `arb_math::Level`. Kept structural so callers can pass on-chain values
 * directly.
 */
export interface LadderLevel {
  sqrtLo: bigint;
  sqrtHi: bigint;
  liquidity: bigint;
}

export interface LadderWalkResult {
  out: bigint;
  remaining: bigint;
}

function deltaSqrt(level: LadderLevel): bigint {
  if (level.sqrtLo === 0n || level.sqrtLo >= level.sqrtHi || level.liquidity === 0n) {
    throw new Error('invalid ladder level');
  }
  return level.sqrtHi - level.sqrtLo;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('divide by zero');
  return (numerator + denominator - 1n) / denominator;
}

/** `ceil(L*(hi-lo)/denom)` for the side-specific denominator. */
function maxInput(level: LadderLevel, side: 'ask' | 'bid'): bigint {
  const delta = deltaSqrt(level);
  const product = level.liquidity * delta;
  const denom = side === 'ask' ? Q128 : level.sqrtLo * level.sqrtHi;
  return ceilDiv(product, denom);
}

/** `floor(L*(hi-lo)/(lo*hi))` — base released by fully consuming an ask level. */
function baseCapacity(level: LadderLevel): bigint {
  const delta = deltaSqrt(level);
  return (level.liquidity * delta) / (level.sqrtLo * level.sqrtHi);
}

/** `floor(L*(hi-lo)/2^128)` — quote released by fully consuming a bid level. */
function quoteCapacity(level: LadderLevel): bigint {
  const delta = deltaSqrt(level);
  return (level.liquidity * delta) / Q128;
}

function askPartial(level: LadderLevel, delta: bigint, quoteIn: bigint): bigint {
  const d = (quoteIn * Q128) / level.liquidity;
  if (d > delta) throw new Error('ask partial exceeds segment');
  const sqrtP = level.sqrtLo + d;
  return ((level.liquidity * d) / level.sqrtLo) / sqrtP;
}

function bidPartial(level: LadderLevel, baseIn: bigint): bigint {
  const numerator = level.sqrtHi * level.liquidity;
  const denom = baseIn * level.sqrtHi + level.liquidity;
  const p = ceilDiv(numerator, denom);
  if (p > level.sqrtHi) throw new Error('bid partial exceeds segment');
  if (p === level.sqrtHi) return 0n;
  return (level.liquidity * (level.sqrtHi - p)) / Q128;
}

/**
 * Integer-exact mirror of `arb_math::walk_ladder`. Trader buys base (`ask`) or
 * sells base (`bid`). All arithmetic floors in the vault's favour exactly as the
 * on-chain program, so `out` is the amount the program enforces for the same
 * ladder and input (used to derive a correct `min_out` floor).
 */
export function walkLadder(
  levels: LadderLevel[],
  side: 'ask' | 'bid',
  amountIn: bigint,
): LadderWalkResult {
  if (levels.length === 0) throw new Error('empty ladder');
  let remaining = amountIn;
  let out = 0n;
  for (const level of levels) {
    if (remaining === 0n) break;
    const maxIn = maxInput(level, side);
    const delta = deltaSqrt(level);
    if (remaining >= maxIn) {
      out += side === 'ask' ? baseCapacity(level) : quoteCapacity(level);
      remaining -= maxIn;
    } else {
      out += side === 'ask' ? askPartial(level, delta, remaining) : bidPartial(level, remaining);
      remaining = 0n;
    }
  }
  return { out, remaining };
}

export interface LadderSwapAmounts extends SwapAmounts {
  /** True when the ladder cannot absorb the whole input (program reverts). */
  capacityExceeded: boolean;
}

/**
 * Exact swap plan from the committed ladder. `expectedOut` is the program's own
 * integer output; `minOut` applies the slippage floor to it. Prefer this over
 * the reservation-price estimate whenever a real quote (with ladder segments) is
 * available.
 */
export function swapAmountsFromLadder(args: {
  side: SwapSideName;
  amountInAtoms: bigint;
  feeBps: number;
  slippageBps: number;
  levels: LadderLevel[];
}): LadderSwapAmounts {
  const fee = feeAtoms(args.amountInAtoms, args.feeBps);
  const netIn = args.amountInAtoms > fee ? args.amountInAtoms - fee : 0n;
  const mathSide: 'ask' | 'bid' = args.side === 'buyBase' ? 'ask' : 'bid';
  const result =
    args.levels.length > 0
      ? walkLadder(args.levels, mathSide, netIn)
      : { out: 0n, remaining: netIn };
  const minOut = minOutWithSlippage(result.out, args.slippageBps);
  return {
    fee,
    netIn,
    expectedOut: result.out,
    minOut,
    capacityExceeded: result.remaining > 0n,
  };
}

/** Human-readable remaining quote validity (pure; ~0.248 s/slot on Devnet). */
export function quoteCountdown(
  expirySlot: number,
  currentSlot: number,
  secPerSlot = 0.248,
): { slots: number; seconds: number; label: string } {
  const slots = Math.max(0, expirySlot - currentSlot);
  const seconds = slots * secPerSlot;
  return {
    slots,
    seconds,
    label: slots > 0 ? `valid for ${slots} more slots (~${seconds.toFixed(1)}s)` : 'quote expired — swaps disabled',
  };
}

/**
 * Largest gross input the committed ladder can fully absorb for a side, in
 * input atoms (mirrors the program's per-level `max_input` sum, inverted for the
 * fee). `0n` when the ladder is empty. Used to show an accurate "Max" and to
 * refuse a partial fill rather than presenting it as a full-swap estimate.
 */
export function maxGrossInput(levels: LadderLevel[], side: SwapSideName, feeBps: number): bigint {
  if (levels.length === 0) return 0n;
  const mathSide: 'ask' | 'bid' = side === 'buyBase' ? 'ask' : 'bid';
  let maxNet = 0n;
  for (const level of levels) {
    try {
      maxNet += maxInput(level, mathSide);
    } catch {
      return 0n; // malformed level -> no guaranteed capacity
    }
  }
  const bps = BigInt(Math.max(0, Math.min(10_000, feeBps)));
  if (bps >= 10_000n) return 0n;
  // Largest gross whose net (gross - fee) is <= maxNet.
  let gross = maxNet >= (1n << 200n) ? maxNet : (maxNet * 10_000n) / (10_000n - bps);
  let guard = 0n;
  while (gross > 0n && gross - feeAtoms(gross, feeBps) > maxNet && guard < 1_000_000n) {
    gross -= 1n;
    guard += 1n;
  }
  return gross;
}
