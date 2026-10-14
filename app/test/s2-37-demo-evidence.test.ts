import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateFrames, SCENARIOS } from '../src/data/demoReplay';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

describe('S2-37 demo replay is deterministic and offline', () => {
  it('same (seed, scenario) yields identical frames', () => {
    for (const s of SCENARIOS) {
      expect(generateFrames(42, s.id, 60)).toEqual(generateFrames(42, s.id, 60));
    }
  });
  it('a different seed changes the path', () => {
    const a = generateFrames(1, 'trend', 40).map((f) => f.mid);
    const b = generateFrames(2, 'trend', 40).map((f) => f.mid);
    expect(a).not.toEqual(b);
  });
  it('every scenario yields n frames with finite numbers', () => {
    for (const s of SCENARIOS) {
      const f = generateFrames(7, s.id, 30);
      expect(f).toHaveLength(30);
      expect(f.every((x) => Number.isFinite(x.mid) && Number.isFinite(x.arbSwap))).toBe(true);
    }
  });
  it('demo mode performs no network calls', () => {
    const src = readFileSync(here('../src/data/demoReplay.ts'), 'utf8')
      + readFileSync(here('../src/pages/DemoPage.tsx'), 'utf8');
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/axios|XMLHttpRequest|@solana\/web3/);
  });
});

describe('S2-37 evidence page records real devnet history', () => {
  const src = readFileSync(here('../src/pages/EvidencePage.tsx'), 'utf8');
  it('links the upgrade and set_params signatures to the explorer', () => {
    expect(src).toMatch(/31Aa7GZXKyFzzVNnFE2xfdqhuohdEtuYvE5bJKoixpZ9uMpW77uhpLAaFdCiH17RMB4ReEZpWwWw1Byma6Bqyb7f/);
    expect(src).toMatch(/5rDWeiunvT2nibghefnjZrEKUAwgCb5pPcXSAh68dag5FMjtT8FbU7MGgSJY2JV3AyfBqa4eH2cBqNYmPqu9mec4/);
    expect(src).toMatch(/explorerTxUrl/);
    expect(src).toMatch(/devnet history/);
  });
  it('states the limits and does not claim Option 1', () => {
    expect(src).toMatch(/not re-check oracle age/);
    expect(src).toMatch(/not a guarantee/);
    expect(src).toMatch(/Option 1[\s\S]{0,60}not shown/i);
  });
});
