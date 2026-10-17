// Public LVR transparency: strict parser for the optional published
// `/analytics/lvr_history.json` artifact (see `docs/PUBLIC_LVR_TRANSPARENCY_PLAN.md`).
//
// The artifact is optional. Missing, stale, malformed or partially-covered data
// is surfaced with an explicit state and a reason — missing values are NEVER
// coerced to zero, and an unavailable metric must be `null`, not `0`.

export type LvrProvenance = 'modeled' | 'indexed' | 'on-chain-verified';

export interface LvrRow {
  date: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  seconds: number;
  swaps: number;
  volumeUsd: number;
  passiveLvrUsd: number | null;
  arbswapLvrUsd: number | null;
  arbswapMarkout2sBps: number | null;
  lvrReductionPct: number | null;
  feesUsd: number | null;
  netLpImpactUsd: number | null;
  coverageBps: number;
  status: LvrProvenance;
}

export interface LvrHistory {
  schemaVersion: number;
  generatedAt: string;
  benchmark: string;
  markoutSeconds: number;
  units: Record<string, string>;
  rows: LvrRow[];
  totals: Record<string, number | null>;
  unavailable: Record<string, string>;
  limitations: string[];
}

export type LvrHistoryState =
  | { status: 'loading' }
  | { status: 'available'; data: LvrHistory; ageSeconds: number; stale: boolean }
  | { status: 'missing' }
  | { status: 'malformed'; reason: string }
  | { status: 'error'; reason: string };

/** Modeled weekly artifact: staleness is informational, not a freshness SLA. */
export const LVR_STALE_AFTER_SECONDS = 60 * 60 * 24 * 14;
export const LVR_SCHEMA_VERSION = 1;
export const LVR_ARTIFACT_PATH = '/analytics/lvr_history.json';

const PROVENANCE: ReadonlySet<string> = new Set(['modeled', 'indexed', 'on-chain-verified']);
const ROW_REQUIRED = [
  'date', 'period_start', 'period_end', 'swaps', 'volume_usd', 'passive_lvr_usd',
  'arbswap_lvr_usd', 'fees_usd', 'net_lp_impact_usd', 'coverage_bps', 'status',
] as const;

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isIsoDate = (v: unknown): boolean =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/** Parse a metric that is legitimately `null` (unavailable) or a finite number ≥ 0. */
function metric(v: unknown, field: string, rowIndex: number): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  throw new Error(`row ${rowIndex} invalid ${field}`);
}

/** Parse a signed metric that may be `null` or any finite number (e.g. a %). */
function signedMetric(v: unknown, field: string, rowIndex: number): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  throw new Error(`row ${rowIndex} invalid ${field}`);
}

function parseRow(raw: unknown, index: number, unavailableKeys: Set<string>): LvrRow {
  if (!isObj(raw)) throw new Error(`row ${index} is not an object`);
  for (const key of ROW_REQUIRED) {
    if (!(key in raw)) throw new Error(`row ${index} missing ${key}`);
  }
  if (!isIsoDate(raw.date) || !isIsoDate(raw.period_start) || !isIsoDate(raw.period_end)) {
    throw new Error(`row ${index} malformed date`);
  }
  const coverage = raw.coverage_bps;
  if (typeof coverage !== 'number' || !Number.isInteger(coverage) || coverage < 0 || coverage > 10_000) {
    throw new Error(`row ${index} invalid coverage_bps`);
  }
  if (typeof raw.status !== 'string' || !PROVENANCE.has(raw.status)) {
    throw new Error(`row ${index} invalid status`);
  }
  if (typeof raw.swaps !== 'number' || !Number.isInteger(raw.swaps) || raw.swaps < 0) {
    throw new Error(`row ${index} invalid swaps`);
  }
  // A metric the artifact declares unavailable must be null, never a substituted 0.
  for (const key of unavailableKeys) {
    if (raw[key] === 0) throw new Error(`row ${index} ${key} is a substituted zero`);
  }
  return {
    date: raw.date as string,
    label: typeof raw.label === 'string' ? raw.label : String(raw.date),
    periodStart: raw.period_start as string,
    periodEnd: raw.period_end as string,
    seconds: typeof raw.seconds === 'number' && Number.isFinite(raw.seconds) ? raw.seconds : 0,
    swaps: raw.swaps,
    volumeUsd: metric(raw.volume_usd, 'volume_usd', index) ?? 0,
    passiveLvrUsd: metric(raw.passive_lvr_usd, 'passive_lvr_usd', index),
    arbswapLvrUsd: metric(raw.arbswap_lvr_usd, 'arbswap_lvr_usd', index),
    arbswapMarkout2sBps: metric(raw.arbswap_markout_2s_bps, 'arbswap_markout_2s_bps', index),
    lvrReductionPct: signedMetric(raw.lvr_reduction_pct, 'lvr_reduction_pct', index),
    feesUsd: metric(raw.fees_usd, 'fees_usd', index),
    netLpImpactUsd: metric(raw.net_lp_impact_usd, 'net_lp_impact_usd', index),
    coverageBps: coverage,
    status: raw.status as LvrProvenance,
  };
}

