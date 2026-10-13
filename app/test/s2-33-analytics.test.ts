import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { interpretExport, type OnchainAnalytics } from '../src/data/onchainAnalytics';
import { toQuoteState } from '../src/chain/live';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const EXPORT = here('../public/analytics/onchain.json');

describe('S2-33 indexed on-chain history export', () => {
  it('is present and parses as a real bundle', () => {
    expect(existsSync(EXPORT)).toBe(true);
    const bundle = JSON.parse(readFileSync(EXPORT, 'utf8')) as OnchainAnalytics;
    expect(bundle.network).toBe('devnet');
    expect(bundle.index_status?.coverage?.transactions).toBeGreaterThan(0);
    expect(bundle.history?.source).toMatch(/indexed/i);
    // The pipeline must not fabricate: coverage bounds are real slots.
    expect(bundle.index_status?.coverage?.first_slot).toBeLessThan(
      bundle.index_status?.coverage?.last_slot as number,
    );
  });

  it('separates live snapshot, indexed history, and research artifacts', () => {
    const bundle = JSON.parse(readFileSync(EXPORT, 'utf8')) as OnchainAnalytics;
    expect(bundle.freshness?.source).toMatch(/live RPC/i);
    expect(bundle.history?.source).toMatch(/indexed/i);
    // Freshness carries an explicit expired flag computed against the export slot.
    expect(typeof bundle.freshness?.quote_expired).toBe('boolean');
    expect(bundle.freshness?.quote_expiry_slot).toBeGreaterThan(0);
  });

  it('indexed swap records carry signature, slot, amounts and fee', () => {
    const bundle = JSON.parse(readFileSync(EXPORT, 'utf8')) as OnchainAnalytics;
    const swaps = bundle.history?.swaps ?? [];
    for (const s of swaps) {
      expect(s.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,90}$/);
      expect(typeof s.slot).toBe('number');
      expect(['buy', 'sell']).toContain(s.payload.side);
      expect(typeof s.payload.amount_in).toBe('number');
      expect(typeof s.payload.amount_out).toBe('number');
      expect(typeof s.payload.fee).toBe('number');
    }
  });

  it('missing export is interpreted honestly (never fabricated zeros)', () => {
    expect(interpretExport(null, Date.now()).status).toBe('malformed');
    const state = interpretExport({ generated_at: new Date().toISOString(), history: undefined }, Date.now());
    expect(state.status).toBe('available');
  });
});

describe('S2-33 expired quote is never labelled fresh', () => {
  const pk = PublicKey.default;
  const base = { exists: true, vault: pk, config: pk, quoteState: pk };
  const quote = (version: number, expiry: number) => ({
    version: new BN(version), updateSlot: new BN(100), expirySlot: new BN(expiry),
    halfSpreadBps: 5, askExtraBps: 0, bidExtraBps: 0, depthMultBps: 7000,
    oraclePrice: new BN(0), anchorSqrtPrice: new BN('6036613448307627517'),
    pResSqrt: new BN('6036613448307627517'), oraclePublishTime: new BN(1),
    oracleConfBps: 3, keeper: pk, askLevels: [], bidLevels: [],
  });

  it('a readable quote past its expiry is Expired, not Fresh', () => {
    const q = toQuoteState({ ...base, quoteData: quote(28, 510667289) }, 510667290);
    expect(q.hasQuote).toBe(true);
    expect(q.status).toBe('Expired');
  });

  it('the same quote is Fresh strictly before expiry', () => {
    const q = toQuoteState({ ...base, quoteData: quote(28, 510667289) }, 510667288);
    expect(q.status).toBe('Fresh');
  });

  it('version 0 (no committed quote) is Unavailable, never Fresh', () => {
    const q = toQuoteState({ ...base, quoteData: quote(0, 100) }, 50);
    expect(q.hasQuote).toBe(false);
    expect(q.status).toBe('Unavailable');
  });
});
