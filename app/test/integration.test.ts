import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseUnits, formatUnits } from '../src/chain/amounts';
import { swapUnavailableReason, liveSwapGateReason, claimWithdrawState, submitFreshnessReason } from '../src/chain/gating';
import { feeAtoms, expectedOutAtoms, minOutWithSlippage, swapAmounts } from '../src/chain/swapMath';
import { deriveVaultAddresses, expectedDepositShares, keeperRewardPda } from '../src/chain/program';
import { CANONICAL_VAULT, ACTIVE_VAULT } from '../src/chain/config';
import { toQuoteState } from '../src/chain/live';
import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';

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

describe('integer-exact amounts (9/6 decimals)', () => {
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

describe('integer swap math (no floating point)', () => {
  // Raw token-unit price 4 quote-atoms per base-atom => pResSqrt = 2 << 64.
  const pResSqrt = 2n << 64n;

  it('sell base: out = net * price', () => {
    const a = swapAmounts({ side: 'sellBase', amountInAtoms: 1_000_000_000n, feeBps: 1, slippageBps: 10, pResSqrtQ64: pResSqrt });
    expect(a.fee).toBe(100_000n);
    expect(a.netIn).toBe(999_900_000n);
    expect(a.expectedOut).toBe(3_999_600_000n);
    expect(a.minOut).toBe((3_999_600_000n * 9990n) / 10000n); // 10 bps slippage
  });

  it('buy base: out = net / price (floored)', () => {
    const a = swapAmounts({ side: 'buyBase', amountInAtoms: 100_000_000n, feeBps: 1, slippageBps: 10, pResSqrtQ64: pResSqrt });
    expect(a.fee).toBe(10_000n);
    expect(a.netIn).toBe(99_990_000n);
    expect(a.expectedOut).toBe(24_997_500n);
  });

  it('fee uses ceiling and slippage floors down', () => {
    expect(feeAtoms(1n, 1)).toBe(1n);
    expect(minOutWithSlippage(1000n, 10)).toBe(999n); // 10 bps
    expect(minOutWithSlippage(101n, 1)).toBe(100n); // 1 bps, floored
  });

  it('no quote (pResSqrt = 0) yields zero output, never a fabricated amount', () => {
    expect(expectedOutAtoms('sellBase', 1_000_000_000n, 0n)).toBe(0n);
    expect(expectedOutAtoms('buyBase', 1_000_000_000n, 0n)).toBe(0n);
  });
});

describe('claim gating mirrors the program precondition (ticket.epoch <= vault.epoch)', () => {
  it('blocks without a ticket / wallet', () => {
    expect(claimWithdrawState({ walletConnected: true, hasTicket: false, ticketEpoch: 0, vaultEpoch: 0, ticketShares: 0n }).allowed).toBe(false);
    expect(claimWithdrawState({ walletConnected: false, hasTicket: true, ticketEpoch: 0, vaultEpoch: 5, ticketShares: 1n }).allowed).toBe(false);
  });
  it('blocks until the requested epoch is reached', () => {
    const s = claimWithdrawState({ walletConnected: true, hasTicket: true, ticketEpoch: 3, vaultEpoch: 2, ticketShares: 10n });
    expect(s.allowed).toBe(false);
    expect(s.reason).toMatch(/epoch 3/);
  });
  it('allows once the epoch is reached, and after an already-claimed ticket (shares 0)', () => {
    expect(claimWithdrawState({ walletConnected: true, hasTicket: true, ticketEpoch: 3, vaultEpoch: 3, ticketShares: 10n }).allowed).toBe(true);
    expect(claimWithdrawState({ walletConnected: true, hasTicket: true, ticketEpoch: 3, vaultEpoch: 4, ticketShares: 0n }).allowed).toBe(false);
  });
});

describe('swap gate fails closed', () => {
  const enabled = { transactionsEnabled: true, transactionDisabledReason: null, genesisVerified: true };
  it('blocks with the 2-second freshness reason when there is no quote', () => {
    const reason = swapUnavailableReason({
      ...enabled,
      vaultInitialized: true,
      circuitBreakerTripped: false,
      quoteAvailable: false,
    });
    expect(reason).toMatch(/no fresh Pyth quote/i);
    expect(reason).toMatch(/2-second/);
  });

  it('blocks when the vault is uninitialized or paused', () => {
    expect(
      swapUnavailableReason({ ...enabled, vaultInitialized: false, circuitBreakerTripped: false, quoteAvailable: true }),
    ).toMatch(/not initialized/);
    expect(
      swapUnavailableReason({ ...enabled, vaultInitialized: true, circuitBreakerTripped: true, quoteAvailable: true }),
    ).toMatch(/circuit breaker/);
  });

  it('blocks when transactions are disabled or the cluster is unverified', () => {
    expect(
      swapUnavailableReason({ ...enabled, transactionsEnabled: false, transactionDisabledReason: 'read-only', vaultInitialized: true, circuitBreakerTripped: false, quoteAvailable: true }),
    ).toMatch(/read-only/);
    expect(
      swapUnavailableReason({ ...enabled, genesisVerified: false, vaultInitialized: true, circuitBreakerTripped: false, quoteAvailable: true }),
    ).toMatch(/unverified cluster/);
  });

  it('allows only when enabled, on a verified cluster, vault live, not paused, and a fresh quote exists', () => {
    expect(
      swapUnavailableReason({ ...enabled, vaultInitialized: true, circuitBreakerTripped: false, quoteAvailable: true }),
    ).toBeNull();
  });
});

describe('state-aware live swap gate fails closed with a concrete reason', () => {
  const ok = {
    vaultState: 'live' as const,
    vaultExists: true,
    errorKind: null,
    genesisVerified: true,
    circuitBreakerTripped: false,
    quoteAvailable: true,
    quoteStatus: 'Fresh' as const,
  };

  it('allows only when every live precondition holds', () => {
    expect(liveSwapGateReason(ok)).toBeNull();
  });

  it('blocks an unverified cluster even when the env says devnet', () => {
    expect(liveSwapGateReason({ ...ok, genesisVerified: false })).toMatch(/unverified cluster/);
  });

  it('distinguishes an RPC 429 from an uninitialized vault', () => {
    const r = liveSwapGateReason({ ...ok, vaultState: 'stale', errorKind: 'rate_limited', vaultExists: null });
    expect(r).toMatch(/rate-limiting/i);
    expect(r).not.toMatch(/no vault is initialized/i);
  });

  it('blocks an invalid account state and a failed preflight read', () => {
    expect(liveSwapGateReason({ ...ok, vaultState: 'invalid' })).toMatch(/failed validation/);
    expect(liveSwapGateReason({ ...ok, vaultState: 'stale', errorKind: 'timeout' })).toMatch(/RPC read failed/i);
  });

  it('blocks an expired or aging quote', () => {
    expect(liveSwapGateReason({ ...ok, quoteAvailable: false, quoteStatus: 'Expired' })).toMatch(/expired/);
    expect(liveSwapGateReason({ ...ok, quoteAvailable: false, quoteStatus: 'Aging' })).toMatch(/aging/);
  });

  it('blocks a paused vault', () => {
    expect(liveSwapGateReason({ ...ok, circuitBreakerTripped: true })).toMatch(/circuit breaker/);
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

describe('quote availability never falls back to a numeric zero', () => {
  const pk = PublicKey.default;
  const base = { exists: true, vault: pk, config: pk, quoteState: pk };

  it('reports Unavailable (hasQuote=false) when no quote account was read', () => {
    const q = toQuoteState({ ...base }, 1000);
    expect(q.hasQuote).toBe(false);
    expect(q.status).toBe('Unavailable');
    expect(q.oraclePrice).toBe(0); // genuine absence, rendered as Unavailable not "$0.00"
  });

  it('reports Expired for a real quote past its slot window', () => {
    const quoteData = {
      version: new BN(18), updateSlot: new BN(100), expirySlot: new BN(110),
      halfSpreadBps: 11, askExtraBps: 0, bidExtraBps: 0, depthMultBps: 7000,
      oraclePrice: new BN(0), anchorSqrtPrice: new BN('6036613448307627517'),
      pResSqrt: new BN('6036613448307627517'), oraclePublishTime: new BN(1791842540),
      oracleConfBps: 4, askLevels: [], bidLevels: [],
    };
    const expired = toQuoteState({ ...base, quoteData }, 5000);
    expect(expired.hasQuote).toBe(true);
    expect(expired.status).toBe('Expired');
    expect(expired.oraclePrice).toBeGreaterThan(0);

    const fresh = toQuoteState({ ...base, quoteData }, 105);
    expect(fresh.status).toBe('Fresh');

    const aging = toQuoteState({
      ...base,
      quoteData,
      configData: { graceSlots: new BN(4) } as never,
    }, 108);
    expect(aging.status).toBe('Aging');
  });

  it('swap gate stays closed while the quote is unavailable or expired', () => {
    const unavailable = toQuoteState({ ...base }, 1000);
    expect(swapUnavailableReason({ transactionsEnabled: true, transactionDisabledReason: null, genesisVerified: true, vaultInitialized: true, circuitBreakerTripped: false, quoteAvailable: unavailable.hasQuote && unavailable.status !== 'Expired' })).toMatch(/no fresh Pyth quote/);
  });
});

describe('keeper reward attribution (S2-24/S2-25)', () => {
  const VAULT = new PublicKey('8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt');
  const KEEPER = new PublicKey('8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH');
  const PROGRAM = new PublicKey('2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm');

  it('derives the per-keeper reward PDA as [b"reward", vault, keeper]', () => {
    const pda = keeperRewardPda(VAULT, KEEPER);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from('reward'), VAULT.toBuffer(), KEEPER.toBuffer()],
      PROGRAM,
    );
    expect(pda.toBase58()).toBe(expected.toBase58());
  });

  it('exposes the quote author only when genuinely attributed', () => {
    const pk = PublicKey.default;
    const base = { exists: true, vault: pk, config: pk, quoteState: pk };
    const quoteData = {
      version: new BN(19), updateSlot: new BN(100), expirySlot: new BN(110),
      halfSpreadBps: 11, askExtraBps: 0, bidExtraBps: 0, depthMultBps: 7000,
      oraclePrice: new BN(0), anchorSqrtPrice: new BN('6036613448307627517'),
      pResSqrt: new BN('6036613448307627517'), oraclePublishTime: new BN(1),
      oracleConfBps: 4, keeper: KEEPER, askLevels: [], bidLevels: [],
    };
    expect(toQuoteState({ ...base, quoteData }, 105).quoteKeeper).toBe(KEEPER.toBase58());
    // Unattributed (legacy/migrated sentinel) must never surface a configured keeper.
    expect(toQuoteState({ ...base, quoteData: { ...quoteData, keeper: pk } }, 105).quoteKeeper).toBeNull();
  });
});

describe('submission-time quote freshness gate (S2-35)', () => {
  it('refuses when the live quote could not be re-read', () => {
    expect(submitFreshnessReason(null)).toMatch(/could not be re-read/);
  });

  it('refuses an unattributed or zero-version quote', () => {
    expect(
      submitFreshnessReason({ fresh: true, version: 0n, currentSlot: 5n, expirySlot: 10n }),
    ).toMatch(/no attributed on-chain quote/);
  });

  it('refuses an expired quote and names the exact slots', () => {
    const reason = submitFreshnessReason({ fresh: false, version: 4n, currentSlot: 12n, expirySlot: 10n });
    expect(reason).toMatch(/expired/);
    expect(reason).toMatch(/10/);
    expect(reason).toMatch(/12/);
  });

  it('proceeds only for a fresh, attributed quote', () => {
    expect(submitFreshnessReason({ fresh: true, version: 4n, currentSlot: 9n, expirySlot: 10n })).toBeNull();
  });
});

describe('S2-28 independent keeper attribution (mocked)', () => {
  // The provisioned independent keeper B (public key only; unfunded faucet attempt).
  const KEEPER_B = new PublicKey('6FqSc5vm9vdVDLRVbJZ9cYx4Mh4sVtCpM5x6qaLknB2G');
  it('displays a quote authored by Keeper B (never config.keeper)', () => {
    const pk = PublicKey.default;
    const base = { exists: true, vault: pk, config: pk, quoteState: pk };
    const quoteData = {
      version: new BN(30), updateSlot: new BN(200), expirySlot: new BN(210),
      halfSpreadBps: 11, askExtraBps: 0, bidExtraBps: 0, depthMultBps: 7000,
      oraclePrice: new BN(0), anchorSqrtPrice: new BN('6036613448307627517'),
      pResSqrt: new BN('6036613448307627517'), oraclePublishTime: new BN(1),
      oracleConfBps: 4, keeper: KEEPER_B, askLevels: [], bidLevels: [],
    };
    expect(toQuoteState({ ...base, quoteData }, 205).quoteKeeper).toBe(KEEPER_B.toBase58());
  });
});
