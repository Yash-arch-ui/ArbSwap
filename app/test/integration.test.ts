import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseUnits, formatUnits } from '../src/chain/amounts';
import { swapUnavailableReason } from '../src/chain/gating';
import { deriveVaultAddresses, expectedDepositShares } from '../src/chain/program';
import { CANONICAL_VAULT, ACTIVE_VAULT } from '../src/chain/config';

describe('canonical vault wiring', () => {
  it('derives the configured canonical WSOL/USDC vault/config/quote PDAs', () => {
    const { vault, config, quoteState } = deriveVaultAddresses(
      CANONICAL_VAULT.baseMint,
      CANONICAL_VAULT.quoteMint,
    );
    expect(vault.toBase58()).toBe('8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt');
    expect(config.toBase58()).toBe('ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT');
    expect(quoteState.toBase58()).toBe('5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG');
  });

  it('the active vault is the canonical funded vault with 9/6 decimals', () => {
    expect(ACTIVE_VAULT.canonical).toBe(true);
    expect(ACTIVE_VAULT.vault.toBase58()).toBe('8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt');
    expect(ACTIVE_VAULT.baseDecimals).toBe(9);
    expect(ACTIVE_VAULT.quoteDecimals).toBe(6);
  });
});

describe('integer-safe amounts (9/6 decimals)', () => {
  it('parses and formats without floating point', () => {
    expect(parseUnits('1', 9)).toBe(1_000_000_000n);
    expect(parseUnits('0.174120234', 9)).toBe(174_120_234n);
    expect(parseUnits('19', 6)).toBe(19_000_000n);
    expect(parseUnits('19.000001', 6)).toBe(19_000_001n);
    expect(formatUnits(174_120_234n, 9)).toBe('0.174120234');
    expect(formatUnits(19_000_000n, 6)).toBe('19');
  });

  it('rejects invalid input and excess precision', () => {
    expect(() => parseUnits('abc', 6)).toThrow();
    expect(() => parseUnits('', 6)).toThrow();
    expect(() => parseUnits('1.1234567', 6)).toThrow(/decimal/);
  });
});

describe('expectedDepositShares mirrors the program math', () => {
  it('first deposit uses isqrt(base*quote) - min_liquidity', () => {
    expect(
      expectedDepositShares({
        baseAmount: 174_120_234n,
        quoteAmount: 19_000_000n,
        totalShares: 0n,
        baseNet: 0n,
        quoteNet: 0n,
        minLiquidity: 1000n,
      }),
    ).toBe(57_516_688n);
  });

  it('later deposit uses the min of the proportional sides', () => {
    expect(
      expectedDepositShares({
        baseAmount: 10n,
        quoteAmount: 10n,
        totalShares: 1000n,
        baseNet: 100n,
        quoteNet: 100n,
        minLiquidity: 1000n,
      }),
    ).toBe(100n);
  });

  it('returns 0 for a dust first deposit', () => {
    expect(
      expectedDepositShares({
        baseAmount: 2n,
        quoteAmount: 2n,
        totalShares: 0n,
        baseNet: 0n,
        quoteNet: 0n,
        minLiquidity: 1000n,
      }),
    ).toBe(0n);
  });
});

describe('swap gate fails closed', () => {
  it('blocks with the 2-second freshness reason when there is no quote', () => {
    const reason = swapUnavailableReason({
      vaultInitialized: true,
      circuitBreakerTripped: false,
      quoteAvailable: false,
    });
    expect(reason).toMatch(/no fresh Pyth quote/i);
    expect(reason).toMatch(/2-second/);
  });

  it('blocks when the vault is uninitialized or paused', () => {
    expect(
      swapUnavailableReason({ vaultInitialized: false, circuitBreakerTripped: false, quoteAvailable: true }),
    ).toMatch(/not initialized/);
    expect(
      swapUnavailableReason({ vaultInitialized: true, circuitBreakerTripped: true, quoteAvailable: true }),
    ).toMatch(/circuit breaker/);
  });

  it('allows only when vault is live, not paused, and a fresh quote exists', () => {
    expect(
      swapUnavailableReason({ vaultInitialized: true, circuitBreakerTripped: false, quoteAvailable: true }),
    ).toBeNull();
  });
});

describe('live pages do not use mock data', () => {
  const livePages = [
    'SwapPage.tsx',
    'VaultPage.tsx',
    'RiskPage.tsx',
    'AnalyticsPage.tsx',
    'OverviewPage.tsx',
  ];
  for (const page of livePages) {
    it(`${page} does not import mockData or MOCK_ constants`, () => {
      const path = fileURLToPath(new URL(`../src/pages/${page}`, import.meta.url));
      const src = readFileSync(path, 'utf8');
      expect(src).not.toMatch(/mockData/);
      expect(src).not.toMatch(/\bMOCK_[A-Z_]+/);
    });
  }

  it('the protocol context does not import mock data', () => {
    const path = fileURLToPath(new URL('../src/context/ProtocolContext.tsx', import.meta.url));
    const src = readFileSync(path, 'utf8');
    expect(src).not.toMatch(/mockData/);
  });
});
