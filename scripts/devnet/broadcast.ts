// S2-31 (Task T1): dual-endpoint broadcast + per-endpoint rate limiting.
//
// A signed transaction has one signature regardless of which RPC receives it, so
// sending the same bytes to several endpoints concurrently is sound: the first
// endpoint to land it wins and duplicate submissions collapse to the same
// signature. This module never weakens an on-chain guard — it only changes *how*
// the same signed bytes reach the cluster. It also enforces a per-endpoint
// requests-per-minute cap (token bucket) with 429-aware backoff so a free tier is
// not exhausted.
import type { Connection } from "@solana/web3.js";

/** Minimal structural view of a Connection, so tests need no network. */
export interface RpcEndpoint {
  url: string;
  connection: Pick<Connection, "sendRawTransaction" | "getSignatureStatuses">;
}

/** Deterministic token bucket. `now` is injected so tests are clock-stable. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    now: number,
  ) {
    if (capacity <= 0) throw new Error("capacity must be > 0");
    if (refillPerMs <= 0) throw new Error("refillPerMs must be > 0");
    this.tokens = capacity;
    this.last = now;
  }

  private refill(now: number): void {
    const dt = now - this.last;
    if (dt > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerMs);
      this.last = now;
    }
  }

  tryAcquire(now: number): boolean {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  msUntilNext(now: number): number {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }
}

export interface BroadcastOptions {
  /** Per-endpoint requests-per-minute cap (token bucket). Default 120 (2/s). */
  rpcPerMinuteCap?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface BroadcastResult {
  signature: string;
  /** Endpoint whose status first reported the transaction landed. */
  endpoint: string;
  sendMs: number;
  confirmMs: number;
  sentTo: string[];
  rateLimited: string[];
}

const isLanded = (status?: { confirmationStatus?: string } | null): boolean =>
  status?.confirmationStatus === "processed" ||
  status?.confirmationStatus === "confirmed" ||
  status?.confirmationStatus === "finalized";

/**
 * Resolve with the first *fulfilled* promise; reject only if every promise
 * rejects. Unlike `Promise.allSettled` this does not wait for a slow endpoint
 * once a faster one has accepted the bytes — the latency of the slowest send
 * would otherwise land inside a tight freshness window. Rejections of the
 * remaining promises are attached handlers, so they are never "unhandled".
 */
function firstFulfilled<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (promises.length === 0) {
      reject(new Error("firstFulfilled requires at least one promise"));
      return;
    }
    let pending = promises.length;
    let settled = false;
    for (const p of promises) {
      p.then(
        (value) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        },
        () => {
          pending -= 1;
          if (pending === 0 && !settled) {
            settled = true;
            reject(new Error("all broadcasts failed"));
          }
        },
      );
    }
  });
}

/**
 * Send `raw` to every endpoint that has rate-limit budget, concurrently, then
 * poll all of them until one reports the transaction landed (or errors). The
 * first processed wins; a program error is surfaced immediately; a missing
 * status is never treated as success.
 */
export async function broadcastTransaction(
  endpoints: RpcEndpoint[],
  raw: Uint8Array,
  opts: BroadcastOptions = {},
  buckets: Map<string, TokenBucket> = new Map(),
): Promise<BroadcastResult> {
  if (endpoints.length === 0) throw new Error("broadcastTransaction requires at least one endpoint");
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => undefined);
  const pollIntervalMs = opts.pollIntervalMs ?? 150;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const refillPerMs = (opts.rpcPerMinuteCap ?? 120) / 60_000;

  const sent: RpcEndpoint[] = [];
  const rateLimited: string[] = [];
  for (const ep of endpoints) {
    let bucket = buckets.get(ep.url);
    if (!bucket) {
      bucket = new TokenBucket(Math.max(1, opts.rpcPerMinuteCap ?? 120), refillPerMs, now());
      buckets.set(ep.url, bucket);
    }
    if (bucket.tryAcquire(now())) sent.push(ep);
    else rateLimited.push(ep.url);
  }
  if (sent.length === 0) {
    throw new Error(`all endpoints rate-limited: ${rateLimited.join(",")}`);
  }

  const tSend = now();
  // Proceed as soon as the *first* endpoint accepts the bytes. The remaining
  // sends continue in the background; because the bytes (and therefore the
  // signature) are identical, whichever endpoint lands first wins and the
  // slower send only adds a duplicate that collapses to the same signature.
  // Only endpoints that actually accepted the send are trusted for confirmation.
  const accepted = new Set<string>();
  const firstAccepted = await firstFulfilled(
    sent.map((ep) =>
      ep.connection
        .sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0, preflightCommitment: "processed" })
        .then((sig) => {
          accepted.add(ep.url);
          return { ep, sig };
        }),
    ),
  );
  const sendMs = now() - tSend;
  const signature = firstAccepted.sig;
  const sentTo = sent.map((e) => e.url);
  log(`broadcast ${signature} to ${sentTo.length} endpoint(s); rate-limited ${rateLimited.length}`);

  const tConfirm = now();
  const deadline = tConfirm + timeoutMs;
  for (;;) {
    const statuses = await Promise.allSettled(
      sent.map((ep) => ep.connection.getSignatureStatuses([signature], { searchTransactionHistory: false })),
    );
    for (let i = 0; i < statuses.length; i += 1) {
      const r = statuses[i];
      if (r.status !== "fulfilled") continue;
      if (!accepted.has(sent[i].url)) continue;
      const v = r.value?.value?.[0] as { err?: unknown; confirmationStatus?: string } | null | undefined;
      if (v?.err) throw new Error(`tx ${signature} failed: ${JSON.stringify(v.err)}`);
      if (isLanded(v)) {
        return {
          signature,
          endpoint: sent[i].url,
          sendMs,
          confirmMs: now() - tConfirm,
          sentTo,
          rateLimited,
        };
      }
    }
    if (now() > deadline) throw new Error(`tx ${signature} not confirmed within ${timeoutMs}ms`);
    await sleep(pollIntervalMs);
  }
}
