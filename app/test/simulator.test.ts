import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import streams from '../src/data/demoStreams.json';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

describe('Simulator page (offline, deterministic)', () => {
  const ids = ['calm', 'trend', 'crash', 'jump', 'freeze', 'kill', 'bot', 'malicious'];
  it('has all 8 scenarios with equal-length series and events', () => {
    for (const id of ids) {
      const s = (streams as any).streams[id];
      expect(s, id).toBeTruthy();
      expect(s.mid.length).toBe((streams as any).meta.steps);
      expect(s.arbSwap.length).toBe(s.mid.length);
      expect(s.passive.length).toBe(s.mid.length);
      expect(typeof s.events).toBe('object');
    }
  });
  it('is labelled simulation, no funds involved', () => {
    expect((streams as any).meta.label).toBe('simulation, no funds involved');
    expect((streams as any).meta.note).toMatch(/not economic proof/i);
  });
  it('published and bundled stream bytes are identical', () => {
    const pub = readFileSync(here('../../artifacts/public/demo_streams.json'), 'utf8');
    const app = readFileSync(here('../src/data/demoStreams.json'), 'utf8');
    expect(app).toBe(pub);
  });
  it('makes no network call, wallet connection or transaction', () => {
    const src = readFileSync(here('../src/pages/SimulatorPage.tsx'), 'utf8');
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/axios|XMLHttpRequest|@solana\/web3|useWallet|sendTransaction/);
  });
  it('no longer ships Claims/Evidence pages', () => {
    expect(() => readFileSync(here('../src/pages/ClaimsPage.tsx'))).toThrow();
    expect(() => readFileSync(here('../src/pages/EvidencePage.tsx'))).toThrow();
  });
});
