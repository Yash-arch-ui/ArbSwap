import { describe, it, expect } from 'vitest';
import { walkLadder, swapAmountsFromLadder, type LadderLevel } from '../src/chain/swapMath';

// Vectors produced by the Rust `arb_math::walk_ladder` (the exact function the
// deployed program executes). Pinned here so the browser-side integer math can
// never silently diverge from on-chain settlement. Regenerate by running a Rust
// test that calls `walk_ladder` on the same ladders below.

const Q = 1n << 64n;

const l1: LadderLevel[] = [
  { sqrtLo: 2n * Q, sqrtHi: 3n * Q, liquidity: 1_000_000_000n * Q },
  { sqrtLo: 3n * Q, sqrtHi: 5n * Q, liquidity: 500_000_000n * Q },
  { sqrtLo: 5n * Q, sqrtHi: 8n * Q, liquidity: 250_000_000n * Q },
];

const base = 6_036_613_448_307_627_517n;
const l3: LadderLevel[] = [
  { sqrtLo: base, sqrtHi: base + base / 200n, liquidity: 1_000_000_000_000_000_000_000_000_000_000n },
  { sqrtLo: base + base / 200n, sqrtHi: base + base / 100n, liquidity: 800_000_000_000_000_000_000_000_000_000n },
  { sqrtLo: base + base / 100n, sqrtHi: base + base / 40n, liquidity: 500_000_000_000_000_000_000_000_000_000n },
  { sqrtLo: base + base / 40n, sqrtHi: base + base / 10n, liquidity: 300_000_000_000_000_000_000_000_000_000n },
];

describe('walkLadder matches arb_math::walk_ladder', () => {
  it('ladder 1 ask-side vectors', () => {
    const cases: Array<[bigint, bigint, bigint]> = [
      [1n, 0n, 0n],
      [1_000_000n, 249_875n, 0n],
      [1_000_000_000n, 166_666_666n, 0n],
      [10_000_000_000n, 252_083_332n, 7_250_000_000n],
      [100_000_000_000n, 252_083_332n, 97_250_000_000n],
    ];
    for (const [amt, out, remaining] of cases) {
      const r = walkLadder(l1, 'ask', amt);
      expect({ amt: amt.toString(), out: r.out, remaining: r.remaining }).toEqual({ amt: amt.toString(), out, remaining });
    }
  });

  it('ladder 1 bid-side vectors', () => {
    const cases: Array<[bigint, bigint, bigint]> = [
      [1n, 8n, 0n],
      [1_000_000n, 8_973_080n, 0n],
      [1_000_000_000n, 2_750_000_000n, 747_916_666n],
      [10_000_000_000n, 2_750_000_000n, 9_747_916_666n],
      [100_000_000_000n, 2_750_000_000n, 99_747_916_666n],
    ];
    for (const [amt, out, remaining] of cases) {
      const r = walkLadder(l1, 'bid', amt);
      expect({ amt: amt.toString(), out: r.out, remaining: r.remaining }).toEqual({ amt: amt.toString(), out, remaining });
    }
  });

  it('ladder 3 (realistic magnitude) ask/bid vectors', () => {
    const ask: Array<[bigint, bigint, bigint]> = [
      [500_000n, 4_668_855n, 0n],
      [2_000_000n, 18_673_844n, 0n],
      [50_000_000n, 465_586_504n, 0n],
      [500_000_000n, 4_452_019_506n, 0n],
      [5_000_000_000n, 5_982_840_919n, 4_308_139_510n],
    ];
    for (const [amt, out, remaining] of ask) {
      const r = walkLadder(l3, 'ask', amt);
      expect({ amt: amt.toString(), out: r.out, remaining: r.remaining }).toEqual({ amt: amt.toString(), out, remaining });
    }
    const bid: Array<[bigint, bigint, bigint]> = [
      [500_000n, 54_081n, 0n],
      [2_000_000n, 216_323n, 0n],
      [50_000_000n, 5_406_518n, 0n],
      [500_000_000n, 53_918_030n, 0n],
      [5_000_000_000n, 578_992_086n, 0n],
    ];
    for (const [amt, out, remaining] of bid) {
      const r = walkLadder(l3, 'bid', amt);
      expect({ amt: amt.toString(), out: r.out, remaining: r.remaining }).toEqual({ amt: amt.toString(), out, remaining });
    }
  });
});

describe('swapAmountsFromLadder is integer-exact and capacity-aware', () => {
  it('computes fee (ceiling), exact output and a floored min_out', () => {
    // buyBase: USDC in -> base out, so use the ask ladder.
    const a = swapAmountsFromLadder({ side: 'buyBase', amountInAtoms: 2_000_000n, feeBps: 1, slippageBps: 10, levels: l3 });
    expect(a.fee).toBe(200n); // ceil(2_000_000 * 1 / 10000)
    expect(a.netIn).toBe(1_999_800n);
    const expectedNetOut = walkLadder(l3, 'ask', 1_999_800n).out;
    expect(a.expectedOut).toBe(expectedNetOut);
    expect(a.minOut).toBe((expectedNetOut * 9990n) / 10000n);
    expect(a.capacityExceeded).toBe(false);
  });

  it('flags capacityExceeded when the ladder cannot absorb the whole input', () => {
    const a = swapAmountsFromLadder({ side: 'buyBase', amountInAtoms: 5_000_000_000n, feeBps: 1, slippageBps: 10, levels: l3 });
    expect(a.capacityExceeded).toBe(true);
    expect(a.expectedOut).toBeGreaterThan(0n);
  });

  it('yields zero (never fabricated) with no ladder', () => {
    const a = swapAmountsFromLadder({ side: 'sellBase', amountInAtoms: 1_000_000_000n, feeBps: 1, slippageBps: 10, levels: [] });
    expect(a.expectedOut).toBe(0n);
    expect(a.minOut).toBe(0n);
    expect(a.capacityExceeded).toBe(true);
  });
});
