// S2-37 Task 3: propose and apply the single authorized parameter change
// (`expiry_slots` 10 -> 120) through the timelocked `set_params`/`apply_params`
// path. Every other `ParamsUpdate` field is copied verbatim from the live
// `Config`, so the applied diff is exactly one field.
//
//   npx tsx apply_params.ts propose        # build + simulate + send set_params
//   npx tsx apply_params.ts status         # read pending_config eligibility
//   npx tsx apply_params.ts apply          # apply once eligible (refuses early)
//   npx tsx apply_params.ts apply --wait   # wait (60 s poll, <=24 h) then apply
//
// Reads the keypair from ARBSWAP_DEVNET_KEYPAIR (the vault admin). Never prints a
// credential-bearing URL. Idempotent: a second propose is refused while a pending
// change exists; apply is a no-op if `expiry_slots` is already the target.
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "fs";
import { resolveRpcConfig, redactUrl } from "./rpc";

const PROGRAM = new PublicKey("2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm");
const VAULT = new PublicKey("8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt");
const CONFIG = new PublicKey("ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT");
const TARGET_EXPIRY_SLOTS = 120n; // authorized devnet demo value

const disc = (name: string): Buffer => {
  const idl = JSON.parse(
    fs.readFileSync(new URL("../../app/src/idl/arbswap.json", import.meta.url), "utf8"),
  ) as { instructions: Array<{ name: string; discriminator: number[] }> };
  const d = idl.instructions.find((i) => i.name === name)?.discriminator;
  if (!d) throw new Error(`no discriminator for ${name}`);
  return Buffer.from(d);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pendingPda = (): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from("pending"), VAULT.toBuffer()], PROGRAM)[0];

interface ConfigView {
  feeBps: number; insuranceBps: number; keeperBps: number; protocolBps: number;
  maxStalenessSeconds: bigint; maxConfBps: number; maxAnchorStepBps: number;
  maxSpreadStepBps: number; minSpreadBps: number; maxSpreadBps: number;
  maxQuoteSize: bigint; maxInventoryBps: number; utilizationMaxBps: number;
  unbondCooldownSlots: bigint; maxUpdateSlotAge: number; edgeWindowSlots: bigint;
  maxEdgeLossBps: number; maxAnchorDevBps: number; flowWindowSlots: bigint;
  maxWindowFlowBps: number; expirySlots: bigint;
}

function readConfig(d: Buffer): ConfigView {
  return {
    feeBps: d.readUInt16LE(136), insuranceBps: d.readUInt16LE(138),
    keeperBps: d.readUInt16LE(140), protocolBps: d.readUInt16LE(142),
    maxStalenessSeconds: d.readBigInt64LE(184), maxConfBps: d.readUInt32LE(192),
    maxAnchorStepBps: d.readUInt32LE(196), maxSpreadStepBps: d.readUInt32LE(200),
    minSpreadBps: d.readUInt32LE(204), maxSpreadBps: d.readUInt32LE(208),
    maxQuoteSize: d.readBigUInt64LE(212), maxInventoryBps: d.readUInt32LE(220),
    utilizationMaxBps: d.readUInt32LE(224), unbondCooldownSlots: d.readBigUInt64LE(236),
    maxUpdateSlotAge: d.readUInt32LE(244), edgeWindowSlots: d.readBigUInt64LE(248),
    maxEdgeLossBps: d.readUInt32LE(256), maxAnchorDevBps: d.readUInt32LE(260),
    flowWindowSlots: d.readBigUInt64LE(264), maxWindowFlowBps: d.readUInt32LE(272),
    expirySlots: d.readBigUInt64LE(176),
  };
}
// Keep SystemProgram imported for parity with the other devnet tools.

