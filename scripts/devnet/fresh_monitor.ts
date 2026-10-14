// S2-37 Task 6: read-only fresh-quote monitor. Samples QuoteState at `processed`
// every INTERVAL_MS for DURATION_SEC and reports the fresh fraction, the longest
// stale gap, and the number of committed versions observed. Never signs.
//
//   DURATION_SEC=1200 INTERVAL_MS=400 npx tsx fresh_monitor.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { resolveRpcConfig, redactUrl } from "./rpc";

const QUOTE_STATE = new PublicKey("5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = resolveRpcConfig(process.env);
  const c = new Connection(cfg.endpoints[0], "processed");
  const durationMs = Number(process.env.DURATION_SEC ?? 60) * 1000;
  const interval = Number(process.env.INTERVAL_MS ?? 400);
  console.error(`monitor rpc=${redactUrl(cfg.endpoints[0])} duration=${durationMs / 1000}s interval=${interval}ms`);

  const start = Date.now();
  let n = 0, fresh = 0, commits = 0, longestStaleMs = 0, staleStart: number | null = null;
  let lastVersion = -1n;
  const versionFresh = new Map<string, number>();
  const end = start + durationMs;
  while (Date.now() < end) {
    const t = Date.now();
    try {
      const [slot, info] = await Promise.all([
        c.getSlot("processed"),
        c.getAccountInfo(QUOTE_STATE, "processed"),
      ]);
      if (info?.data) {
        const version = info.data.readBigUInt64LE(8);
        const expiry = Number(info.data.readBigUInt64LE(24));
        const isFresh = version > 0n && slot < expiry;
        n += 1;
        if (isFresh) {
          fresh += 1;
          versionFresh.set(version.toString(), (versionFresh.get(version.toString()) ?? 0) + 1);
          if (staleStart != null) { longestStaleMs = Math.max(longestStaleMs, t - staleStart); staleStart = null; }
        } else if (staleStart == null) {
          staleStart = t;
        }
        if (version !== lastVersion && lastVersion !== -1n) commits += 1;
        if (version !== lastVersion) lastVersion = version;
      }
    } catch { /* transient */ }
    await sleep(interval);
  }
  if (staleStart != null) longestStaleMs = Math.max(longestStaleMs, Date.now() - staleStart);
  const fraction = n > 0 ? fresh / n : 0;
  const rule = fraction >= 0.8 ? "green" : fraction >= 0.5 ? "amber" : "red";
  console.log(JSON.stringify({
    samples: n, fresh, fresh_fraction: Number(fraction.toFixed(3)),
    longest_stale_ms: longestStaleMs, commits_observed: commits,
    last_version: lastVersion.toString(),
    versions_with_fresh_samples: versionFresh.size, decision: rule,
  }, null, 2));
}

main().catch((e) => { console.error(String((e as Error).message ?? e)); process.exit(1); });
