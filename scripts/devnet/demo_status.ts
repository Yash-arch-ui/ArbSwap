// S2-37 Task 6: one-shot keeper/quote status (read-only). Prints fresh/expired,
// version, author, seconds to expiry (0.248 s/slot), the keeper's SOL balance,
// and RPC round-trip latency. No secrets printed.
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import { resolveRpcConfig, redactUrl } from "./rpc";

const QUOTE_STATE = new PublicKey("5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG");
const SEC_PER_SLOT = 0.248;

async function main(): Promise<void> {
  const cfg = resolveRpcConfig(process.env);
  const c = new Connection(cfg.endpoints[0], "processed");
  const keyPath = process.env.ARBSWAP_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
  const secret = JSON.parse(fs.readFileSync(keyPath, "utf8")) as number[];
  const keeper = new PublicKey(
    (await import("@solana/web3.js")).Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey,
  );
  const t0 = Date.now();
  const [slot, info, bal] = await Promise.all([
    c.getSlot("processed"),
    c.getAccountInfo(QUOTE_STATE, "processed"),
    c.getBalance(keeper),
  ]);
  const latency = Date.now() - t0;
  const version = info?.data.readBigUInt64LE(8) ?? 0n;
  const expiry = info?.data ? Number(info.data.readBigUInt64LE(24)) : 0;
  const author = info?.data ? new PublicKey(info.data.subarray(845, 877)).toBase58() : null;
  const fresh = version > 0n && slot < expiry;
  console.log(JSON.stringify({
    rpc: redactUrl(cfg.endpoints[0]),
    slot, version: version.toString(), author,
    fresh, status: fresh ? "FRESH" : version > 0n ? "EXPIRED" : "UNAVAILABLE",
    slots_to_expiry: Math.max(0, expiry - slot),
    seconds_to_expiry: Number((Math.max(0, expiry - slot) * SEC_PER_SLOT).toFixed(1)),
    keeper: keeper.toBase58(), keeper_sol: bal / 1e9,
    rpc_latency_ms: latency,
  }, null, 2));
}

main().catch((e) => { console.error(String((e as Error).message ?? e)); process.exit(1); });
