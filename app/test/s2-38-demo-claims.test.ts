import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import streams from '../src/data/demoStreams.json';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

describe('S2-38 demo streams (bundled, offline)', () => {
  const ids = ['calm', 'trend', 'crash', 'jump', 'freeze', 'kill', 'bot', 'malicious'];
  it('contains all 8 scenarios with equal-length series and events', () => {
    for (const id of ids) {
      const s = (streams as any).streams[id];
      expect(s, id).toBeTruthy();
      expect(s.mid.length).toBe((streams as any).meta.steps);
      expect(s.arbSwap.length).toBe(s.mid.length);
      expect(s.passive.length).toBe(s.mid.length);
      expect(typeof s.events).toBe('object');
    }
  });
  it('is labelled as simulation, no funds involved', () => {
    expect((streams as any).meta.label).toBe('simulation, no funds involved');
    expect((streams as any).meta.note).toMatch(/not economic proof/i);
  });
  it('the published and bundled stream bytes are identical', () => {
    const pub = readFileSync(here('../../artifacts/public/demo_streams.json'), 'utf8');
    const app = readFileSync(here('../src/data/demoStreams.json'), 'utf8');
    expect(app).toBe(pub);
  });
  it('the demo page performs no network call, wallet or transaction', () => {
    const src = readFileSync(here('../src/pages/DemoPage.tsx'), 'utf8');
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/axios|XMLHttpRequest|@solana\/web3|useWallet|sendTransaction/);
  });
});

describe('S2-38 claims page mirrors docs/CLAIMS.md', () => {
  const claims = readFileSync(here('../../docs/CLAIMS.md'), 'utf8');
  const page = readFileSync(here('../src/pages/ClaimsPage.tsx'), 'utf8');
  it('does not claim Option 1 / audit / superiority', () => {
    expect(page).toMatch(/Option 1 \(LVR reduction\) not shown/);
    expect(page).toMatch(/NOT CLAIMED/);
    expect(page).toMatch(/SIMULATION ONLY — UNPROVEN/);
  });
  it('keeps the <=40k CU non-attainment statement', () => {
    expect(page).toMatch(/<=40k target is NOT met/);
    expect(claims).toMatch(/NOT met on the demo host/);
  });
  it('lists the same NOT CLAIMED claims as the ledger', () => {
    const notClaimed = (claims.match(/\*\*NOT CLAIMED\*\*/g) ?? []).length;
    expect(notClaimed).toBeGreaterThanOrEqual(3);
    for (const frag of ['"Beats passive pools" (Option 1)', 'Competitiveness vs tight propAMMs', 'Independent audit']) {
      expect(claims).toContain(frag);
      expect(page).toContain(frag);
    }
  });
});
