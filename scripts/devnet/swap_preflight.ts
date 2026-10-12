// S2-11 swap PREFLIGHT — read-only. Builds and SIMULATES an integer-only swap
// against the live on-chain quote. It NEVER submits a transaction. Execution
// requires separate explicit approval of the direction, amount and min_out.
//
//   npx tsx swap_preflight.ts
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  AccountMeta,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import fs from "fs";

const PROGRAM = new PublicKey("2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm");
const VAULT = new PublicKey("8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt");
const CONFIG = new PublicKey("ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT");
const QUOTE_STATE = new PublicKey("5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG");
const BASE_RESERVE = new PublicKey("8vfr2KmMmXYUTjRg5cAiSYD6EhN1d8pjJnmFC95E2vfm");
const QUOTE_RESERVE = new PublicKey("G8q1WMKT8fnGQh85kCB8Aihf6F7tctXJDKbA6gn1jPeS");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const TRADER_WSOL = new PublicKey("5MpRjKvzgW5C7x8sbam4KgA5KGkGyTKNCXarbqZceCnJ");
const TRADER_USDC = new PublicKey("5SThVCCb6vrvvkwSMukanW5vWkUehBCVW8iT53KqVzgV");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const Q64 = 1n << 64n;

// PREFLIGHT PLAN (BuyBase = spend USDC, receive WSOL).
const SIDE = "buyBase" as const;
const BUY_BASE = 0; // program enum: BuyBase = 0, SellBase = 1
const AMOUNT_IN = 500_000n; // 0.5 USDC atoms
const SLIPPAGE_BPS = 50; // 0.5%

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const meta = (pubkey: PublicKey, writable = false, signer = false): AccountMeta => ({ pubkey, isWritable: writable, isSigner: signer });

function u128(d: Buffer, o: number): bigint { return d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n); }

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ARBSWAP_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`, "utf8")));
  const trader = Keypair.fromSecretKey(secret);
  const connection = new Connection(rpc, "processed");

  const qs = (await connection.getAccountInfo(QUOTE_STATE, "processed"))!.data;
  const cfg = (await connection.getAccountInfo(CONFIG, "processed"))!.data;
  const feeBps = cfg.readUInt16LE(136);
  const version = qs.readBigUInt64LE(8);
  const expirySlot = qs.readBigUInt64LE(24);
  const pResSqrt = u128(qs, 48);
  const currentSlot = BigInt(await connection.getSlot("processed"));

  // Integer-only plan (same conservative floor the app uses for min_out).
  const fee = (AMOUNT_IN * BigInt(feeBps) + 9999n) / 10000n;
  const netIn = AMOUNT_IN - fee;
  const priceQ64 = (pResSqrt * pResSqrt) / Q64;
  const expectedOut = SIDE === "sellBase" ? (netIn * priceQ64) / Q64 : (netIn * Q64) / priceQ64;
  const minOut = (expectedOut * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;

  const data = Buffer.concat([disc("swap"), Buffer.from([BUY_BASE]), u64(AMOUNT_IN), u64(minOut), u64(version)]);
  const ix = new TransactionInstruction({
    programId: PROGRAM,
    data,
    keys: [
      meta(trader.publicKey, true, true), meta(VAULT, true), meta(CONFIG), meta(QUOTE_STATE, true),
      meta(BASE_RESERVE, true), meta(QUOTE_RESERVE, true), meta(TRADER_WSOL, true), meta(TRADER_USDC, true),
      meta(TOKEN),
    ],
  });
  const { blockhash } = await connection.getLatestBlockhash("processed");
  const tx = new Transaction({ feePayer: trader.publicKey, recentBlockhash: blockhash });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }));
  tx.add(ix);
  tx.sign(trader);

  const sim = await connection.simulateTransaction(tx);
  const plan = {
    side: SIDE,
    amount_in_atoms: AMOUNT_IN.toString(),
    fee_bps: feeBps,
    fee_atoms: fee.toString(),
    net_in_atoms: netIn.toString(),
    expected_out_atoms: expectedOut.toString(),
    min_out_atoms: minOut.toString(),
    slippage_bps: SLIPPAGE_BPS,
    quote_version: version.toString(),
    quote_expiry_slot: expirySlot.toString(),
    current_slot: currentSlot.toString(),
    quote_expired: currentSlot > expirySlot,
    accounts: {
      trader: trader.publicKey.toBase58(), vault: VAULT.toBase58(), config: CONFIG.toBase58(),
      quote_state: QUOTE_STATE.toBase58(), base_reserve: BASE_RESERVE.toBase58(),
      quote_reserve: QUOTE_RESERVE.toBase58(), trader_base: TRADER_WSOL.toBase58(),
      trader_quote: TRADER_USDC.toBase58(), token_program: TOKEN.toBase58(),
    },
    tx_size_bytes: tx.serialize().length,
    simulation_err: sim.value.err,
    simulation_logs_tail: sim.value.logs?.slice(-6) ?? [],
  };
  console.log(JSON.stringify(plan, null, 2));
  void sendAndConfirmTransaction;
}
main().catch((e) => { console.error(e); process.exit(1); });
