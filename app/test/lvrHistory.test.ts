import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  interpretLvrHistory, loadLvrHistory, LVR_ARTIFACT_PATH, LVR_SCHEMA_VERSION,
  type LvrHistoryState,
} from '../src/data/lvrHistory';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

function validArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    generated_at: '2026-01-01T11:00:00Z',
    benchmark: 'pyth_mid_plus_venue_mid',
    markout_seconds: 2,
    units: { lvr: 'quote_usd', fees: 'quote_usd', markout: 'bps', coverage: 'bps' },
    rows: [{
      date: '2026-08-31', label: 'W2', period_start: '2026-08-31', period_end: '2026-09-06',
      seconds: 604800, swaps: 100, volume_usd: 1000, passive_lvr_usd: 10,
      arbswap_lvr_usd: null, arbswap_markout_2s_bps: 5, fees_usd: 20,
      net_lp_impact_usd: null, coverage_bps: 10000, status: 'modeled',
    }],
    totals: { passive_lvr_usd: 10, fees_usd: 20, arbswap_lvr_usd: null, net_lp_impact_usd: null },
    unavailable: { arbswap_lvr_usd: 'not measured', net_lp_impact_usd: 'not computed' },
    limitations: ['modeled, not measured'],
    ...overrides,
  };
}

const avail = (raw: unknown): Extract<LvrHistoryState, { status: 'available' }> => {
  const s = interpretLvrHistory(raw, NOW);
  expect(s.status).toBe('available');
  return s as Extract<LvrHistoryState, { status: 'available' }>;
};

describe('interpretLvrHistory: strict schema validation', () => {
  it('accepts a valid artifact and computes age', () => {
    const s = avail(validArtifact());
    expect(s.ageSeconds).toBe(3600);
    expect(s.stale).toBe(false);
    expect(s.data.schemaVersion).toBe(LVR_SCHEMA_VERSION);
    expect(s.data.rows[0].passiveLvrUsd).toBe(10);
  });

  it('rejects non-objects', () => {
    for (const bad of [null, [], 'x', 3]) {
      expect(interpretLvrHistory(bad, NOW).status).toBe('malformed');
    }
  });

  it('rejects unsupported schema_version', () => {
    expect(interpretLvrHistory(validArtifact({ schema_version: 2 }), NOW).status).toBe('malformed');
  });

  it('rejects missing/invalid generated_at and benchmark', () => {
    expect(interpretLvrHistory(validArtifact({ generated_at: 'nope' }), NOW).status).toBe('malformed');
    expect(interpretLvrHistory(validArtifact({ benchmark: '' }), NOW).status).toBe('malformed');
    expect(interpretLvrHistory(validArtifact({ markout_seconds: 'x' }), NOW).status).toBe('malformed');
  });

  it('rejects empty rows', () => {
    expect(interpretLvrHistory(validArtifact({ rows: [] }), NOW).status).toBe('malformed');
  });

  it('rejects negative coverage and non-finite numbers', () => {
    const row = (r: Record<string, unknown>) => validArtifact({ rows: [r] });
    const base = (validArtifact().rows as Record<string, unknown>[])[0];
    expect(interpretLvrHistory(row({ ...base, coverage_bps: -1 }), NOW).status).toBe('malformed');
    expect(interpretLvrHistory(row({ ...base, coverage_bps: 20000 }), NOW).status).toBe('malformed');
    expect(interpretLvrHistory(row({ ...base, passive_lvr_usd: Number.NaN }), NOW).status).toBe('malformed');
    expect(interpretLvrHistory(row({ ...base, fees_usd: Number.POSITIVE_INFINITY }), NOW).status).toBe('malformed');
  });

  it('rejects malformed dates and unknown status', () => {
    const base = (validArtifact().rows as Record<string, unknown>[])[0];
    expect(interpretLvrHistory(validArtifact({ rows: [{ ...base, period_start: 'x' }] }), NOW).status).toBe('malformed');
    expect(interpretLvrHistory(validArtifact({ rows: [{ ...base, status: 'bogus' }] }), NOW).status).toBe('malformed');
  });

  it('rejects a substituted zero for a declared-unavailable metric', () => {
    const base = (validArtifact().rows as Record<string, unknown>[])[0];
    const bad = validArtifact({ rows: [{ ...base, arbswap_lvr_usd: 0 }] });
    expect(interpretLvrHistory(bad, NOW).status).toBe('malformed');
  });
});

