import { describe, it, expect } from 'vitest';
import {
  interpretExport,
  loadOnchainAnalytics,
  STALE_AFTER_SECONDS,
} from '../src/data/onchainAnalytics';

const NOW = Date.parse('2026-01-01T12:00:00Z');

describe('on-chain analytics export', () => {
  it('accepts a fresh export', () => {
    const s = interpretExport({ generated_at: '2026-01-01T11:59:00Z' }, NOW);
    expect(s.status).toBe('available');
    if (s.status === 'available') {
      expect(s.stale).toBe(false);
      expect(s.ageSeconds).toBe(60);
    }
  });

  it('marks an old export stale without failing', () => {
    const s = interpretExport({ generated_at: '2026-01-01T10:00:00Z' }, NOW);
    expect(s.status).toBe('available');
    if (s.status === 'available') {
      expect(s.stale).toBe(true);
      expect(s.ageSeconds).toBeGreaterThan(STALE_AFTER_SECONDS);
    }
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
