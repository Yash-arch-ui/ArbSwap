// Volatility admin tool: the governed actions the permissionless keeper never
// performs on its own (initialize / propose / apply). Signed by the vault admin
// (ARBSWAP_DEVNET_KEYPAIR). Never prints credentials. Manual Borsh encoding so
// it does not depend on an IDL coder.
//
//   npx tsx volatility_admin.ts status
//   npx tsx volatility_admin.ts initialize
//   npx tsx volatility_admin.ts propose <enabled:0|1>
//   npx tsx volatility_admin.ts apply
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import fs from "fs";
import { resolveRpcConfig, redactUrl } from "./rpc";
import { decodeVolatilityState } from "./volatility";

const PROGRAM = new PublicKey("2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm");
const VAULT = new PublicKey("8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt");
const Q64 = 1n << 64n;

const disc = (name: string): Buffer =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

const [VOLATILITY] = PublicKey.findProgramAddressSync([Buffer.from("vol"), VAULT.toBuffer()], PROGRAM);
const [PENDING] = PublicKey.findProgramAddressSync([Buffer.from("vol_pending"), VAULT.toBuffer()], PROGRAM);

// Defaults (must equal `DEFAULT_VOLATILITY_PARAMS` in the program).
const DEFAULT_PARAMS = {
  short_lambda_bps: 9_400,
  medium_lambda_bps: 9_900,
  jump_multiple: 4,
  max_sigma_q64: 1n << 60n,
  jump_cooldown_slots: 1_800n,
  vol_spread_coeff_bps: 1_000,
  vol_depth_coeff_bps: 2_000,
  max_observation_age_slots: 3_600n,
};
type Params = typeof DEFAULT_PARAMS;

function encodeParams(p: Params): Buffer {
  const b = Buffer.alloc(52);
  let o = 0;
  b.writeUInt32LE(p.short_lambda_bps, o); o += 4;
  b.writeUInt32LE(p.medium_lambda_bps, o); o += 4;
  b.writeUInt32LE(p.jump_multiple, o); o += 4;
  b.writeBigUInt64LE(p.max_sigma_q64 & 0xffffffffffffffffn, o);
  b.writeBigUInt64LE(p.max_sigma_q64 >> 64n, o + 8);
  o += 16;
  b.writeBigUInt64LE(p.jump_cooldown_slots, o); o += 8;
  b.writeUInt32LE(p.vol_spread_coeff_bps, o); o += 4;
  b.writeUInt32LE(p.vol_depth_coeff_bps, o); o += 4;
  b.writeBigUInt64LE(p.max_observation_age_slots, o); o += 8;
  return b;
}

function loadAdmin(): Keypair {
  const path = process.env.ARBSWAP_DEVNET_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

async function main() {
  const cmd = process.argv[2] ?? "status";
  const cfg = resolveRpcConfig(process.env);
  const connection = new Connection(cfg.endpoints[0], "confirmed");
  const admin = loadAdmin();
  console.error(`rpc=${redactUrl(cfg.endpoints[0])} admin=${admin.publicKey.toBase58()} vol=${VOLATILITY.toBase58()} pending=${PENDING.toBase58()}`);

  if (cmd === "status") {
    const v = await connection.getAccountInfo(VOLATILITY, "confirmed");
    const p = await connection.getAccountInfo(PENDING, "confirmed");
    const slot = await connection.getSlot("confirmed");
    console.log(JSON.stringify({
      slot,
      volatility: v ? decodeVolatilityState(v.data) : { absent: true },
      pending: p ? { present: true, len: p.data.length } : { absent: true },
    }, (_k, val) => (typeof val === "bigint" ? val.toString() : val), 2));
    return;
  }

  if (cmd === "initialize") {
    const data = Buffer.concat([disc("initialize_volatility"), encodeParams({ ...DEFAULT_PARAMS, short_lambda_bps: 0, medium_lambda_bps: 0, jump_multiple: 0, max_sigma_q64: 0n, jump_cooldown_slots: 0n, vol_spread_coeff_bps: 0, vol_depth_coeff_bps: 0, max_observation_age_slots: 0n })]);
    // All-zero payload selects DEFAULT_VOLATILITY_PARAMS and enabled=false.
    const ix = new TransactionInstruction({
      programId: PROGRAM,
      data,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: VAULT, isSigner: false, isWritable: false },
        { pubkey: VOLATILITY, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    });
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [admin], { commitment: "confirmed" });
    console.log(JSON.stringify({ action: "initialize_volatility", signature: sig }));
    return;
  }

  if (cmd === "propose") {
    const enabled = (process.argv[3] ?? "1") === "1";
    const data = Buffer.concat([disc("propose_volatility_params"), encodeParams(DEFAULT_PARAMS), Buffer.from([enabled ? 1 : 0])]);
    const ix = new TransactionInstruction({
      programId: PROGRAM,
      data,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: VAULT, isSigner: false, isWritable: false },
        { pubkey: PENDING, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    });
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [admin], { commitment: "confirmed" });
    console.log(JSON.stringify({ action: "propose_volatility_params", enabled, signature: sig }));
    return;
  }

  if (cmd === "apply") {
    const data = disc("apply_volatility_params");
    const ix = new TransactionInstruction({
      programId: PROGRAM,
      data,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: VAULT, isSigner: false, isWritable: false },
        { pubkey: VOLATILITY, isSigner: false, isWritable: true },
        { pubkey: PENDING, isSigner: false, isWritable: true },
      ],
    });
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [admin], { commitment: "confirmed" });
    console.log(JSON.stringify({ action: "apply_volatility_params", signature: sig }));
    return;
  }

  throw new Error(`unknown command: ${cmd}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
