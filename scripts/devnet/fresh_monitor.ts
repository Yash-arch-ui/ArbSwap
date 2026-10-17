// S2-37 Task 6: read-only fresh-quote monitor. Samples QuoteState at `processed`
// every INTERVAL_MS for DURATION_SEC and reports the fresh fraction, the longest
// stale gap, and the number of committed versions observed. Never signs.
//
//   DURATION_SEC=1200 INTERVAL_MS=400 npx tsx fresh_monitor.ts
//
// Issue D: it now reports both the sample fraction (the historical metric) and a
// wall-clock time-weighted fraction, the effective sampling period, and the
// maximum oracle age seen on "fresh" (unexpired) samples — because an unexpired
// quote is not necessarily a fresh-oracle quote. Set MIN_FRESH=<0..1> to make the
// monitor exit non-zero below that time-weighted threshold.
import { Connection, PublicKey } from "@solana/web3.js";
import { resolveRpcConfig, redactUrl } from "./rpc";
import { summarise, type FreshSample } from "./fresh_monitor_core";

// Anchor account layout (8-byte discriminator): version@8, expiry_slot@24,
// oracle_publish_time@104 (i64, seconds).
const QUOTE_STATE = new PublicKey("5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = resolveRpcConfig(process.env);
  const c = new Connection(cfg.endpoints[0], "processed");
  const durationMs = Number(process.env.DURATION_SEC ?? 60) * 1000;
  const interval = Number(process.env.INTERVAL_MS ?? 400);
  console.error(`monitor rpc=${redactUrl(cfg.endpoints[0])} duration=${durationMs / 1000}s interval=${interval}ms`);

  const start = Date.now();
  const end = start + durationMs;
  const samples: FreshSample[] = [];
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
        const publishTime = Number(info.data.readBigInt64LE(104));
        const isFresh = version > 0n && slot < expiry;
        const oracleAgeMs = publishTime > 0 ? t - publishTime * 1000 : null;
        samples.push({ t, fresh: isFresh, version, slot, expirySlot: expiry, oracleAgeMs });
      }
    } catch { /* transient */ }
    await sleep(interval);
  }

  const summary = summarise(samples, Date.now());
  console.log(JSON.stringify(summary, null, 2));

  const minFresh = process.env.MIN_FRESH;
  if (minFresh !== undefined && minFresh !== "") {
    const threshold = Number(minFresh);
    if (Number.isFinite(threshold) && summary.fresh_fraction_time_weighted < threshold) {
      console.error(`fresh fraction (time-weighted) ${summary.fresh_fraction_time_weighted} < MIN_FRESH ${threshold}`);
      process.exit(1);
    }
  }
}

main().catch((e) => { console.error(String((e as Error).message ?? e)); process.exit(1); });
