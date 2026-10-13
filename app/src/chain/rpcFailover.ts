// S2-24: browser-side RPC failover. The Node tooling has `scripts/devnet/rpc.ts`;
// this is the equivalent for the app so a failing primary endpoint actually
// falls back to an eligible secondary instead of only validating the env.
//
// Availability only — on-chain account state remains the source of truth.
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

export interface RpcFailoverOptions {
  endpoints: string[];
  commitment?: Commitment;
  maxAttemptsPerEndpoint?: number;
  makeConnection?: (url: string, commitment: Commitment) => Connection;
  sleep?: (ms: number) => Promise<void>;
  onFailover?: (from: string, to: string, failure: RpcFailure) => void;
}

/**
 * Ordered endpoint failover for the app's read path. Retries transport failures
 * with bounded backoff and moves to the next endpoint; a program/unknown error
 * is rethrown immediately so it is never masked. Never switches endpoints from
 * different clusters (the config layer guarantees this).
 */
export class RpcFailover {
  private readonly conns: Connection[];
  private readonly urls: string[];
  private index = 0;
  private readonly per: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onFailover?: (from: string, to: string, failure: RpcFailure) => void;

  constructor(opts: RpcFailoverOptions) {
    if (opts.endpoints.length === 0) throw new Error('RpcFailover requires at least one endpoint');
    const commitment = opts.commitment ?? 'confirmed';
    const make = opts.makeConnection ?? ((url: string, c: Commitment) => new Connection(url, c));
    this.urls = opts.endpoints;
    this.conns = opts.endpoints.map((u) => make(u, commitment));
    this.per = opts.maxAttemptsPerEndpoint ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onFailover = opts.onFailover;
  }

  get connection(): Connection {
    return this.conns[this.index];
  }

  /** Redacted identifier of the active endpoint (safe to render/log). */
  get activeEndpoint(): string {
    return redactRpcUrl(this.urls[this.index]);
  }

  async run<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    let attempt = 0;
    let lastErr: unknown;
    for (let e = 0; e < this.conns.length; e += 1) {
      this.index = e;
      for (let a = 1; a <= this.per; a += 1) {
        attempt += 1;
        try {
          return await fn(this.connection);
        } catch (err) {
          lastErr = err;
          const failure = classifyRpcError(err);
          if (!isRetryable(failure)) throw err;
          await this.sleep(backoffDelayMs(attempt));
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
