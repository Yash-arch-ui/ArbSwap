/**
 * Integer-exact single-sided deposit / withdrawal planning.
 *
 * Mirrors the deployed program (`vault/program/src/lib.rs::deposit_single` and
 * `claim_withdraw_single`) using the same ladder walk as the swap page
 * (`walkLadder`, itself a mirror of `arb_math::walk_ladder`). All amounts are
 * token atoms (`bigint`); no JavaScript floating point is used in the plan.
 *
 * `side` semantics match the program:
 *  - `deposit_single`: `side` is the token the user **pays**
 *    (`sellBase` = base in, `buyBase` = quote in).
 *  - `claim_withdraw_single`: `side` is the token the user **receives**
 *    (`buyBase` = base out, `sellBase` = quote out).
 */

import { feeAtoms, expectedOutAtoms, walkLadder, type LadderLevel } from './swapMath';

export type SingleSide = 'buyBase' | 'sellBase';

/** Ladder walk for a single side; the same mapping the program uses. */
function walk(levels: LadderLevel[], side: SingleSide, net: bigint): { out: bigint; remaining: bigint } {
  if (levels.length === 0) return { out: 0n, remaining: net };
  // buyBase walks the ask ladder; sellBase walks the bid ladder.
  const mathSide: 'ask' | 'bid' = side === 'buyBase' ? 'ask' : 'bid';
  return walkLadder(levels, mathSide, net);
}

// ---------------------------------------------------------------------------
// deposit_single
// ---------------------------------------------------------------------------

export interface DepositSinglePlan {
  /** Gross swapped notional `s` (fee inclusive). */
  swapIn: bigint;
  fee: bigint;
  /** `swapIn - fee`, the ladder input. */
  swapNet: bigint;
  /** Ladder output of the internal swap (quote for sellBase, base for buyBase). */
  swapOut: bigint;
  /** Base notional deposited (the imbalanced remainder). */
  baseDeposited: bigint;
  /** Quote notional deposited. */
  quoteDeposited: bigint;
  shares: bigint;
}

interface EvalArgs {
  side: SingleSide;
  amountIn: bigint;
  feeBps: number;
  baseNet: bigint;
  quoteNet: bigint;
  totalShares: bigint;
  levels: LadderLevel[];
}

/**
 * Mirror of `single_eval`: the balanced plan for a candidate notional plus the
 * exact bisection root `diff = floor(db*S/B') - floor(dq*S/Q')`, or null.
 */
function evalDeposit(args: EvalArgs, s: bigint): { plan: DepositSinglePlan; diff: bigint } | null {
  const fee = feeAtoms(s, args.feeBps);
  const swapNet = s > fee ? s - fee : 0n;
  let swapOut: bigint;
  let baseAfter: bigint;
  let quoteAfter: bigint;
  let baseDeposited: bigint;
  let quoteDeposited: bigint;
  if (args.side === 'sellBase') {
    const r = walk(args.levels, 'sellBase', swapNet);
    if (r.remaining > 0n) return null;
    swapOut = r.out;
    if (swapOut > args.quoteNet) return null;
    baseAfter = args.baseNet + swapNet;
    quoteAfter = args.quoteNet - swapOut;
    baseDeposited = args.amountIn - s;
    quoteDeposited = swapOut;
  } else {
    const r = walk(args.levels, 'buyBase', swapNet);
    if (r.remaining > 0n) return null;
    swapOut = r.out;
    if (swapOut > args.baseNet) return null;
    baseAfter = args.baseNet - swapOut;
    quoteAfter = args.quoteNet + swapNet;
    baseDeposited = swapOut;
    quoteDeposited = args.amountIn - s;
  }
  if (baseAfter <= 0n || quoteAfter <= 0n) return null;
  if (args.totalShares <= 0n) return null;
  const byBase = (baseDeposited * args.totalShares) / baseAfter;
  const byQuote = (quoteDeposited * args.totalShares) / quoteAfter;
  return {
    plan: {
      swapIn: s,
      fee,
      swapNet,
      swapOut,
      baseDeposited,
      quoteDeposited,
      shares: byBase < byQuote ? byBase : byQuote,
    },
    diff: byBase - byQuote,
  };
}

/**
 * Mirror of `solve_deposit_single`: bounded bisection for the balanced swapped
 * notional, then compare the crossing and its neighbours to return the plan with
 * the largest share count. Returns null when no feasible plan exists.
 */
