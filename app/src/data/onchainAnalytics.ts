// S2-25: optional historical on-chain analytics export (`/analytics/onchain.json`,
// written by `simulation/analytics/export.py`). This is HISTORICAL/read-only —
// live balances, quotes, reserves, and protocol status always come from RPC, never
// from this file. The export is optional; missing/stale data is shown as
// unavailable with a reason, never fabricated.

export interface IndexedEvent {
  signature: string;
  slot: number;
  block_time: number | null;
  event_type: string;
  /** Event-specific Borsh payload (e.g. side/amount_in/amount_out/fee/version). */
  payload: Record<string, unknown> & {
    side?: string;
    amount_in?: number;
    amount_out?: number;
    fee?: number;
    version?: number;
    shares?: number;
    base_amount?: number;
    quote_amount?: number;
    nonce?: number;
  };
}

export interface IndexCoverage {
  first_slot: number | null;
  last_slot: number | null;
  first_block_time: number | null;
  last_block_time: number | null;
  transactions: number;
  events: number;
  first_indexed_at: string | null;
  last_indexed_at: string | null;
}

export interface HistorySection {
  source: string;
  coverage: IndexCoverage;
  swaps: IndexedEvent[];
  deposits: IndexedEvent[];
  withdrawals: IndexedEvent[];
  quote_commits: IndexedEvent[];
  quote_commits_truncated: number;
  quote_attribution_note: string;
}

export interface OnchainAnalytics {
  generated_at: string;
  network?: string;
  canonical?: Record<string, string>;
  index_status?: {
    schema_version?: number;
    last_slot?: number;
    last_indexed_at?: string | null;
    coverage?: IndexCoverage;
    counts?: Record<string, number>;
    ingest_errors?: Array<Record<string, unknown>>;
    [k: string]: unknown;
  };
  freshness?: {
    generated_at?: string;
    current_slot?: number | null;
    quote_version?: number | null;
    quote_expiry_slot?: number | null;
    quote_expired?: boolean | null;
    source?: string;
  };
  protocol_live?: Record<string, unknown>;
  trading?: {
    trade_count?: number;
    failed_transactions?: number;
    success_rate?: number | null;
    buy_base?: Record<string, unknown>;
    sell_base?: Record<string, unknown>;
    source?: string;
    status?: string;
  };
  history?: HistorySection;
  lp?: Record<string, unknown>;
  [k: string]: unknown;
}

export type AnalyticsExportState =
  | { status: 'loading' }
  | { status: 'available'; data: OnchainAnalytics; ageSeconds: number; problem: string | null }
  | { status: 'missing' }
  | { status: 'malformed'; reason: string }
  | { status: 'error'; reason: string };

/**
 * This export is an intentionally historical, read-only archive: its age is
 * informational and must never be presented as a failure. A snapshot is only
 * flagged when the export is structurally broken/incomplete (the indexer
 * reported ingest errors, or the indexed coverage window is empty) — i.e. stale
 * content, not merely an old timestamp.
 */
export function exportProblem(data: OnchainAnalytics): string | null {
  const errors = data.index_status?.ingest_errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return `the indexer reported ${errors.length} ingest error(s)`;
  }
  const cov = data.history?.coverage ?? data.index_status?.coverage;
  if (cov && (cov.last_slot === null || cov.last_slot === undefined)) {
    return 'the indexed coverage window is empty';
  }
  return null;
}

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
  const data = obj as unknown as OnchainAnalytics;
  return {
    status: 'available',
    data,
    ageSeconds,
    problem: exportProblem(data),
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
