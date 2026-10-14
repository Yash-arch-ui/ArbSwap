// S2-36: read-only fresh-quote observation probe.
//
// Explains why the frontend sees ~0 fresh quotes even while the keeper commits
// verified QuoteState versions. It samples, at high frequency:
//   * processed / confirmed / finalized slot tips (their lags), and
//   * the QuoteState account read at both `processed` and `confirmed`,
// and classifies freshness exactly the way each consumer does:
//   * keeper/program: `slot('processed') < expiry_slot`
//   * frontend (RpcFailover default commitment is `confirmed`):
//     `slot('confirmed') < expiry_slot`, with the UI `Aging` grace band.
// Never signs, never sends. No credentials printed.
//
//   set -a; . ./.ENV; set +a
//   DURATION_MS=90000 INTERVAL_MS=250 npx tsx fresh_quote_probe.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { resolveRpcConfig, redactUrl } from "./rpc";

const PROGRAM = new PublicKey("2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm");
const QUOTE_STATE = new PublicKey("5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG");
const CONFIG = new PublicKey("ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT");

const u64 = (d: Buffer, o: number): bigint => d.readBigUInt64LE(o);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Snapshot {
  version: bigint;
  updateSlot: bigint;
  expirySlot: bigint;
  keeper: string;
}

function decodeQuote(d: Buffer): Snapshot {
  return {
    version: u64(d, 8),
    updateSlot: u64(d, 16),
    expirySlot: u64(d, 24),
    keeper: d.length >= 877 ? new PublicKey(d.subarray(845, 877)).toBase58() : "?",
  };
}

async function main() {
  const cfg = resolveRpcConfig(process.env);
  const endpoint = cfg.endpoints[0];
  const c = new Connection(endpoint, "processed");
  const durationMs = Number(process.env.DURATION_MS ?? 90_000);
  const intervalMs = Number(process.env.INTERVAL_MS ?? 250);

  const genesis = await c.getGenesisHash();
  console.error(`endpoint=${redactUrl(endpoint)} genesis=${genesis}`);
  if (genesis !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") {
    throw new Error("not devnet");
  }
  const cfgInfo = await c.getAccountInfo(CONFIG, "processed");
  if (!cfgInfo) throw new Error("config missing");
  const expirySlots = Number(u64(cfgInfo.data, 176));
  const graceSlots = Number(u64(cfgInfo.data, 168));
  console.error(`program=${PROGRAM.toBase58()} expiry_slots=${expirySlots} grace_slots=${graceSlots}`);

  const rows: Array<Record<string, unknown>> = [];
  const started = Date.now();
  let lastVersion = -1n;

  while (Date.now() - started < durationMs) {
    const t = Date.now();
    const lat: Record<string, number> = {};
    const time = async <T>(k: string, p: Promise<T>): Promise<T | null> => {
      const s = Date.now();
      try { return await p; } catch { return null; } finally { lat[k] = Date.now() - s; }
    };
    const [procSlot, confSlot, finSlot, qp, qc] = await Promise.all([
      time("slot_proc", c.getSlot("processed")),
      time("slot_conf", c.getSlot("confirmed")),
      time("slot_fin", c.getSlot("finalized")),
      time("qs_proc", c.getAccountInfo(QUOTE_STATE, "processed")),
      time("qs_conf", c.getAccountInfo(QUOTE_STATE, "confirmed")),
    ]);
    if (procSlot == null || qc?.data == null) { await sleep(intervalMs); continue; }
    const qpD = qp?.data ? decodeQuote(qp.data) : null;
    const qcD = decodeQuote(qc.data);

    const remProc = Number(qcD.expirySlot) - (procSlot ?? 0);
    const remConf = Number(qcD.expirySlot) - (confSlot ?? 0);
    const remConfProcAccount = qpD ? Number(qpD.expirySlot) - (confSlot ?? 0) : null;
    const statusConf =
      qcD.version <= 0n ? "Unavailable"
        : (confSlot ?? 0) >= Number(qcD.expirySlot) ? "Expired"
          : (confSlot ?? 0) >= Number(qcD.expirySlot) - graceSlots ? "Aging"
            : "Fresh";

    rows.push({
      t,
      iso: new Date(t).toISOString().slice(11, 23),
      proc_slot: procSlot, conf_slot: confSlot, fin_slot: finSlot,
      conf_lag: (procSlot ?? 0) - (confSlot ?? 0),
      fin_lag: (confSlot ?? 0) - (finSlot ?? 0),
      version: qcD.version.toString(),
      update_slot: qcD.updateSlot.toString(),
      expiry_slot: qcD.expirySlot.toString(),
      rem_proc: remProc, rem_conf: remConf, rem_conf_proc_acct: remConfProcAccount,
      status_conf: statusConf,
      author: qcD.keeper.slice(0, 4) + "…" + qcD.keeper.slice(-4),
      latency_ms: lat,
      accounted_confirmed: qpD ? qpD.version.toString() : null,
    });

    if (qcD.version !== lastVersion) {
      lastVersion = qcD.version;
      console.error(`[${new Date(t).toISOString().slice(11, 23)}] version -> ${qcD.version} ` +
        `update_slot=${qcD.updateSlot} expiry=${qcD.expirySlot} rem_proc=${remProc} rem_conf=${remConf} status_conf=${statusConf}`);
    }
    await sleep(intervalMs);
  }

  // Aggregate per version: how long it was Fresh by each classifier.
  const byVersion = new Map<string, { n: number; freshProc: number; freshConf: number; agingConf: number }>();
  for (const r of rows) {
    const k = String(r.version);
    const e = byVersion.get(k) ?? { n: 0, freshProc: 0, freshConf: 0, agingConf: 0 };
    e.n += 1;
    if ((r.rem_proc as number) > 0) e.freshProc += 1;
    if ((r.rem_conf as number) > 0) e.freshConf += 1;
    if (r.status_conf === "Aging") e.agingConf += 1;
    byVersion.set(k, e);
  }
  const total = rows.length;
  const freshProcSamples = rows.filter((r) => (r.rem_proc as number) > 0).length;
  const freshConfSamples = rows.filter((r) => (r.rem_conf as number) > 0).length;
  const statusFreshSamples = rows.filter((r) => r.status_conf === "Fresh").length;
  const statusAgingSamples = rows.filter((r) => r.status_conf === "Aging").length;
  const versionsSeen = [...byVersion.entries()].map(([v, e]) => ({ version: v, ...e }));

  console.log(JSON.stringify({
    endpoint: redactUrl(endpoint),
    expirySlots, graceSlots, totalSamples: total,
    freshByProcessed: freshProcSamples,
    freshByConfirmed: freshConfSamples,
    freshByStatusConfirmed: statusFreshSamples,
    agingByStatusConfirmed: statusAgingSamples,
    versionsSeen,
    headRows: rows.slice(0, 8),
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
