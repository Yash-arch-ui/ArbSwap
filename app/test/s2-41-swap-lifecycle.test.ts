import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { explainSwapError } from '../src/chain/program';

const swapSrc = readFileSync(
  fileURLToPath(new URL('../src/pages/SwapPage.tsx', import.meta.url)),
  'utf8',
);

describe('S2-41 swap lifecycle: simulate → preview → confirm', () => {
  it('simulates and previews before any wallet signature', () => {
    const sim = swapSrc.indexOf('await simulateSwap(');
    const preview = swapSrc.indexOf('setPreview(r.plan)');
    const send = swapSrc.indexOf('await sendSwapTransaction(');
    expect(sim).toBeGreaterThan(-1);
    expect(preview).toBeGreaterThan(sim);
    expect(send).toBeGreaterThan(preview);
  });
  it('renders an explicit preview panel and re-validates at confirm', () => {
    expect(swapSrc).toMatch(/data-testid="swap-preview"/);
    expect(swapSrc).toMatch(/Confirm & sign in wallet/);
    // confirm rebuilds/re-simulates via buildPlan rather than reusing the tx blindly
    expect(swapSrc).toMatch(/const handleConfirm[\s\S]{0,400}buildPlan\(\)/);
    // a stale quote is never submitted: freshness is re-checked inside buildPlan
    expect(swapSrc).toMatch(/submitFreshnessReason\(fresh\)/);
  });
  it('never marks success before the awaited send', () => {
    const send = swapSrc.indexOf('await sendSwapTransaction(');
    const firstOk = swapSrc.indexOf('ok: true');
    expect(firstOk).toBeGreaterThan(send);
  });
});

describe('S2-41 swap error decoding', () => {
  it('explains QuoteExpired (6030) and CapacityExceeded (6033)', () => {
    expect(explainSwapError({ InstructionError: [1, { Custom: 6030 }] })).toMatch(/expired/i);
    expect(explainSwapError({ InstructionError: [1, { Custom: 6033 }] })).toMatch(/cannot fill this size|reduce/i);
    expect(explainSwapError({ value: { err: { InstructionError: [1, { Custom: 6032 }] } } })).toMatch(/slippage|minimum output/i);
  });
  it('falls back to a bounded message for unknown errors', () => {
    const msg = explainSwapError({ message: 'x'.repeat(500) });
    expect(msg.length).toBeLessThanOrEqual(160);
  });
});
