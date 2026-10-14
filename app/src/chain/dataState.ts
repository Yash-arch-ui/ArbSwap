// S2-36: shared, typed live-data state model.
//
// Every displayed live value carries an explicit provenance/health state so the
// UI can never present unavailable or stale data as healthy live state. This
// module is pure (no RPC, no React) and unit-testable.
import { classifyRpcError, type RpcFailure } from './rpcFailover';

/**
 * `loading`     — the first authoritative read has not completed.
 * `live`        — a read succeeded and passed validation just now.
 * `stale`       — a previously valid value is retained but the latest read
 *                 failed or the value (e.g. a quote) is past its validity.
 * `unavailable` — no trustworthy value exists (missing account, or a failed read
 *                 with no prior value).
 * `invalid`     — a read returned data that failed validation (owner, layout,
 *                 discriminator, cluster).
 */
export type SourceState = 'loading' | 'live' | 'stale' | 'unavailable' | 'invalid';

/**
 * A reason for a value being absent/bad. RPC transport failures are distinct
 * from an authoritative "the account is not there".
 */
export type SourceError =
  | RpcFailure // 'rate_limited' | 'timeout' | 'http' | 'network' | 'unknown'
  | 'not_found'
  | 'invalid_owner'
  | 'invalid_layout'
  | 'malformed'
  | 'cluster_mismatch';

const RPC_KINDS: SourceError[] = ['rate_limited', 'timeout', 'http', 'network', 'unknown'];

/** True for transport/availability failures (never proof of account absence). */
export function isTransportError(kind: SourceError | null | undefined): boolean {
  return kind != null && RPC_KINDS.includes(kind);
}

export interface Sourced<T> {
  state: SourceState;
  /** Last successfully-read value, retained across failures (may be stale). */
  value: T | null;
  /** Unix ms of the last successful read, or null if none. */
  asOf: number | null;
  /** Sanitized, human-readable reason (never a raw RPC object or credential). */
  reason: string | null;
  /** Machine classification of the last failure, or null on success. */
  errorKind: SourceError | null;
}

export function loadingSource<T>(reason = 'First read has not completed.'): Sourced<T> {
  return { state: 'loading', value: null, asOf: null, reason, errorKind: null };
}

export function liveSource<T>(value: T, asOf: number): Sourced<T> {
  return { state: 'live', value, asOf, reason: null, errorKind: null };
}

/** Retain a previous value after a failed refresh, explicitly marked stale. */
export function staleSource<T>(prev: Sourced<T>, reason: string, errorKind: SourceError): Sourced<T> {
  return { state: 'stale', value: prev.value, asOf: prev.asOf, reason, errorKind };
}

export function unavailableSource<T>(reason: string, errorKind: SourceError | null = null): Sourced<T> {
  return { state: 'unavailable', value: null, asOf: null, reason, errorKind };
}

export function invalidSource<T>(reason: string, errorKind: SourceError): Sourced<T> {
  return { state: 'invalid', value: null, asOf: null, reason, errorKind };
}

/** Classify a thrown error into a sanitized source error + message. */
export function sourceErrorFromException(err: unknown): { kind: SourceError; reason: string } {
  const kind = classifyRpcError(err) as SourceError;
  const msg = sanitizeReason((err as Error)?.message);
  const friendly: Record<string, string> = {
    rate_limited: 'Devnet RPC is rate-limiting requests (HTTP 429).',
    timeout: 'The RPC request timed out.',
    http: 'The RPC endpoint returned an HTTP error.',
    network: 'The RPC endpoint could not be reached.',
    unknown: 'The RPC read failed.',
  };
  return { kind, reason: friendly[kind] ?? friendly.unknown + (msg ? ` (${msg})` : '') };
}

/**
 * Strip credentials/query strings and cap length so nothing sensitive or huge
 * reaches the DOM. Raw JSON-RPC error objects must never be rendered verbatim.
 */
export function sanitizeReason(message: string | undefined | null): string {
  if (!message) return '';
  return String(message)
    .replace(/https?:\/\/[^\s"']+/g, (u) => {
      try {
        const parsed = new URL(u);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
      } catch {
        return '<rpc-url>';
      }
    })
    // Drop any query-string credential values (generic; never names a token).
    .replace(/\?[^\s"']*/g, '?<redacted>')
    .slice(0, 200);
}
