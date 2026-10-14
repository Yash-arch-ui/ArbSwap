// S2-24/S2-36: browser-side RPC failover with request deduplication, bounded
// retry/backoff, `Retry-After` honoring, and provider health diagnostics.
//
// Availability only — on-chain account state remains the source of truth. This
// layer NEVER submits transactions and never logs credentials.
import { Connection, type Commitment } from '@solana/web3.js';
import { resolveFrontendRpc, redactRpcUrl } from './rpcConfig';

export type RpcFailure = 'rate_limited' | 'timeout' | 'http' | 'network' | 'unknown';

export function classifyRpcError(err: unknown): RpcFailure {
  const e = err as {
    status?: number;
    code?: string;
    response?: { status?: number };
    cause?: { code?: string };
    message?: string;
  };
  const msg = String(e?.message ?? err ?? '');
  const code = e?.code ?? e?.cause?.code;
  if (e?.status === 429 || e?.response?.status === 429 || /429|rate.?limit|too many requests/i.test(msg)) {
    return 'rate_limited';
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || /timeout|timed out/i.test(msg)) {
    return 'timeout';
  }
  if (typeof e?.status === 'number' || typeof e?.response?.status === 'number') return 'http';
  if (
    ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(code ?? '') ||
    /fetch failed|network|socket hang up/i.test(msg)
  ) {
    return 'network';
  }
  return 'unknown';
}

export function isRetryable(f: RpcFailure): boolean {
  return f !== 'unknown';
}

export function backoffDelayMs(attempt: number, baseMs = 250, capMs = 4_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.min(capMs, exp + Math.floor(Math.random() * baseMs));
}

/** Parse `Retry-After` (seconds or HTTP-date) from a thrown error, bounded. */
export function retryAfterMs(err: unknown, capMs = 30_000): number | null {
  const e = err as { retryAfterSeconds?: number; headers?: Record<string, string>; response?: { headers?: { get?: (k: string) => string | null } } };
  let raw: string | number | null | undefined = e?.retryAfterSeconds;
  if (raw == null && typeof e?.response?.headers?.get === 'function') {
    raw = e.response.headers.get('retry-after');
  }
  if (raw == null && e?.headers) raw = e.headers['retry-after'] ?? e.headers['Retry-After'];
  if (raw == null) return null;
  let ms: number;
  if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
    ms = Number(raw) * 1000;
  } else {
    const when = Date.parse(String(raw));
    if (Number.isNaN(when)) return null;
    ms = when - Date.now();
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, capMs);
}

export interface RpcHealthSnapshot {
  endpoint: string;
  attempts: number;
  successes: number;
  failures: number;
  failuresByKind: Record<RpcFailure, number>;
  consecutiveFailures: number;
  lastErrorKind: RpcFailure | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  inflight: number;
}

export interface RpcFailoverOptions {
  endpoints: string[];
  commitment?: Commitment;
  maxAttemptsPerEndpoint?: number;
  makeConnection?: (url: string, commitment: Commitment) => Connection;
  sleep?: (ms: number) => Promise<void>;
  onFailover?: (from: string, to: string, failure: RpcFailure) => void;
  now?: () => number;
}

/**
 * Ordered endpoint failover for the app's read path. Retries transient failures
 * with bounded, jittered backoff (honoring `Retry-After`), moves to the next
 * endpoint, and never masks a program/unknown error. Concurrent identical reads
 * share one in-flight request via {@link runKeyed}.
 */
export class RpcFailover {
  private readonly conns: Connection[];
  private readonly urls: string[];
  private index = 0;
  private readonly per: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onFailover?: (from: string, to: string, failure: RpcFailure) => void;
  private readonly now: () => number;
  private readonly inflight = new Map<string, Promise<unknown>>();

  private stats = {
    attempts: 0,
    successes: 0,
    failures: 0,
    failuresByKind: { rate_limited: 0, timeout: 0, http: 0, network: 0, unknown: 0 } as Record<RpcFailure, number>,
    consecutiveFailures: 0,
    lastErrorKind: null as RpcFailure | null,
    lastErrorAt: null as number | null,
    lastSuccessAt: null as number | null,
  };

  constructor(opts: RpcFailoverOptions) {
    if (opts.endpoints.length === 0) throw new Error('RpcFailover requires at least one endpoint');
    const commitment = opts.commitment ?? 'confirmed';
    const make = opts.makeConnection ?? ((url: string, c: Commitment) => new Connection(url, c));
    this.urls = opts.endpoints;
    this.conns = opts.endpoints.map((u) => make(u, commitment));
    this.per = opts.maxAttemptsPerEndpoint ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onFailover = opts.onFailover;
    this.now = opts.now ?? (() => Date.now());
  }

  get connection(): Connection {
    return this.conns[this.index];
  }

  /** Redacted identifier of the active endpoint (safe to render/log). */
  get activeEndpoint(): string {
    return redactRpcUrl(this.urls[this.index]);
  }

  health(): RpcHealthSnapshot {
    return { endpoint: this.activeEndpoint, inflight: this.inflight.size, ...this.stats };
  }

  resetHealth(): void {
    this.stats = {
      attempts: 0, successes: 0, failures: 0,
      failuresByKind: { rate_limited: 0, timeout: 0, http: 0, network: 0, unknown: 0 },
      consecutiveFailures: 0, lastErrorKind: null, lastErrorAt: null, lastSuccessAt: null,
    };
  }

  /**
   * Deduplicated read: concurrent calls with the same key share one in-flight
   * request, so a parent and its child components never issue identical loads.
   */
  runKeyed<T>(key: string, fn: (conn: Connection) => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = this.run(fn).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  async run<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    let attempt = 0;
    let lastErr: unknown;
    for (let e = 0; e < this.conns.length; e += 1) {
      this.index = e;
      for (let a = 1; a <= this.per; a += 1) {
        attempt += 1;
        this.stats.attempts += 1;
        try {
          const result = await fn(this.connection);
          this.stats.successes += 1;
          this.stats.consecutiveFailures = 0;
          this.stats.lastSuccessAt = this.now();
          return result;
        } catch (err) {
          lastErr = err;
          const failure = classifyRpcError(err);
          this.stats.failures += 1;
          this.stats.failuresByKind[failure] += 1;
          this.stats.consecutiveFailures += 1;
          this.stats.lastErrorKind = failure;
          this.stats.lastErrorAt = this.now();
          if (!isRetryable(failure)) throw err;
          const retryAfter = failure === 'rate_limited' ? retryAfterMs(err) : null;
          await this.sleep(retryAfter ?? backoffDelayMs(attempt));
        }
      }
      if (e + 1 < this.conns.length) {
        this.onFailover?.(this.urls[e], this.urls[e + 1], classifyRpcError(lastErr));
      }
    }
    throw lastErr;
  }
}

/** Build the app-wide failover from the resolved frontend env config. */
export function createRpcFailover(env: Record<string, string | undefined>): RpcFailover {
  return new RpcFailover({ endpoints: resolveFrontendRpc(env).endpoints });
}

/**
 * S2-25: the single app-wide failover. Reads AND transaction construction use
 * `APP_RPC_FAILOVER.connection`, so blockhash retrieval, send, and confirmation
 * all track the currently active same-cluster endpoint. Wallet signing is handled
 * by the wallet adapter (which does not need this connection).
 */
const APP_ENV =
  ((import.meta as unknown as { env?: Record<string, string | undefined> }).env) ?? {};
export const APP_RPC_FAILOVER = createRpcFailover(APP_ENV);
