// S2-25: optional historical on-chain analytics export (`/analytics/onchain.json`,
// written by `simulation/analytics/export.py`). This is HISTORICAL/read-only —
// live balances, quotes, reserves, and protocol status always come from RPC, never
// from this file. The export is optional; missing/stale data is shown as
// unavailable with a reason, never fabricated.

export interface OnchainAnalytics {
  generated_at: string;
  network?: string;
  canonical?: Record<string, string>;
  index_status?: { schema_version?: number; last_slot?: number; [k: string]: unknown };
  protocol_live?: Record<string, unknown>;
  lp?: Record<string, unknown>;
  [k: string]: unknown;
}

export type AnalyticsExportState =
  | { status: 'loading' }
  | { status: 'available'; data: OnchainAnalytics; ageSeconds: number; stale: boolean }
  | { status: 'missing' }
  | { status: 'malformed'; reason: string }
  | { status: 'error'; reason: string };

/** Exports older than this (seconds) are marked stale. */
export const STALE_AFTER_SECONDS = 3_600;

/** Parse an export body into a state. Pure and testable. */
export function interpretExport(raw: unknown, nowMs: number): AnalyticsExportState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'malformed', reason: 'export is not a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  const generatedAt = obj.generated_at;
  if (typeof generatedAt !== 'string' || Number.isNaN(Date.parse(generatedAt))) {
    return { status: 'malformed', reason: 'missing or invalid generated_at' };
  }
  const ageSeconds = Math.max(0, (nowMs - Date.parse(generatedAt)) / 1000);
  return {
    status: 'available',
    data: obj as unknown as OnchainAnalytics,
    ageSeconds,
    stale: ageSeconds > STALE_AFTER_SECONDS,
  };
}

/** Fetch and interpret the optional export. Never throws. */
export async function loadOnchainAnalytics(
  fetchFn: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<AnalyticsExportState> {
  try {
    const res = await fetchFn('/analytics/onchain.json');
    if (res.status === 404) return { status: 'missing' };
    if (!res.ok) return { status: 'error', reason: `HTTP ${res.status}` };
    // A dev/SPA server may answer unknown paths with index.html (HTTP 200). If the
    // body is not JSON, the optional export simply is not present.
    const contentType = res.headers?.get?.('content-type') ?? '';
    if (contentType && !contentType.includes('json')) return { status: 'missing' };
    const json = await res.json();
    return interpretExport(json, nowMs);
  } catch (error) {
    return { status: 'error', reason: (error as Error).message ?? 'fetch failed' };
  }
}
