// S2-40 / Task 8.2: live devnet BuyBase / SellBase swap smoke (operator-run).
//
// Extends the read-only `swap_preflight.ts` sender: waits for a genuinely FRESH
// committed quote, builds the exact account set the app signs, SIMULATES it, and
// only then submits + confirms. Small amounts; devnet test tokens only.
//
//   ARBSWAP_KEYPAIR=<trader> npx tsx swap_smoke.ts buy|sell|both
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, AccountMeta, SystemProgram,
} from "@solana/web3.js";
import { createHash } from "crypto";
import fs from "fs";
import { resolveRpcConfig, redactUrl } from "./rpc";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ata = (mint: PublicKey, owner: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID)[0];
const createAtaIdempotent = (payer: PublicKey, account: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction =>
  new TransactionInstruction({
    programId: ATA_PROGRAM_ID, data: Buffer.from([1]),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });

const PROGRAM = new PublicKey("2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm");
const VAULT = new PublicKey("8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt");
const CONFIG = new PublicKey("ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT");
const QUOTE_STATE = new PublicKey("5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG");
const BASE_RESERVE = new PublicKey("8vfr2KmMmXYUTjRg5cAiSYD6EhN1d8pjJnmFC95E2vfm");
const QUOTE_RESERVE = new PublicKey("G8q1WMKT8fnGQh85kCB8Aihf6F7tctXJDKbA6gn1jPeS");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const BUY_BASE = 0; // program enum: BuyBase = 0, SellBase = 1
const SELL_BASE = 1;
const BUY_IN_QUOTE = 500_000n;   // 0.5 USDC atoms
const SELL_IN_BASE = 5_000_000n; // 0.005 WSOL atoms
const SLIPPAGE_BPS = 50;         // 0.5%
const WAIT_SECONDS = Number(process.env.SWAP_WAIT_SEC ?? 240);

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const meta = (pubkey: PublicKey, writable = false, signer = false): AccountMeta => ({ pubkey, isWritable: writable, isSigner: signer });
const u128 = (d: Buffer, o: number): bigint => d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FreshQuote { slot: number; version: bigint; expiry: bigint; pResSqrt: bigint; keeper: PublicKey; feeBps: number }

async function freshQuote(connection: Connection, cfgFeeBpsOffsetData: () => Promise<Buffer>): Promise<FreshQuote> {
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  for (;;) {
    const slot = await connection.getSlot("processed");
    const info = await connection.getAccountInfo(QUOTE_STATE, "processed");
    const qs = info?.data ?? null;
    const exp = qs ? Number(qs.readBigUInt64LE(24)) : 0;
    if (qs && exp > 0 && slot < exp) {
      const cfgData = await cfgFeeBpsOffsetData();
      return {
        slot, version: qs.readBigUInt64LE(8), expiry: qs.readBigUInt64LE(24),
        pResSqrt: u128(qs, 48), keeper: new PublicKey(qs.subarray(845, 877)),
        feeBps: cfgData.readUInt16LE(136),
      };
    }
    if (Date.now() > deadline) throw new Error(`no fresh quote within ${WAIT_SECONDS}s (slot ${slot} >= expiry ${exp})`);
    await sleep(300);
  }
}

async function sendSwap(connection: Connection, trader: Keypair, side: number, amountIn: bigint, q: FreshQuote): Promise<string> {
  const fee = (amountIn * BigInt(q.feeBps) + 9999n) / 10000n;
  const netIn = amountIn - fee;
  const priceQ64 = (q.pResSqrt * q.pResSqrt) / (1n << 64n);
  const expectedOut = side === BUY_BASE
    ? (netIn * (1n << 64n)) / priceQ64
    : (netIn * priceQ64) / (1n << 64n);
  const minOut = (expectedOut * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;

  const [keeperReward] = PublicKey.findProgramAddressSync(
    [Buffer.from("reward"), VAULT.toBuffer(), q.keeper.toBuffer()], PROGRAM);
  const traderBase = ata(WSOL, trader.publicKey);
  const traderQuote = ata(USDC, trader.publicKey);

  const data = Buffer.concat([disc("swap"), Buffer.from([side]), u64(amountIn), u64(minOut), u64(q.version)]);
  const ix = new TransactionInstruction({
    programId: PROGRAM, data,
    keys: [
      meta(trader.publicKey, true, true), meta(VAULT, true), meta(CONFIG), meta(QUOTE_STATE, true),
      meta(BASE_RESERVE, true), meta(QUOTE_RESERVE, true), meta(traderBase, true), meta(traderQuote, true),
      meta(keeperReward, true), meta(SystemProgram.programId), meta(TOKEN_PROGRAM_ID),
    ],
  });
  const pre: TransactionInstruction[] = [];
  if (!(await connection.getAccountInfo(traderBase))) pre.push(createAtaIdempotent(trader.publicKey, traderBase, trader.publicKey, WSOL));
  if (!(await connection.getAccountInfo(traderQuote))) pre.push(createAtaIdempotent(trader.publicKey, traderQuote, trader.publicKey, USDC));

  const { blockhash } = await connection.getLatestBlockhash("processed");
  const tx = new Transaction({ feePayer: trader.publicKey, recentBlockhash: blockhash });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }));
  for (const p of pre) tx.add(p);
  tx.add(ix);
  tx.sign(trader);

  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    throw new Error(`simulation failed (not sent): ${JSON.stringify(sim.value.err)} logs=${JSON.stringify((sim.value.logs ?? []).slice(-6))}`);
  }
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  console.error(`submitted ${sig}; confirming...`);
  for (let i = 0; i < 60; i++) {
    const st = await connection.getSignatureStatuses([sig]);
    const v = st.value[0];
    if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") {
      if (v.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(v.err)}`);
      return sig;
    }
    await sleep(500);
  }
  throw new Error(`tx ${sig} not confirmed within 30s`);
}

async function main() {
  const which = (process.argv[2] ?? "both").toLowerCase();
  const cfg = resolveRpcConfig(process.env);
  const connection = new Connection(cfg.endpoints[0], "processed");
  console.error(`rpc=${redactUrl(cfg.endpoints[0])} side=${which}`);
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(
    process.env.ARBSWAP_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`, "utf8")));
  const trader = Keypair.fromSecretKey(secret);
  const cfgData = () => connection.getAccountInfo(CONFIG, "processed").then((i) => i!.data);
  const out: Record<string, unknown> = { wallet: trader.publicKey.toBase58() };

  const sides: Array<{ name: string; side: number; amountIn: bigint }> = [];
  if (which === "buy" || which === "both") sides.push({ name: "buyBase", side: BUY_BASE, amountIn: BUY_IN_QUOTE });
  if (which === "sell" || which === "both") sides.push({ name: "sellBase", side: SELL_BASE, amountIn: SELL_IN_BASE });

  for (const s of sides) {
    const q = await freshQuote(connection, cfgData);
    const sig = await sendSwap(connection, trader, s.side, s.amountIn, q);
    out[s.name] = {
      signature: sig, amount_in_atoms: s.amountIn.toString(), fee_bps: q.feeBps,
      quote_version: q.version.toString(), quote_expiry_slot: q.expiry.toString(),
      start_slot: q.slot, keeper: q.keeper.toBase58(),
      explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
    };
    console.error(`${s.name} OK ${sig}`);
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error(String((e as Error).message ?? e)); process.exit(1); });
