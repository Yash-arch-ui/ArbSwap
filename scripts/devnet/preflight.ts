// S2-35: read-only canonical Devnet preflight.
//
// Prints the exact deployed protocol state the frontend/keeper rely on: cluster
// genesis, deployed program (id/owner/hash vs the local artifact), canonical
// vault/config/quote, reserves, mints + decimals, and the configured signer's
// balances. Never sends a transaction, never prints a credential.
//
//   ARBSWAP_CLUSTER=devnet npx tsx preflight.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import fs from "fs";
import { resolveRpcConfig, RpcPool, redactUrl } from "./rpc";

const PROGRAM = new PublicKey("2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm");
const VAULT = new PublicKey("8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt");
const CONFIG = new PublicKey("ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT");
const QUOTE_STATE = new PublicKey("5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG");
const BASE_RESERVE = new PublicKey("8vfr2KmMmXYUTjRg5cAiSYD6EhN1d8pjJnmFC95E2vfm");
const QUOTE_RESERVE = new PublicKey("G8q1WMKT8fnGQh85kCB8Aihf6F7tctXJDKbA6gn1jPeS");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
const RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const BPF_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

const u64 = (d: Buffer, o: number): bigint => d.readBigUInt64LE(o);
const u32 = (d: Buffer, o: number): number => d.readUInt32LE(o);
const pk = (d: Buffer, o: number): string => new PublicKey(d.subarray(o, o + 32)).toBase58();

async function mintDecimals(c: Connection, mint: PublicKey) {
  const info = await c.getAccountInfo(mint, "processed");
  if (!info) return null;
  // SPL Mint layout: decimals at byte 44, supply at 36 (u64 LE).
  return { decimals: info.data[44], supply: info.data.readBigUInt64LE(36).toString(), owner: info.owner.toBase58() };
}

async function main() {
  const cfg = resolveRpcConfig(process.env);
  const pool = new RpcPool({ endpoints: cfg.endpoints, cluster: cfg.cluster });
  await pool.assertCluster();
  const c = pool.connection;

  const genesis = await c.getGenesisHash();
  const slot = await c.getSlot("processed");
  const program = await c.getAccountInfo(PROGRAM, "processed");
  const localSo = process.env.ARBSWAP_SO ?? "target/deploy/arbswap.so";
  let localHash: string | null = null;
  try {
    localHash = createHash("sha256").update(fs.readFileSync(localSo)).digest("hex");
  } catch { /* artifact absent in this cwd */ }

  const vaultInfo = await c.getAccountInfo(VAULT, "processed");
  const configInfo = await c.getAccountInfo(CONFIG, "processed");
  const qsInfo = await c.getAccountInfo(QUOTE_STATE, "processed");
  const [baseBal, quoteBal] = await Promise.all([
    c.getTokenAccountBalance(BASE_RESERVE, "processed").catch(() => null),
    c.getTokenAccountBalance(QUOTE_RESERVE, "processed").catch(() => null),
  ]);
  const [wsol, usdc] = await Promise.all([mintDecimals(c, WSOL), mintDecimals(c, USDC)]);
  const pushInfo = await c.getAccountInfo(PUSH_ORACLE, "processed");
  const recvInfo = await c.getAccountInfo(RECEIVER, "processed");

  const vault = vaultInfo
    ? { len: vaultInfo.data.length, status: vaultInfo.data[304], totalShares: u64(vaultInfo.data, 232).toString(), admin: pk(vaultInfo.data, 8) }
    : null;
  const config = configInfo
    ? {
        len: configInfo.data.length,
        feeBps: configInfo.data.readUInt16LE(136),
        expirySlots: u64(configInfo.data, 176).toString(),
        maxStalenessSeconds: configInfo.data.readBigInt64LE(184).toString(),
        maxConfBps: u32(configInfo.data, 192),
        minBond: u64(configInfo.data, 228).toString(),
        keeper: pk(configInfo.data, 40),
        feed: configInfo.data.subarray(104, 136).toString("hex"),
      }
    : null;
  const quote = qsInfo
    ? {
        len: qsInfo.data.length,
        version: u64(qsInfo.data, 8).toString(),
        updateSlot: u64(qsInfo.data, 16).toString(),
        expirySlot: u64(qsInfo.data, 24).toString(),
        fresh: BigInt(slot) < u64(qsInfo.data, 24),
        author: qsInfo.data.length >= 897 ? pk(qsInfo.data, 845) : null,
      }
    : null;

  console.log(JSON.stringify({
    cluster: cfg.cluster,
    endpoint: redactUrl(cfg.endpoints[0]),
    genesis,
    slot,
    program: program ? { owner: program.owner.toBase58(), executable: program.executable } : null,
    programUpgradeable: program?.owner.toBase58() === BPF_LOADER,
    localArtifactSha256: localHash,
    vault,
    config,
    quote,
    reserves: {
      baseAtoms: baseBal?.value.amount ?? null,
      quoteAtoms: quoteBal?.value.amount ?? null,
    },
    mints: { WSOL: wsol, USDC: usdc },
    pyth: {
      pushOracle: pushInfo ? { owner: pushInfo.owner.toBase58() } : null,
      receiver: recvInfo ? { owner: recvInfo.owner.toBase58() } : null,
    },
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
