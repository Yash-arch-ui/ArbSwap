// Bounded, self-terminating applier for the ALREADY-PROPOSED volatility params.
//
// Polls the finalized slot; when it reaches the pending proposal's on-chain
// `activate_slot`, submits `apply_volatility_params` ONCE (signed by the vault
// admin), verifies `enabled == true` on-chain, then exits. It never bypasses the
// timelock, never re-proposes, and stops if the proposal is absent/consumed or
// enforcement is already enabled. Bounded by a max wall-clock budget.
//
//   npx tsx volatility_apply_daemon.ts
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import fs from "fs";
import { resolveRpcConfig, redactUrl } from "./rpc";

const PROGRAM = new PublicKey("2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm");
const VAULT = new PublicKey("8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt");
const [VOL] = PublicKey.findProgramAddressSync([Buffer.from("vol"), VAULT.toBuffer()], PROGRAM);
const [PENDING] = PublicKey.findProgramAddressSync([Buffer.from("vol_pending"), VAULT.toBuffer()], PROGRAM);
const disc = (n: string): Buffer => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_WAIT_MS = 16 * 60 * 60 * 1000; // 16 h hard cap

async function main() {
  const cfg = resolveRpcConfig(process.env);
  const connection = new Connection(cfg.endpoints[0], "finalized");
  const path = process.env.ARBSWAP_DEVNET_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
  console.log(JSON.stringify({ event: "applier_start", rpc: redactUrl(cfg.endpoints[0]), admin: admin.publicKey.toBase58(), vol: VOL.toBase58(), pending: PENDING.toBase58(), deadline_ms: MAX_WAIT_MS }));
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const slot = await connection.getSlot("finalized");
      const [p, v] = await Promise.all([
        connection.getAccountInfo(PENDING, "finalized"),
        connection.getAccountInfo(VOL, "finalized"),
      ]);
      if (v && v.data.readUInt8(173) === 1) {
        console.log(JSON.stringify({ event: "already_enabled", slot, exit: "ok" }));
        return;
      }
      if (!p) {
        console.log(JSON.stringify({ event: "no_pending_proposal", slot, exit: "noop" }));
        return;
      }
      const activate = p.data.readBigUInt64LE(40);
      if (activate === 0xffffffffffffffffn) {
        console.log(JSON.stringify({ event: "pending_consumed_disabled", slot, exit: "noop" }));
        return;
      }
      if (BigInt(slot) >= activate) {
        const ix = new TransactionInstruction({
          programId: PROGRAM,
          data: disc("apply_volatility_params"),
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: true },
            { pubkey: VAULT, isSigner: false, isWritable: false },
            { pubkey: VOL, isSigner: false, isWritable: true },
            { pubkey: PENDING, isSigner: false, isWritable: true },
          ],
        });
        const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [admin], { commitment: "finalized" });
        const v2 = await connection.getAccountInfo(VOL, "finalized");
        const slot2 = await connection.getSlot("finalized");
        console.log(JSON.stringify({ event: "applied", signature: sig, finalized_slot: slot2, enabled: v2 ? v2.data.readUInt8(173) : null }));
        return;
      }
      console.log(JSON.stringify({ event: "waiting", slot, activate_slot: activate.toString(), remaining: (activate - BigInt(slot)).toString() }));
    } catch (e) {
      console.log(JSON.stringify({ event: "poll_error", error: String(e).slice(0, 160) }));
    }
    await sleep(60_000);
  }
  console.log(JSON.stringify({ event: "timed_out", exit: "timeout" }));
  process.exit(2);
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