/** Pure, testable interpretation of the LVR artifact. Never throws. */
export function interpretLvrHistory(raw: unknown, nowMs: number): LvrHistoryState {
  if (!isObj(raw)) return { status: 'malformed', reason: 'artifact is not a JSON object' };
  if (raw.schema_version !== LVR_SCHEMA_VERSION) {
    return { status: 'malformed', reason: `unsupported schema_version ${String(raw.schema_version)}` };
  }
  const generatedAt = raw.generated_at;
  if (typeof generatedAt !== 'string' || Number.isNaN(Date.parse(generatedAt))) {
    return { status: 'malformed', reason: 'missing or invalid generated_at' };
  }
  if (typeof raw.benchmark !== 'string' || raw.benchmark.length === 0) {
    return { status: 'malformed', reason: 'missing benchmark metadata' };
  }
  if (typeof raw.markout_seconds !== 'number' || !Number.isFinite(raw.markout_seconds)) {
    return { status: 'malformed', reason: 'missing markout_seconds' };
  }
  if (!Array.isArray(raw.rows) || raw.rows.length === 0) {
    return { status: 'malformed', reason: 'rows must be a non-empty array' };
  }
  const unavailable = isObj(raw.unavailable) ? (raw.unavailable as Record<string, string>) : {};
  const unavailableKeys = new Set(Object.keys(unavailable));
  let rows: LvrRow[];
  try {
    rows = raw.rows.map((r, i) => parseRow(r, i, unavailableKeys));
  } catch (error) {
    return { status: 'malformed', reason: (error as Error).message };
  }
  const data: LvrHistory = {
    schemaVersion: LVR_SCHEMA_VERSION,
    generatedAt,
    benchmark: raw.benchmark,
    markoutSeconds: raw.markout_seconds,
    units: isObj(raw.units) ? (raw.units as Record<string, string>) : {},
    rows,
    totals: isObj(raw.totals) ? (raw.totals as Record<string, number | null>) : {},
    unavailable,
    limitations: Array.isArray(raw.limitations) ? raw.limitations.filter((s): s is string => typeof s === 'string') : [],
  };
  const ageSeconds = Math.max(0, (nowMs - Date.parse(generatedAt)) / 1000);
  return { status: 'available', data, ageSeconds, stale: ageSeconds > LVR_STALE_AFTER_SECONDS };
}

/** Fetch and interpret the optional LVR artifact. Never throws. */
export async function loadLvrHistory(
  fetchFn: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<LvrHistoryState> {
  try {
    const res = await fetchFn(LVR_ARTIFACT_PATH);
    if (res.status === 404) return { status: 'missing' };
    if (!res.ok) return { status: 'error', reason: `HTTP ${res.status}` };
    // A dev/SPA server may answer unknown paths with index.html (HTTP 200).
    const contentType = res.headers?.get?.('content-type');
    if (contentType && !contentType.includes('json')) return { status: 'missing' };
    const json = await res.json();
    return interpretLvrHistory(json, nowMs);
  } catch (error) {
    return { status: 'error', reason: (error as Error).message ?? 'fetch failed' };
  }
}
