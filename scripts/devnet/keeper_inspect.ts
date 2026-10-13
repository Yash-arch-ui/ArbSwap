// S2-22: read-only inspection of the live quote and keeper eligibility.
// Never sends a transaction.
//
//   ARBSWAP_CLUSTER=devnet npx tsx keeper_inspect.ts
import { PublicKey } from "@solana/web3.js";
import { resolveRpcConfig, RpcPool } from "./rpc";

const PROGRAM = new PublicKey("2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm");
const VAULT = new PublicKey("8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt");
const CONFIG = new PublicKey("ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT");
const QUOTE_STATE = new PublicKey("5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG");

const u64 = (d: Buffer, o: number) => d.readBigUInt64LE(o);
const u32 = (d: Buffer, o: number) => d.readUInt32LE(o);
const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();

async function main() {
  const cfg = resolveRpcConfig(process.env);
  const pool = new RpcPool({ endpoints: cfg.endpoints, cluster: cfg.cluster });
  await pool.assertCluster();
  const connection = pool.connection;

  const slot = await connection.getSlot("processed");
  const qs = await connection.getAccountInfo(QUOTE_STATE, "processed");
  const vault = await connection.getAccountInfo(VAULT, "processed");
  const config = await connection.getAccountInfo(CONFIG, "processed");

  const quote = qs
    ? {
        length: qs.data.length,
        layout: qs.data.length === 897 ? "current" : qs.data.length === 865 ? "legacy" : "unsupported",
        version: u64(qs.data, 8).toString(),
        update_slot: u64(qs.data, 16).toString(),
        expiry_slot: u64(qs.data, 24).toString(),
        oracle_publish_time: qs.data.readBigInt64LE(104).toString(),
        oracle_conf_bps: u32(qs.data, 112),
        keeper: qs.data.length >= 897 ? pk(qs.data, 845) : null,
        unattributed: qs.data.length < 897 || pk(qs.data, 845) === PublicKey.default.toBase58(),
        fresh: BigInt(slot) < u64(qs.data, 24),
      }
    : null;

  const cfgReport = config
    ? {
        min_bond: u64(config.data, 228).toString(),
        configured_keeper: pk(config.data, 40),
        pyth_feed_id: config.data.subarray(104, 136).toString("hex"),
        max_anchor_step_bps: u32(config.data, 196),
        max_anchor_dev_bps: u32(config.data, 260),
      }
    : null;

  const vaultReport = vault ? { status: vault.data[304] } : null;

  console.log(
    JSON.stringify(
      {
        cluster: cfg.cluster,
        slot,
        quote,
        config: cfgReport,
        vault: vaultReport,
        eligibility:
          cfgReport?.min_bond === "0"
            ? "permissionless (any valid signer may quote)"
            : "bonded (any keeper meeting min_bond may quote)",
      },
      null,
      2,
    ),
  );
}
main().catch((e) => { console.error(e); process.exit(1); });
