// S2-31 (Task B2): read-only latency comparison of the configured primary vs the
// fallback RPC endpoint, plus Hermes publish-age. No transactions. URLs redacted.
//
//   ARBSWAP_RPC_URL=... npx tsx latency_compare.ts [seconds] [interval_ms]
import { Connection } from "@solana/web3.js";
import { HermesClient } from "@pythnetwork/hermes-client";

const FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const SECONDS = Number(process.argv[2] ?? 180);
const INTERVAL = Number(process.argv[3] ?? 2000);
const PRIMARY = process.env.ARBSWAP_RPC_URL ?? "https://api.devnet.solana.com";
const FALLBACK = process.env.ARBSWAP_FALLBACK_URL ?? "https://api.devnet.solana.com";

const redact = (u: string) => { try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch { return "<invalid>"; } };
const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s=[...xs].sort((a,b)=>a-b); return Math.round(s[Math.min(s.length-1, Math.floor((p/100)*s.length))]); };
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));
async function timed<T>(fn:()=>Promise<T>):Promise<[number,T|null]> { const t=Date.now(); try { const r = await fn(); return [Date.now()-t, r]; } catch { return [Date.now()-t, null]; } }

async function main() {
  const primary = new Connection(PRIMARY, "processed");
  const fallback = new Connection(FALLBACK, "processed");
  const hermes = new HermesClient(process.env.HERMES_URL ?? "https://hermes.pyth.network", process.env.PYTH_API_KEY ? { accessToken: process.env.PYTH_API_KEY } : {});
  const S = { hermes_fetch: [] as number[], hermes_age: [] as number[], p_bh: [] as number[], p_slot: [] as number[], f_bh: [] as number[], f_slot: [] as number[], hermes_err: 0, p_err: 0, f_err: 0 };
  const end = Date.now() + SECONDS * 1000;
  let n = 0;
  while (Date.now() < end) {
    n++;
    const [hf, u] = await timed(() => hermes.getLatestPriceUpdates([`0x${FEED_ID}`], { encoding: "base64" }));
    if (u?.parsed?.[0]?.price) { S.hermes_fetch.push(hf); S.hermes_age.push(Date.now() - Number(u.parsed[0].price.publish_time) * 1000); } else S.hermes_err++;
    const [pb, pbh] = await timed(() => primary.getLatestBlockhash("processed")); pbh ? S.p_bh.push(pb) : S.p_err++;
    const [ps, psl] = await timed(() => primary.getSlot("processed")); psl ? S.p_slot.push(ps) : S.p_err++;
    const [fb, fbh] = await timed(() => fallback.getLatestBlockhash("processed")); fbh ? S.f_bh.push(fb) : S.f_err++;
    const [fs, fsl] = await timed(() => fallback.getSlot("processed")); fsl ? S.f_slot.push(fs) : S.f_err++;
    await sleep(INTERVAL);
  }
  const summary = (xs:number[])=>({ n: xs.length, p50: pct(xs,50), p90: pct(xs,90), p99: pct(xs,99), max: xs.length?Math.max(...xs):null });
  console.log(JSON.stringify({
    samples: n, seconds: SECONDS,
    primary: redact(PRIMARY), fallback: redact(FALLBACK),
    hermes_fetch_ms: summary(S.hermes_fetch), hermes_publish_age_ms: summary(S.hermes_age),
    primary_getLatestBlockhash_ms: summary(S.p_bh), primary_getSlot_ms: summary(S.p_slot),
    fallback_getLatestBlockhash_ms: summary(S.f_bh), fallback_getSlot_ms: summary(S.f_slot),
    errors: { hermes: S.hermes_err, primary: S.p_err, fallback: S.f_err },
  }, null, 2));
}
main().catch(e=>{console.error(e);process.exit(1);});
