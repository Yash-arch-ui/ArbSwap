// S2-23: QuoteState migration driver (865 -> 897). Dry-run by default; submits
// only with SUBMIT=1. Never prints secrets.
//
//   npx tsx migrate_quote_state.ts            # preview (simulate only)
//   SUBMIT=1 npx tsx migrate_quote_state.ts   # submit + verify
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { createHash } from "crypto";
import fs from "fs";
import { resolveRpcConfig, RpcPool, redactUrl } from "./rpc";

const PROGRAM = new PublicKey("2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm");
const VAULT = new PublicKey("8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt");
const QUOTE_STATE = new PublicKey("5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG");
const LEGACY_LEN = 865;
const CURRENT_LEN = 897;
const DISC = "beffae2c13d7259c";

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const meta = (pubkey: PublicKey, writable = false, signer = false) => ({ pubkey, isWritable: writable, isSigner: signer });
const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();

async function main() {
  const cfg = resolveRpcConfig(process.env);
  const pool = new RpcPool({ endpoints: cfg.endpoints, cluster: cfg.cluster });
  await pool.assertCluster();
  const connection = pool.connection;

  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("quote"), VAULT.toBuffer()], PROGRAM);
  if (!pda.equals(QUOTE_STATE)) throw new Error(`derived PDA ${pda.toBase58()} != canonical ${QUOTE_STATE.toBase58()}`);

  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ARBSWAP_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`, "utf8"))),
  );

  const before = await connection.getAccountInfo(QUOTE_STATE, "confirmed");
  if (!before) throw new Error("QuoteState account not found");
  const len = before.data.length;
  const d = before.data.subarray(0, 8).toString("hex");
  console.log(JSON.stringify({ endpoint: redactUrl(pool.endpoint), payer: payer.publicKey.toBase58(),
    owner: before.owner.toBase58(), discriminator: d, length: len,
    version: before.data.readBigUInt64LE(8).toString(), expiry_slot: before.data.readBigUInt64LE(24).toString() }));

  if (before.owner.toBase58() !== PROGRAM.toBase58()) throw new Error("owner mismatch");
  if (d !== DISC) throw new Error("discriminator mismatch");
  if (len === CURRENT_LEN) { console.log("already migrated (897); no-op"); return; }
  if (len !== LEGACY_LEN) throw new Error(`unsupported length ${len}`);

  const ix = new TransactionInstruction({
    programId: PROGRAM,
    data: disc("migrate_quote_state"),
    keys: [
      meta(payer.publicKey, true, true),
      meta(VAULT, false),
      meta(QUOTE_STATE, true),
      meta(SystemProgram.programId, false),
    ],
  });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  tx.add(ix);
  tx.sign(payer);

  const sim = await connection.simulateTransaction(tx);
  console.log(JSON.stringify({ simulate_err: sim.value.err, units: sim.value.unitsConsumed ?? null }));
  if (sim.value.err) throw new Error("migration simulation failed");

  if (process.env.SUBMIT !== "1") { console.log("DRY-RUN: pass SUBMIT=1 to submit"); return; }

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
  const latest = await connection.getLatestBlockhash("confirmed");
  const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, "confirmed");
  console.log(JSON.stringify({ signature: sig, confirm_err: conf.value.err }));

  const after = await connection.getAccountInfo(QUOTE_STATE, "confirmed");
  const ok =
    !!after && after.data.length === CURRENT_LEN &&
    after.data.subarray(0, 8).toString("hex") === DISC &&
    after.owner.toBase58() === PROGRAM.toBase58();
  console.log(JSON.stringify({
    verify: { length: after?.data.length, keeper: after ? pk(after.data, 845) : null,
      version: after ? after.data.readBigUInt64LE(8).toString() : null,
      expiry_slot: after ? after.data.readBigUInt64LE(24).toString() : null, ok },
  }));
  if (!ok) throw new Error("post-migration verification failed");
}
main().catch((e) => { console.error(e); process.exit(1); });
