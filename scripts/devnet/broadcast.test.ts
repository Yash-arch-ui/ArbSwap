// @ts-nocheck -- local assertion script (node: types not installed here).
// S2-31 (Task T1) local test for dual-endpoint broadcast + rate limiting.
// Deterministic, no network, no secrets.
import assert from "node:assert/strict";
import { TokenBucket, broadcastTransaction, type RpcEndpoint } from "./broadcast";

let n = 0;
const check = (name: string, cond: boolean) => {
  n += 1;
  assert.ok(cond, `case failed: ${name}`);
  console.log(`ok ${n} - ${name}`);
};

const SIG = "SIGsame";

function clocked() {
  let t = 0;
  const now = () => t;
  const sleep = async (ms: number) => { t += ms; };
  return { now, sleep, advance: (ms: number) => { t += ms; } };
}

/** A fake endpoint that lands after `landAfter` ms (or never if Infinity). */
function ep(url: string, c: ReturnType<typeof clocked>, opts: {
  landAfter?: number;
  err?: unknown;
  sendThrows?: unknown;
} = {}): RpcEndpoint & { sends: number } {
  const landAfter = opts.landAfter ?? 0;
  const obj = {
    url,
    sends: 0,
    connection: {
      async sendRawTransaction() {
        obj.sends += 1;
        if (opts.sendThrows) throw opts.sendThrows;
        return SIG;
      },
      async getSignatureStatuses() {
        if (c.now() >= landAfter) {
          return { value: [{ err: opts.err ?? null, confirmationStatus: opts.err ? undefined : "processed" }] };
        }
        return { value: [null] };
      },
    },
  };
  return obj;
}

// --- TokenBucket ---
{
  const b = new TokenBucket(2, 1 / 1000, 0);
  check("bucket first acquire", b.tryAcquire(0) === true);
  check("bucket second acquire", b.tryAcquire(0) === true);
  check("bucket exhausted", b.tryAcquire(0) === false);
  check("bucket msUntilNext", b.msUntilNext(0) === 1000);
  check("bucket refills after 1s", b.tryAcquire(1000) === true);
}

// --- broadcast: both endpoints receive the same signed bytes ---
{
  const c = clocked();
  const a = ep("https://a", c, { landAfter: 0 });
  const b = ep("https://b", c, { landAfter: 1000 });
  const r = await broadcastTransaction([a, b], new Uint8Array([1, 2, 3]), { now: c.now, sleep: c.sleep });
  check("both endpoints received the tx", a.sends === 1 && b.sends === 1);
  check("one signature for duplicate sends", r.signature === SIG);
  check("faster endpoint wins", r.endpoint === "https://a");
  check("both endpoints listed as sentTo", r.sentTo.length === 2);
}

// --- broadcast: slower endpoint wins when the faster never lands ---
{
  const c = clocked();
  const a = ep("https://a", c, { landAfter: Infinity });
  const b = ep("https://b", c, { landAfter: 300 });
  const r = await broadcastTransaction([a, b], new Uint8Array([1]), { now: c.now, sleep: c.sleep, pollIntervalMs: 150 });
  check("first landed endpoint wins", r.endpoint === "https://b");
  check("confirmMs reflects landing delay", r.confirmMs === 300);
}

// --- broadcast: one endpoint rejects, the other still lands ---
{
  const c = clocked();
  const a = ep("https://a", c, { sendThrows: new Error("429 too many requests") });
  const b = ep("https://b", c, { landAfter: 0 });
  const r = await broadcastTransaction([a, b], new Uint8Array([1]), { now: c.now, sleep: c.sleep });
  check("survives one endpoint failure", r.signature === SIG && r.endpoint === "https://b");
}

// --- broadcast: program error is surfaced, never treated as success ---
{
  const c = clocked();
  const a = ep("https://a", c, { landAfter: 0, err: { InstructionError: [0, "Custom"] } });
  let msg = "";
  try {
    await broadcastTransaction([a], new Uint8Array([1]), { now: c.now, sleep: c.sleep });
  } catch (e) {
    msg = String(e.message);
  }
  check("program error thrown", /failed/.test(msg));
}

// --- broadcast: rate limiting per endpoint ---
{
  const c = clocked();
  const a = ep("https://a", c, { landAfter: 0 });
  const b = ep("https://b", c, { landAfter: 0 });
  const buckets = new Map();
  const opts = { now: c.now, sleep: c.sleep, rpcPerMinuteCap: 1, buckets };
  const r1 = await broadcastTransaction([a, b], new Uint8Array([1]), opts, buckets);
  check("first broadcast acquires budget", r1.sentTo.length === 2);
  let threw = "";
  try {
    await broadcastTransaction([a, b], new Uint8Array([1]), opts, buckets);
  } catch (e) {
    threw = String(e.message);
  }
  check("second broadcast rate-limited (all)", /rate-limited/.test(threw));
  c.advance(60_000);
  const r3 = await broadcastTransaction([a, b], new Uint8Array([1]), opts, buckets);
  check("budget refills after a minute", r3.sentTo.length === 2);
}

// --- broadcast: timeout when nothing lands ---
{
  const c = clocked();
  const a = ep("https://a", c, { landAfter: Infinity });
  let threw = "";
  try {
    await broadcastTransaction([a], new Uint8Array([1]), { now: c.now, sleep: c.sleep, timeoutMs: 500, pollIntervalMs: 150 });
  } catch (e) {
    threw = String(e.message);
  }
  check("timeout thrown", /not confirmed/.test(threw));
}

console.log(`\n${n} broadcast cases passed`);
