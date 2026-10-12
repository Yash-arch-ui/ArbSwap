/**
 * Integer-safe swap amount math derived from the **on-chain quote parameters**.
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
