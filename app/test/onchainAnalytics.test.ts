import { describe, it, expect } from 'vitest';
import {
  interpretExport,
  loadOnchainAnalytics,
  exportProblem,
} from '../src/data/onchainAnalytics';

const NOW = Date.parse('2026-01-01T12:00:00Z');

describe('on-chain analytics export', () => {
  it('accepts a fresh export', () => {
    const s = interpretExport({ generated_at: '2026-01-01T11:59:00Z' }, NOW);
    expect(s.status).toBe('available');
    if (s.status === 'available') {
      expect(s.problem).toBeNull();
      expect(s.ageSeconds).toBe(60);
    }
  });

  it('does not flag an old export as a problem (history is historical)', () => {
    const s = interpretExport({ generated_at: '2026-01-01T10:00:00Z' }, NOW);
    expect(s.status).toBe('available');
    if (s.status === 'available') {
      expect(s.problem).toBeNull();
      expect(s.ageSeconds).toBeGreaterThan(3_600);
    }
  });

  it('flags a structurally broken export, regardless of age', () => {
    const broken = {
      generated_at: '2026-01-01T11:59:00Z',
      index_status: { ingest_errors: [{ slot: 1 }] },
    };
    expect(exportProblem(broken)).toMatch(/ingest error/);
    const s = interpretExport(broken, NOW);
    if (s.status === 'available') expect(s.problem).toMatch(/ingest error/);

    const empty = {
      generated_at: '2026-01-01T11:59:00Z',
      history: { coverage: { last_slot: null } },
    };
    expect(exportProblem(empty)).toMatch(/empty/);
  });

  it('rejects a missing/invalid timestamp as malformed', () => {
    expect(interpretExport({}, NOW).status).toBe('malformed');
    expect(interpretExport({ generated_at: 'not-a-date' }, NOW).status).toBe('malformed');
  });

  it('rejects non-object bodies', () => {
    expect(interpretExport(null, NOW).status).toBe('malformed');
    expect(interpretExport([1, 2], NOW).status).toBe('malformed');
  });

  it('maps missing / error / ok fetch results', async () => {
    const missing = await loadOnchainAnalytics((async () => ({ status: 404, ok: false })) as unknown as typeof fetch, NOW);
    expect(missing.status).toBe('missing');

    const errored = await loadOnchainAnalytics((async () => ({ status: 500, ok: false })) as unknown as typeof fetch, NOW);
    expect(errored.status).toBe('error');

    const ok = await loadOnchainAnalytics(
      (async () => ({ status: 200, ok: true, json: async () => ({ generated_at: '2026-01-01T11:30:00Z' }) })) as unknown as typeof fetch,
      NOW,
    );
    expect(ok.status).toBe('available');

    const threw = await loadOnchainAnalytics((async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch, NOW);
    expect(threw.status).toBe('error');
  });

  it('treats an HTML (SPA-fallback) response as missing, not an error', async () => {
    const html = await loadOnchainAnalytics(
      (async () => ({
        status: 200,
        ok: true,
        headers: { get: () => 'text/html' },
        json: async () => {
          throw new Error('not json');
        },
      })) as unknown as typeof fetch,
      NOW,
    );
    expect(html.status).toBe('missing');
  });
});
