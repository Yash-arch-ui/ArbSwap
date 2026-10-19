// @ts-nocheck -- local assertion script (node: types not installed here).
// S2-22 local test for the RPC config/failover layer. No network, no secrets.
import assert from "node:assert/strict";
import {
  resolveRpcConfig,
  resolveCluster,
  redactUrl,
  classifyRpcError,
  isRetryable,
  backoffDelayMs,
  RpcPool,
  GENESIS_HASH,
} from "./rpc";

let n = 0;
const check = (name: string, cond: boolean) => {
  n += 1;
  assert.ok(cond, `case failed: ${name}`);
  console.log(`ok ${n} - ${name}`);
};

// --- config ---
check("default cluster is devnet", resolveCluster({}) === "devnet");
check("cluster aliases", resolveCluster({ ARBSWAP_CLUSTER: "mainnet" }) === "mainnet-beta");
let threw = false;
try { resolveCluster({ ARBSWAP_CLUSTER: "bogus" }); } catch { threw = true; }
check("unknown cluster throws", threw);

const dflt = resolveRpcConfig({});
check("default devnet endpoint", dflt.endpoints[0] === "https://api.devnet.solana.com");

const pref = resolveRpcConfig({ ARBSWAP_RPC_URL: "https://a.example/rpc", RPC_URL: "https://b.example/rpc" });
check("ARBSWAP_RPC_URL preferred over RPC_URL", pref.endpoints[0] === "https://a.example/rpc");

const withFb = resolveRpcConfig({
  ARBSWAP_RPC_URL: "https://my-devnet.example/rpc?key=SECRET",
  ARBSWAP_RPC_FALLBACKS: "https://fb1.example/rpc, https://fb2.example/rpc",
});
check("primary + fallbacks parsed", withFb.endpoints.length === 3 && withFb.endpoints[1] === "https://fb1.example/rpc");

threw = false;
try { resolveRpcConfig({ ARBSWAP_CLUSTER: "devnet", ARBSWAP_RPC_URL: "https://api.mainnet-beta.solana.com" }); } catch { threw = true; }
check("cross-cluster endpoint rejected", threw);

threw = false;
try { resolveRpcConfig({ ARBSWAP_CLUSTER: "devnet", ARBSWAP_RPC_FALLBACKS: "https://api.testnet.solana.com" }); } catch { threw = true; }
check("cross-cluster fallback rejected", threw);

// --- redaction ---
check(
  "redactUrl strips credentials/query/path",
  redactUrl("https://user:pass@rpc.example/rpc?key=SECRET") === "https://rpc.example",
);
check(
  "redactUrl strips path-based keys",
  redactUrl("https://rpc.example/abc123secretkey/") === "https://rpc.example",
);
check("redactUrl tolerates garbage", redactUrl("not a url") === "<invalid-url>");

// --- error classification ---
check("429 -> rate_limited", classifyRpcError({ status: 429 }) === "rate_limited");
check("message 429 -> rate_limited", classifyRpcError(new Error("429 Too Many Requests")) === "rate_limited");
check("ETIMEDOUT -> timeout", classifyRpcError({ code: "ETIMEDOUT" }) === "timeout");
check("503 -> http", classifyRpcError({ response: { status: 503 } }) === "http");
check("ECONNREFUSED -> network", classifyRpcError({ code: "ECONNREFUSED" }) === "network");
check("program error -> unknown (not retryable)", classifyRpcError(new Error("custom program error: 0x1797")) === "unknown");
check("unknown is not retryable", !isRetryable("unknown") && isRetryable("rate_limited"));

// --- backoff ---
check("backoff is bounded", backoffDelayMs(20, 250, 8_000, () => 0) === 8_000);
check("backoff grows then caps", backoffDelayMs(1, 250, 8_000, () => 0) === 250 && backoffDelayMs(3, 250, 8_000, () => 0) === 1_000);

// --- RpcPool failover ---
const mk = (url: string) => ({ url, getGenesisHash: async () => GENESIS_HASH.devnet });
const sleeps: number[] = [];
const pool = new RpcPool({
  endpoints: ["https://a.example", "https://b.example"],
  cluster: "devnet",
  makeConnection: mk,
  maxAttemptsPerEndpoint: 2,
  rng: () => 0,
  sleep: async (ms: number) => { sleeps.push(ms); },
});
let calls = 0;
const result = await pool.run(async (conn: any) => {
  calls += 1;
  if (conn.url === "https://a.example") throw { status: 429, message: "429" };
  return "b-ok";
});
check("failover returns the healthy endpoint result", result === "b-ok" && calls === 3);
check("backoff applied during failover", sleeps.length === 2);

// non-retryable error is rethrown immediately (no failover)
let switched = false;
const pool2 = new RpcPool({
  endpoints: ["https://a.example", "https://b.example"],
  cluster: "devnet",
  makeConnection: mk,
  maxAttemptsPerEndpoint: 2,
  rng: () => 0,
  sleep: async () => {},
});
let errMsg = "";
try {
  await pool2.run(async (conn: any) => {
    if (conn.url === "https://b.example") switched = true;
    throw new Error("AnchorError: InvalidOracle");
  });
} catch (e) {
  errMsg = (e as Error).message;
}
check("non-transport error is not retried/failed-over", errMsg === "AnchorError: InvalidOracle" && !switched);

// cluster guard
const good = new RpcPool({ endpoints: ["https://a.example"], cluster: "devnet", makeConnection: mk });
await good.assertCluster();
check("assertCluster accepts the right genesis", true);

const bad = new RpcPool({
  endpoints: ["https://a.example"],
  cluster: "devnet",
  makeConnection: () => ({ getGenesisHash: async () => "some-other-genesis" }) as any,
});
let clusterErr = false;
try { await bad.assertCluster(); } catch { clusterErr = true; }
check("assertCluster rejects a wrong genesis", clusterErr);

console.log(`\n${n} passed`);