export function depositSinglePlan(args: EvalArgs): DepositSinglePlan | null {
  if (args.amountIn <= 0n || args.totalShares <= 0n) return null;
  let lo = 0n;
  let hi = args.amountIn;
  if (args.side === 'sellBase') {
    // Largest s with diff(s) >= 0.
    while (lo < hi) {
      const mid = lo + (hi - lo + 1n) / 2n;
      const e = evalDeposit(args, mid);
      if (e && e.diff >= 0n) lo = mid;
      else hi = mid - 1n;
    }
  } else {
    // Smallest s with diff(s) >= 0.
    while (lo < hi) {
      const mid = lo + (hi - lo) / 2n;
      const e = evalDeposit(args, mid);
      if (e && e.diff >= 0n) hi = mid;
      else lo = mid + 1n;
    }
  }
  let best: DepositSinglePlan | null = null;
  for (const delta of [0n, -1n, 1n]) {
    const candidate = lo + delta;
    if (candidate < 0n || candidate > args.amountIn) continue;
    const e = evalDeposit(args, candidate);
    if (e && (!best || e.plan.shares > best.shares)) best = e.plan;
  }
  // The instruction also requires db>0, dq>0, swap_out>0 and shares>0; a plan
  // that fails any of these reverts, so project it as infeasible (null).
  if (!best || best.shares === 0n || best.baseDeposited === 0n || best.quoteDeposited === 0n || best.swapOut === 0n) {
    return null;
  }
  return best;
}

// ---------------------------------------------------------------------------
// claim_withdraw_single
// ---------------------------------------------------------------------------

export interface WithdrawSinglePlan {
  baseOut: bigint;
  quoteOut: bigint;
  /** The leg that must be converted (gross, fee inclusive). */
  unwanted: bigint;
  fee: bigint;
  swapNet: bigint;
  /** Ladder output for the unwanted leg. */
  converted: bigint;
  payout: bigint;
  capacityExceeded: boolean;
}

/**
 * Mirror of `claim_withdraw_single`'s amount plan. `side` is the payout token:
 * `buyBase` pays base (converting the unwanted quote), `sellBase` pays quote
 * (converting the unwanted base). `capacityExceeded` mirrors the program's
 * `CapacityExceeded` revert (which leaves the ticket intact).
 */
export function withdrawSinglePlan(args: {
  side: SingleSide;
  shares: bigint;
  totalShares: bigint;
  baseNet: bigint;
  quoteNet: bigint;
  feeBps: number;
  levels: LadderLevel[];
}): WithdrawSinglePlan {
  const baseOut = args.totalShares > 0n ? (args.shares * args.baseNet) / args.totalShares : 0n;
  const quoteOut = args.totalShares > 0n ? (args.shares * args.quoteNet) / args.totalShares : 0n;
  const unwanted = args.side === 'buyBase' ? quoteOut : baseOut;
  const fee = feeAtoms(unwanted, args.feeBps);
  const swapNet = unwanted > fee ? unwanted - fee : 0n;
  let converted = 0n;
  let capacityExceeded = false;
  if (swapNet > 0n) {
    const r = walk(args.levels, args.side, swapNet);
    converted = r.out;
    capacityExceeded = r.remaining > 0n;
  }
  const payout = args.side === 'buyBase' ? baseOut + converted : quoteOut + converted;
  return { baseOut, quoteOut, unwanted, fee, swapNet, converted, payout, capacityExceeded };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Price impact of the internal conversion versus the committed reservation mid,
 * in basis points (positive = cost). `side` is the token received (the
 * conversion output side, matching `walk`). Returns null when not computable.
 */
export function conversionImpactBps(args: {
  side: SingleSide;
  swapNet: bigint;
  converted: bigint;
  pResSqrtQ64: bigint;
}): number | null {
  if (args.swapNet <= 0n || args.converted <= 0n || args.pResSqrtQ64 <= 0n) return null;
  const midOut = expectedOutAtoms(args.side, args.swapNet, args.pResSqrtQ64);
  if (midOut <= 0n) return null;
  if (args.converted >= midOut) return 0;
  return Number(((midOut - args.converted) * 10_000n) / midOut);
}

/** Slippage floor: `floor(expected * (10_000 - bps) / 10_000)`. */
export function minWithSlippage(expected: bigint, slippageBps: number): bigint {
  const clamped = BigInt(Math.min(Math.max(slippageBps, 0), 10_000));
  return (expected * (10_000n - clamped)) / 10_000n;
}