/** Borsh-serialize a `ParamsUpdate` (100 bytes, no discriminator). */
function paramsUpdateBytes(c: ConfigView, expirySlots: bigint): Buffer {
  const b = Buffer.alloc(100);
  let o = 0;
  b.writeUInt16LE(c.feeBps, o); o += 2;
  b.writeUInt16LE(c.insuranceBps, o); o += 2;
  b.writeUInt16LE(c.keeperBps, o); o += 2;
  b.writeUInt16LE(c.protocolBps, o); o += 2;
  b.writeBigInt64LE(c.maxStalenessSeconds, o); o += 8;
  b.writeUInt32LE(c.maxConfBps, o); o += 4;
  b.writeUInt32LE(c.maxAnchorStepBps, o); o += 4;
  b.writeUInt32LE(c.maxSpreadStepBps, o); o += 4;
  b.writeUInt32LE(c.minSpreadBps, o); o += 4;
  b.writeUInt32LE(c.maxSpreadBps, o); o += 4;
  b.writeBigUInt64LE(c.maxQuoteSize, o); o += 8;
  b.writeUInt32LE(c.maxInventoryBps, o); o += 4;
  b.writeUInt32LE(c.utilizationMaxBps, o); o += 4;
  b.writeBigUInt64LE(c.unbondCooldownSlots, o); o += 8;
  b.writeUInt32LE(c.maxUpdateSlotAge, o); o += 4;
  b.writeBigUInt64LE(c.edgeWindowSlots, o); o += 8;
  b.writeUInt32LE(c.maxEdgeLossBps, o); o += 4;
  b.writeUInt32LE(c.maxAnchorDevBps, o); o += 4;
  b.writeBigUInt64LE(c.flowWindowSlots, o); o += 8;
  b.writeUInt32LE(c.maxWindowFlowBps, o); o += 4;
  b.writeBigUInt64LE(expirySlots, o); o += 8;
  return b.subarray(0, o);
}

