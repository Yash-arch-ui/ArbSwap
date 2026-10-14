import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * S2-37/7.1: the hosting config must set the security headers and must not place
 * any secret in the build env. Vercel injects `headers` at the edge; this test
 * pins the required set and forbids credentials in `VITE_` variables.
 */
const cfg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../vercel.json', import.meta.url)), 'utf8'),
) as { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>; outputDirectory?: string };

const headerMap = new Map(
  (cfg.headers?.[0]?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value]),
);

describe('S2-37 hosting security headers', () => {
  it('sets CSP with frame-ancestors/none and allows wallet script injection', () => {
    const csp = headerMap.get('content-security-policy') ?? '';
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/object-src 'none'/);
    // Browser wallet extensions inject an inline provider script; a bare
    // script-src 'self' blocks Phantom/Solflare detection on a deployed origin.
    expect(csp).toMatch(/script-src 'self' 'unsafe-inline'/);
  });
  it('sets nosniff, frame denial and a referrer policy', () => {
    expect(headerMap.get('x-content-type-options')).toBe('nosniff');
    expect(headerMap.get('x-frame-options')).toBe('DENY');
    expect(headerMap.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(headerMap.get('permissions-policy')).toMatch(/camera=\(\)/);
  });
  it('serves the built dist and contains no credential-bearing value', () => {
    expect(cfg.outputDirectory).toBe('dist');
    const raw = JSON.stringify(cfg);
    expect(raw).not.toMatch(/api-key=/);
    expect(raw).not.toMatch(/VITE_/);
  });
});
