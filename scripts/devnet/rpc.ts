// S2-22: minimal, testable RPC configuration + failover for keeper tooling and
// read-only scripts. Availability only — protocol correctness still comes from
// on-chain validation. Never logs credentials; never mixes clusters.
import { Connection } from "@solana/web3.js";

export type RpcCluster = "devnet" | "mainnet-beta" | "testnet" | "localnet";

export const GENESIS_HASH: Record<RpcCluster, string> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  localnet: "", // no canonical public genesis hash
};

export const DEFAULT_RPC: Record<RpcCluster, string> = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  localnet: "http://127.0.0.1:8899",
};

export interface RpcConfig {
  cluster: RpcCluster;
  endpoints: string[];
}

export function resolveCluster(env: Record<string, string | undefined>): RpcCluster {
  const c = (env.ARBSWAP_CLUSTER ?? env.SOLANA_CLUSTER ?? "devnet").toLowerCase();
  if (c === "mainnet" || c === "mainnet-beta") return "mainnet-beta";
  if (c === "devnet") return "devnet";
  if (c === "testnet") return "testnet";
  if (c === "localnet" || c === "localhost") return "localnet";
  throw new Error(`unknown cluster: ${c}`);
}

/** Public endpoints whose cluster is unambiguous. Custom URLs return null. */
function knownHostCluster(url: string): RpcCluster | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (host === "api.mainnet-beta.solana.com") return "mainnet-beta";
  if (host === "api.devnet.solana.com") return "devnet";
  if (host === "api.testnet.solana.com") return "testnet";
  if (host === "127.0.0.1" || host === "localhost") return "localnet";
  return null;
}

/** Strip credentials/query so a URL can be logged safely. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

export function resolveRpcConfig(env: Record<string, string | undefined>): RpcConfig {
  const cluster = resolveCluster(env);
  const primary = env.ARBSWAP_RPC_URL ?? env.RPC_URL ?? DEFAULT_RPC[cluster];
  const fallbacks = (env.ARBSWAP_RPC_FALLBACKS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const endpoints = [primary, ...fallbacks];
  for (const e of endpoints) {
    const hc = knownHostCluster(e);
    if (hc && hc !== cluster) {
      throw new Error(`RPC endpoint ${redactUrl(e)} belongs to ${hc}, not ${cluster}`);
    }
  }
  return { cluster, endpoints };
}

export type RpcFailure = "rate_limited" | "timeout" | "http" | "network" | "unknown";

export function classifyRpcError(err: unknown): RpcFailure {
  const e = err as {
    status?: number;
    code?: string;
    response?: { status?: number };
    cause?: { code?: string };
    message?: string;
  };
  const msg = String(e?.message ?? err ?? "");
  const code = e?.code ?? e?.cause?.code;
  if (e?.status === 429 || e?.response?.status === 429 || /429|rate.?limit|too many requests/i.test(msg)) {
    return "rate_limited";
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || /timeout|timed out/i.test(msg)) {
    return "timeout";
  }
  if (typeof e?.status === "number" || typeof e?.response?.status === "number") return "http";
  if (
    ["ECONNRESET", "ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(code ?? "") ||
    /fetch failed|network|socket hang up/i.test(msg)
  ) {
    return "network";
  }
  return "unknown";
}

export function isRetryable(f: RpcFailure): boolean {
  return f === "rate_limited" || f === "timeout" || f === "http" || f === "network";
}

/** Bounded exponential backoff with jitter (deterministic when `rng` is fixed). */
export function backoffDelayMs(
  attempt: number,
  baseMs = 250,
  capMs = 8_000,
  rng: () => number = Math.random,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.min(capMs, exp + Math.floor(rng() * baseMs));
}

export interface RpcPoolOptions {
  endpoints: string[];
  cluster: RpcCluster;
  makeConnection?: (url: string) => Connection;
  maxAttemptsPerEndpoint?: number;
  baseDelayMs?: number;
  capDelayMs?: number;
  rng?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * Ordered endpoint failover for read/submit helpers. Retries transport failures
 * (rate-limit/timeout/http/network) with bounded backoff and moves to the next
 * endpoint; a non-transport (e.g. program) error is rethrown immediately so it
 * is never masked or retried blindly. Never resubmits a transaction by itself —
 * callers must inspect signatures (see `keeper_commit.ts`).
 */
export class RpcPool {
  private index = 0;
  private readonly conns: Connection[];
  private readonly per: number;
  private readonly base: number;
  private readonly cap: number;
  private readonly rng: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: RpcPoolOptions) {
    if (opts.endpoints.length === 0) throw new Error("RpcPool requires at least one endpoint");
    const make = opts.makeConnection ?? ((url: string) => new Connection(url, "processed"));
    this.conns = opts.endpoints.map(make);
    this.per = opts.maxAttemptsPerEndpoint ?? 2;
    this.base = opts.baseDelayMs ?? 250;
    this.cap = opts.capDelayMs ?? 8_000;
    this.rng = opts.rng ?? Math.random;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? (() => undefined);
  }

  get connection(): Connection {
    return this.conns[this.index];
  }

  get endpoint(): string {
    return this.opts.endpoints[this.index];
  }

  /** Independently confirm the connected endpoint is on the intended cluster. */
  async assertCluster(): Promise<void> {
    const expected = GENESIS_HASH[this.opts.cluster];
    if (!expected) return;
    const genesis = await this.connection.getGenesisHash();
    if (genesis !== expected) {
      throw new Error(
        `cluster mismatch at ${redactUrl(this.endpoint)}: reports ${genesis}, expected ${this.opts.cluster}`,
      );
    }
  }

  async run<T>(fn: (conn: Connection, attempt: number) => Promise<T>): Promise<T> {
    let attempt = 0;
    let lastErr: unknown;
    for (let e = 0; e < this.conns.length; e += 1) {
      this.index = e;
      for (let a = 1; a <= this.per; a += 1) {
        attempt += 1;
        try {
          return await fn(this.connection, attempt);
        } catch (err) {
          lastErr = err;
          const failure = classifyRpcError(err);
          if (!isRetryable(failure)) throw err;
          this.log(`rpc ${failure} on ${redactUrl(this.endpoint)} (attempt ${attempt}); backing off`);
          await this.sleep(backoffDelayMs(attempt, this.base, this.cap, this.rng));
        }
      }
      if (e + 1 < this.conns.length) {
        this.log(`failover to ${redactUrl(this.opts.endpoints[e + 1])}`);
      }
    }
    throw lastErr;
  }
}
