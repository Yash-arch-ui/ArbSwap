// Read-only keeper health check.
//
//   npx tsx keeper_health.ts          # OK / STALE line
//   npx tsx keeper_health.ts --json   # machine-readable
//
// Age is derived from the on-chain QuoteState.update_slot and the current slot
// (Devnet ~0.4 s/slot; override with SLOT_SECONDS). STALE means no commit in the
// last 20 s or the quote has expired. Never sends a transaction; never prints
// RPC credentials.
import { PublicKey } from "@solana/web3.js";
import { resolveRpcConfig, RpcPool } from "./rpc";

const QUOTE_STATE = new PublicKey("5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG");
const STALE_AFTER_MS = Number(process.env.KEEPER_STALE_AFTER_MS ?? 20_000);
const SLOT_SECONDS = Number(process.env.SLOT_SECONDS ?? 0.4);

const u64 = (d: Buffer, o: number) => d.readBigUInt64LE(o);
const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();

async function main() {
  const cfg = resolveRpcConfig(process.env);
  const pool = new RpcPool({ endpoints: cfg.endpoints, cluster: cfg.cluster, maxAttemptsPerEndpoint: 2 });
  await pool.assertCluster();
  const connection = pool.connection;

  const slot = await connection.getSlot("processed");
  const qs = await connection.getAccountInfo(QUOTE_STATE, "processed");
  if (!qs) {
    console.error("QuoteState account not found");
    process.exit(2);
  }

  const version = u64(qs.data, 8);
  const updateSlot = u64(qs.data, 16);
  const expirySlot = u64(qs.data, 24);
  const ageSlots = BigInt(slot) > updateSlot ? BigInt(slot) - updateSlot : 0n;
  const ageMs = Number(ageSlots) * SLOT_SECONDS * 1000;
  const fresh = BigInt(slot) < expirySlot;
  const stale = !fresh || ageMs > STALE_AFTER_MS;
  const keeper = qs.data.length >= 897 ? pk(qs.data, 845) : null;

  const report = {
    cluster: cfg.cluster,
    status: stale ? "STALE" : "OK",
    commit_age_ms: Math.round(ageMs),
    stale_after_ms: STALE_AFTER_MS,
    slot,
    update_slot: updateSlot.toString(),
    expiry_slot: expirySlot.toString(),
    expired: !fresh,
    version: version.toString(),
    keeper,
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `${report.status} commit_age_s=${(ageMs / 1000).toFixed(1)} ` +
        `slot=${report.slot} update_slot=${report.update_slot} expiry_slot=${report.expiry_slot} ` +
        `version=${report.version} keeper=${report.keeper ?? "?"}`,
    );
  }
  process.exit(stale ? 1 : 0);
}

main().catch((e) => {
  console.error(`health check failed: ${(e as Error).message}`);
  process.exit(2);
});
