// S2-17 read-only latency probe. No transactions, no secrets printed.
// Measures the procurement latencies that make up the 2 s freshness budget.
import { Connection } from "@solana/web3.js";
import { HermesClient } from "@pythnetwork/hermes-client";

const FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const N = Number(process.env.N ?? 20);

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return Math.round(s[i] * 10) / 10;
}

async function timeIt(fn: () => Promise<unknown>): Promise<number> {
  const t = Date.now();
  await fn();
  return Date.now() - t;
}

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpc, "processed");
  const hermes = new HermesClient(process.env.HERMES_URL ?? "https://hermes.pyth.network",
    process.env.PYTH_API_KEY ? { accessToken: process.env.PYTH_API_KEY } : {});
  const fetchMs: number[] = [], ageMs: number[] = [], bhMs: number[] = [], slotMs: number[] = [], txMs: number[] = [];
  const lastSig = "51TkKqfi9bt8QqpKKxJZnN2nyFv1HAMnSGW2mjctDYDEpuDi4Roch43RJapj3poz8H8DqYCfmE8QFSrbxVHx9TUC";
  for (let i = 0; i < N; i++) {
    fetchMs.push(await timeIt(async () => {
      const u = await hermes.getLatestPriceUpdates([`0x${FEED_ID}`], { encoding: "base64" });
      const p = u.parsed?.[0]?.price;
      if (p) ageMs.push(Date.now() - Number(p.publish_time) * 1000);
    }));
    bhMs.push(await timeIt(() => conn.getLatestBlockhash("processed")));
    slotMs.push(await timeIt(() => conn.getSlot("processed")));
  }
  txMs.push(await timeIt(() => conn.getTransaction(lastSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })));
  const r = { rpc, samples: N, hermes_fetch_ms: { p50: pct(fetchMs, 50), p90: pct(fetchMs, 90), max: Math.max(...fetchMs) },
    hermes_publish_age_ms: { p50: pct(ageMs, 50), p90: pct(ageMs, 90), max: Math.max(...ageMs) },
    rpc_blockhash_ms: { p50: pct(bhMs, 50), p90: pct(bhMs, 90), max: Math.max(...bhMs) },
    rpc_getslot_ms: { p50: pct(slotMs, 50), p90: pct(slotMs, 90), max: Math.max(...slotMs) },
    rpc_gettxn_ms: Math.round(txMs[0]) };
  console.log(JSON.stringify(r, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
