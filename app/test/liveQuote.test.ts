import { describe, it, expect } from 'vitest';
import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { classifyQuoteFreshness, LiveQuoteFeed, type LiveQuoteUpdate } from '../src/chain/liveQuote';
import type { OnChainQuote } from '../src/chain/program';

const quote = (version: number, expirySlot: number, keeper: PublicKey = PublicKey.default): OnChainQuote => ({
  version: new BN(version), updateSlot: new BN(0), expirySlot: new BN(expirySlot),
  halfSpreadBps: 0, askExtraBps: 0, bidExtraBps: 0, depthMultBps: 0,
  oraclePrice: new BN(0), anchorSqrtPrice: new BN(0), pResSqrt: new BN(0),
  oraclePublishTime: new BN(0), oracleConfBps: 0, keeper, askLevels: [], bidLevels: [],
});

describe('classifyQuoteFreshness mirrors the deployed freshness semantics', () => {
  it('Unavailable when there is no attributed quote', () => {
    expect(classifyQuoteFreshness(0n, 100n, 50n)).toBe('Unavailable');
    expect(classifyQuoteFreshness(5n, 0n, 50n)).toBe('Unavailable');
  });
  it('Fresh before the expiry slot, Expired at/after it', () => {
    expect(classifyQuoteFreshness(5n, 100n, 99n)).toBe('Fresh');
    expect(classifyQuoteFreshness(5n, 100n, 100n)).toBe('Expired');
    expect(classifyQuoteFreshness(5n, 100n, 130n)).toBe('Expired');
  });
  it('Aging inside the grace band only', () => {
    expect(classifyQuoteFreshness(5n, 100n, 96n, 5)).toBe('Aging');
    expect(classifyQuoteFreshness(5n, 100n, 94n, 5)).toBe('Fresh');
  });
});

describe('LiveQuoteFeed observes a new version and never presents a stale one', () => {
  const collect = () => {
    const updates: LiveQuoteUpdate[] = [];
    return { updates, onUpdate: (u: LiveQuoteUpdate) => updates.push(u) };
  };

  it('emits Fresh for a newly committed version, then Expired as the slot advances', async () => {
    let slot = 100;
    const { updates, onUpdate } = collect();
    const feed = new LiveQuoteFeed({
      fetchSlot: async () => slot,
      fetchQuote: async () => quote(7, 110),
      onUpdate,
    });
    await feed.tick();
    // A new version appears (the feed re-tick observes it).
    slot = 105;
    await feed.tick();
    // The window passes with no new commit.
    slot = 110;
    await feed.tick();
    expect(updates.map((u) => u.status)).toEqual(['Fresh', 'Fresh', 'Expired']);
    expect(updates.map((u) => u.executable)).toEqual([true, true, false]);
    expect(updates.at(-1)!.version).toBe(7);
  });

  it('treats a missing/undecodable quote as Unavailable, never executable', async () => {
    const { updates, onUpdate } = collect();
    const feed = new LiveQuoteFeed({ fetchSlot: async () => 100, fetchQuote: async () => null, onUpdate });
    await feed.tick();
    expect(updates[0].status).toBe('Unavailable');
    expect(updates[0].executable).toBe(false);
  });

  it('ignores an out-of-order (regressing) slot and never emits for it', async () => {
    let slot = 200;
    const { updates, onUpdate } = collect();
    const feed = new LiveQuoteFeed({ fetchSlot: async () => slot, fetchQuote: async () => quote(9, 210), onUpdate });
    await feed.tick();
    slot = 190; // a slow/retried response must not regress the view
    const skipped = await feed.tick();
    expect(skipped).toBeNull();
    expect(updates).toHaveLength(1);
  });

  it('retains the last quote across a transient RPC error but recomputes by slot', async () => {
    let slot = 100;
    let fail = false;
    const { updates, onUpdate } = collect();
    const feed = new LiveQuoteFeed({
      fetchSlot: async () => slot,
      fetchQuote: async () => { if (fail) throw new Error('429 too many requests'); return quote(11, 120); },
      onUpdate,
      onError: () => undefined,
    });
    await feed.tick(); // fresh
    fail = true;
    slot = 119;
    await feed.tick(); // error retained, still fresh by slot
    slot = 121;
    await feed.tick(); // error retained, now expired — never executable
    fail = false;
    slot = 122;
    await feed.tick(); // recovered read
    expect(updates.map((u) => u.executable)).toEqual([true, true, false, false]);
    expect(updates[0].sourceOk).toBe(true);
    expect(updates[2].sourceOk).toBe(false);
    expect(updates[3].sourceOk).toBe(true);
  });
});