describe('interpretLvrHistory: missing vs zero', () => {
  it('keeps null metrics null (never coerces to zero)', () => {
    const s = avail(validArtifact());
    expect(s.data.rows[0].arbswapLvrUsd).toBeNull();
    expect(s.data.rows[0].netLpImpactUsd).toBeNull();
  });

  it('parses the modeled E1 LVR-reduction % (and allows it to be negative)', () => {
    const base = (validArtifact().rows as Record<string, unknown>[])[0];
    const pos = avail(validArtifact({ rows: [{ ...base, lvr_reduction_pct: 686.9 }] }));
    expect(pos.data.rows[0].lvrReductionPct).toBeCloseTo(686.9, 3);
    const neg = avail(validArtifact({ rows: [{ ...base, lvr_reduction_pct: -12.5 }] }));
    expect(neg.data.rows[0].lvrReductionPct).toBeCloseTo(-12.5, 3);
    // Absent -> null (not zero).
    expect(avail(validArtifact()).data.rows[0].lvrReductionPct).toBeNull();
  });

  it('marks an old artifact stale', () => {
    const s = avail(validArtifact({ generated_at: '2025-01-01T00:00:00Z' }));
    expect(s.stale).toBe(true);
  });

  it('surfaces unavailable reasons and limitations', () => {
    const s = avail(validArtifact());
    expect(s.data.unavailable.arbswap_lvr_usd).toBeTruthy();
    expect(s.data.limitations.length).toBeGreaterThan(0);
  });
});

describe('loadLvrHistory: fetch state mapping', () => {
  const fake = (impl: () => Promise<unknown>): typeof fetch => impl as unknown as typeof fetch;

  it('maps 404 to missing', async () => {
    const s = await loadLvrHistory(fake(async () => ({ status: 404, ok: false, headers: { get: () => null } })), NOW);
    expect(s.status).toBe('missing');
  });
  it('maps 500 to error', async () => {
    const s = await loadLvrHistory(fake(async () => ({ status: 500, ok: false, headers: { get: () => null } })), NOW);
    expect(s.status).toBe('error');
  });
  it('maps a non-JSON 200 (SPA fallback) to missing', async () => {
    const s = await loadLvrHistory(fake(async () => ({
      status: 200, ok: true, headers: { get: () => 'text/html' }, json: async () => ({}) })), NOW);
    expect(s.status).toBe('missing');
  });
  it('parses a valid JSON 200', async () => {
    const s = await loadLvrHistory(fake(async () => ({
      status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => validArtifact() })), NOW);
    expect(s.status).toBe('available');
  });
  it('maps a thrown fetch to error', async () => {
    const s = await loadLvrHistory(fake(async () => { throw new Error('boom'); }), NOW);
    expect(s.status).toBe('error');
  });
});

describe('published artifact integrity', () => {
  it('the served artifact equals the published artifact (download == displayed)', () => {
    const served = readFileSync(here('../../app/public/analytics/lvr_history.json'), 'utf8');
    const published = readFileSync(here('../../artifacts/public/lvr_history.json'), 'utf8');
    expect(served).toBe(published);
  });

  it('the real artifact parses and declares ArbSwap LVR unavailable', () => {
    const raw = JSON.parse(readFileSync(here('../../artifacts/public/lvr_history.json'), 'utf8'));
    const s = avail(raw);
    expect(s.data.rows.length).toBeGreaterThan(0);
    expect(s.data.rows.every((r) => r.arbswapLvrUsd === null)).toBe(true);
    expect(s.data.rows.every((r) => r.status === 'modeled')).toBe(true);
  });
});

describe('UI wiring (source-level)', () => {
  const panel = readFileSync(here('../src/components/LvrHistoryPanel.tsx'), 'utf8');
  const vault = readFileSync(here('../src/pages/VaultPage.tsx'), 'utf8');
  const analytics = readFileSync(here('../src/pages/AnalyticsPage.tsx'), 'utf8');

  it('downloads the exact artifact path', () => {
    expect(panel).toContain('download');
    expect(panel).toContain('LVR_ARTIFACT_PATH');
    expect(LVR_ARTIFACT_PATH).toBe('/analytics/lvr_history.json');
  });

  it('renders Unavailable for missing metrics and never a fabricated zero', () => {
    expect(panel).toContain("'Unavailable'");
    expect(panel).not.toMatch(/arbswapLvrUsd \?\? 0/);
    expect(panel).not.toMatch(/\+\$0/);
  });

  it('is mounted on the Analytics page', () => {
    expect(analytics).toMatch(/LvrHistoryPanel/);
  });

  it('the Vault summary comes from the artifact, not the hardcoded lvrAvoided7dUsd zero', () => {
    expect(vault).toMatch(/LvrSummaryCard/);
    expect(vault).not.toMatch(/vaultState\.lvrAvoided7dUsd/);
  });
});