function admin(): Keypair {
  const p = process.env.ARBSWAP_DEVNET_KEYPAIR;
  if (!p) throw new Error("ARBSWAP_DEVNET_KEYPAIR is not set");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function connection(): Promise<Connection> {
  const cfg = resolveRpcConfig(process.env);
  const c = new Connection(cfg.endpoints[0], "confirmed");
  if ((await c.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") {
    throw new Error("not devnet");
  }
  console.error(`rpc=${redactUrl(cfg.endpoints[0])}`);
  return c;
}

async function readPending(c: Connection): Promise<{ activateSlot: bigint; admin: string } | null> {
  const info = await c.getAccountInfo(pendingPda(), "confirmed");
  if (!info) return null;
  return { admin: new PublicKey(info.data.subarray(8, 40)).toBase58(), activateSlot: info.data.readBigUInt64LE(40) };
}

/** Send raw and poll `getSignatureStatuses` (avoids the websocket confirm hang). */
async function sendAndPoll(c: Connection, tx: Transaction, signer: Keypair): Promise<string> {
  tx.sign(signer);
  const sig = await c.sendRawTransaction(tx.serialize(), {
    skipPreflight: true, maxRetries: 3, preflightCommitment: "confirmed",
  });
  const deadline = Date.now() + 120_000;
  for (;;) {
    const st = await c.getSignatureStatuses([sig], { searchTransactionHistory: false });
    const v = st.value[0];
    if (v?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(v.err)}`);
    if (v && ["processed", "confirmed", "finalized"].includes(v.confirmationStatus ?? "")) return sig;
    if (Date.now() > deadline) throw new Error(`tx ${sig} not confirmed in 120s`);
    await sleep(400);
  }
}

async function propose(c: Connection): Promise<void> {
  const kp = admin();
  const existing = await readPending(c);
  if (existing && existing.activateSlot !== (1n << 64n) - 1n) {
    throw new Error(`a pending config change already exists (activate_slot ${existing.activateSlot}); refusing to overwrite`);
  }
  const cfgInfo = await c.getAccountInfo(CONFIG, "confirmed");
  if (!cfgInfo) throw new Error("config account not found");
  const cfg = readConfig(cfgInfo.data);
  console.error(`current expiry_slots=${cfg.expirySlots} -> target ${TARGET_EXPIRY_SLOTS}`);
  const ix = new TransactionInstruction({
    programId: PROGRAM,
    data: Buffer.concat([disc("set_params"), paramsUpdateBytes(cfg, TARGET_EXPIRY_SLOTS)]),
    keys: [
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },
      { pubkey: VAULT, isSigner: false, isWritable: false },
      { pubkey: CONFIG, isSigner: false, isWritable: false },
      { pubkey: pendingPda(), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
  const { blockhash } = await c.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(ix);
  tx.sign(kp);
  const sim = await c.simulateTransaction(tx);
  console.log(JSON.stringify({ simulate_err: sim.value.err, logs: sim.value.logs?.slice(-3) }));
  if (sim.value.err) throw new Error("set_params simulation failed; not submitting");
  const sig = await sendAndPoll(c, new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(ix), kp);
  const p = await readPending(c);
  console.log(JSON.stringify({ set_params_signature: sig, activate_slot: p?.activateSlot?.toString() ?? null }, null, 2));
}

async function apply(c: Connection, wait: boolean): Promise<void> {
  const kp = admin();
  const p = await readPending(c);
  if (!p) throw new Error("no pending config change to apply");
  const before = readConfig((await c.getAccountInfo(CONFIG, "confirmed"))!.data);
  if (before.expirySlots === TARGET_EXPIRY_SLOTS) {
    console.log(JSON.stringify({ already_applied: true, expiry_slots: before.expirySlots.toString() }));
    return;
  }
  const deadline = Date.now() + 24 * 3600 * 1000;
  for (;;) {
    const slot = BigInt(await c.getSlot("confirmed"));
    if (slot >= p.activateSlot) break;
    if (!wait) throw new Error(`TimelockNotElapsed: slot ${slot} < activate_slot ${p.activateSlot}`);
    if (Date.now() > deadline) throw new Error("waited 24h; giving up");
    console.error(`waiting: slot ${slot} < ${p.activateSlot} (${(p.activateSlot - slot).toString()} slots left)`);
    await sleep(60_000);
  }
  const ix = new TransactionInstruction({
    programId: PROGRAM,
    data: disc("apply_params"),
    keys: [
      { pubkey: kp.publicKey, isSigner: true, isWritable: false },
      { pubkey: VAULT, isSigner: false, isWritable: false },
      { pubkey: CONFIG, isSigner: false, isWritable: true },
      { pubkey: pendingPda(), isSigner: false, isWritable: true },
    ],
  });
  const { blockhash } = await c.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(ix);
  tx.sign(kp);
  const sig = await sendAndPoll(c, tx, kp);
  const after = readConfig((await c.getAccountInfo(CONFIG, "confirmed"))!.data);
  const keys = Object.keys(before) as (keyof ConfigView)[];
  const changed = keys.filter((k) => before[k] !== after[k]);
  const ok = changed.length === 1 && changed[0] === "expirySlots" && after.expirySlots === TARGET_EXPIRY_SLOTS;
  console.log(JSON.stringify({
    apply_signature: sig, changed_fields: changed.map(String),
    expiry_slots: after.expirySlots.toString(), only_expiry_changed: ok,
  }, null, 2));
  if (!ok) throw new Error("post-apply verification failed");
}

async function main() {
  const cmd = process.argv[2];
  const wait = process.argv.includes("--wait");
  const c = await connection();
  if (cmd === "propose") return propose(c);
  if (cmd === "apply") return apply(c, wait);
  if (cmd === "status") {
    const p = await readPending(c);
    const slot = await c.getSlot("confirmed");
    console.log(JSON.stringify({ slot, pending: p ? { ...p, activateSlot: p.activateSlot.toString(), eligible: BigInt(slot) >= p.activateSlot } : null }, null, 2));
    return;
  }
  throw new Error("usage: apply_params.ts propose|apply [--wait]|status");
}
main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
