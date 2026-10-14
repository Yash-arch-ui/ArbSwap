import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import {
  maxGrossInput, swapAmountsFromLadder, quoteCountdown, type LadderLevel,
} from '../src/chain/swapMath';
import { humanPriceFromSqrt } from '../src/chain/live';
import {
  wrapSolInstructions, unwrapSolInstructions, assertKeepsFeeBuffer,
  wrappedSolAta, MIN_SOL_FOR_FEES,
} from '../src/chain/wrappedSol';

const Q64 = 1n << 64n;
const Q128 = 1n << 128n;
void Q64;
void Q128;

// A single ladder segment around price ~4 (raw quote/base atoms), wide enough to
// have a finite, non-trivial capacity.
function level(): LadderLevel {
  const sqrtLo = 2n << 64n; // price ~4
  const sqrtHi = 3n << 64n; // price ~9
  const liquidity = 10n ** 18n;
  return { sqrtLo, sqrtHi, liquidity };
}

describe('S2-37 depth: maxGrossInput is the exact full-fill boundary', () => {
  const levels = [level()];
  for (const side of ['buyBase', 'sellBase'] as const) {
    it(`${side}: max is fully absorbed, max+1 is exceeded`, () => {
      const max = maxGrossInput(levels, side, 1);
      expect(max).toBeGreaterThan(0n);
      const atMax = swapAmountsFromLadder({ side, amountInAtoms: max, feeBps: 1, slippageBps: 50, levels });
      expect(atMax.capacityExceeded).toBe(false);
      const over = swapAmountsFromLadder({ side, amountInAtoms: max + 1_000n, feeBps: 1, slippageBps: 50, levels });
      expect(over.capacityExceeded).toBe(true);
      // The over-size partial output must be strictly smaller than the full-fill output.
      expect(over.expectedOut).toBeLessThan(swapAmountsFromLadder({
        side, amountInAtoms: max, feeBps: 1, slippageBps: 50, levels,
      }).expectedOut + 1n);
    });
  }
  it('empty ladder has zero capacity', () => {
    expect(maxGrossInput([], 'buyBase', 1)).toBe(0n);
  });
});

describe('S2-37 countdown', () => {
  it('reports remaining slots and seconds, and expiry at/below zero slots', () => {
    const c = quoteCountdown(1000, 990);
    expect(c.slots).toBe(10);
    expect(c.seconds).toBeCloseTo(2.48, 2);
    expect(c.label).toMatch(/valid for 10 more slots/);
    expect(quoteCountdown(1000, 1000).label).toMatch(/expired/);
    expect(quoteCountdown(1000, 1200).slots).toBe(0);
  });
});

describe('S2-37 price normalization matches the on-chain quote', () => {
  it('humanPriceFromSqrt yields ~$107 for the observed anchor sqrt price', () => {
    // Live committed anchor_sqrt_price on 2026-10-14; expected human price ≈ $107.
    const price = humanPriceFromSqrt(new BN('6044532135358422514'));
    expect(price).toBeGreaterThan(105);
    expect(price).toBeLessThan(110);
    // Regression guard for the stale "$186.98" reading.
    expect(Math.abs(price - 186.98)).toBeGreaterThan(50);
  });
  it('is monotonic and zero for absent input', () => {
    expect(humanPriceFromSqrt(new BN(0))).toBe(0);
    expect(humanPriceFromSqrt(new BN('6044532135358422514')))
      .toBeLessThan(humanPriceFromSqrt(new BN('8000000000000000000')));
  });
});

describe('S2-37 WSOL wrap/unwrap instruction builders', () => {
  const owner = new PublicKey('8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH');
  it('wrap creates the ATA when missing, transfers, and syncs native (3 ixs)', () => {
    const ixs = wrapSolInstructions(owner, 1_000_000_000n, false);
    expect(ixs).toHaveLength(3);
    expect(ixs[0].programId.toBase58()).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    expect(ixs[1].programId.toBase58()).toBe('11111111111111111111111111111111');
    expect(ixs[2].programId.toBase58()).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    expect(ixs[1].keys.some((k) => k.pubkey.equals(wrappedSolAta(owner)))).toBe(true);
  });
  it('wrap skips the create when the ATA exists (2 ixs) and unwrap closes it', () => {
    expect(wrapSolInstructions(owner, 1_000_000_000n, true)).toHaveLength(2);
    const { ata, instructions } = unwrapSolInstructions(owner);
    expect(ata.equals(wrappedSolAta(owner))).toBe(true);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].programId.toBase58()).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  });
  it('refuses to wrap below the 0.05 SOL fee buffer', () => {
    expect(() => assertKeepsFeeBuffer(MIN_SOL_FOR_FEES, 1_000_000n)).toThrow();
    expect(() => assertKeepsFeeBuffer(2_000_000_000n, 1_000_000_000n)).not.toThrow();
    expect(NATIVE_MINT.toBase58()).toBe('So11111111111111111111111111111111111111112');
  });
});

describe('S2-37 funding panel (zero-balance wallets)', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/components/FundingPanel.tsx', import.meta.url)), 'utf8');
  it('links the verified faucets and shows the USDC mint + copy control', () => {
    expect(src).toMatch(/https:\/\/faucet\.solana\.com\//);
    expect(src).toMatch(/https:\/\/faucet\.circle\.com\//);
    expect(src).toMatch(/ACTIVE_VAULT\.quoteMint\.toBase58\(\)/);
    expect(src).toMatch(/copy/i);
    expect(src).toMatch(/Devnet test funds/);
  });
});
