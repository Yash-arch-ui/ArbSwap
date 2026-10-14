// S2-40 Phase 4/5: read-only BuyBase swap preflight.
//
// Waits for a genuinely FRESH committed quote (slot < expiry), then derives the
// trader's real ATAs from the keypair, builds the exact instruction set the app
// would sign (including idempotent ATA creation), and SIMULATES it. It NEVER
// submits. Execution needs separate explicit operator approval.
//
//   ARBSWAP_KEYPAIR=<trader> npx tsx swap_preflight.ts
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
/** Idempotent ATA create (without the spl-token dependency). */
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
const AMOUNT_IN = 500_000n; // 0.5 USDC atoms
const SLIPPAGE_BPS = 50; // 0.5%
const WAIT_SECONDS = Number(process.env.PREFLIGHT_WAIT_SEC ?? 240);

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const meta = (pubkey: PublicKey, writable = false, signer = false): AccountMeta => ({ pubkey, isWritable: writable, isSigner: signer });
const u128 = (d: Buffer, o: number): bigint => d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = resolveRpcConfig(process.env);
  const connection = new Connection(cfg.endpoints[0], "processed");
  console.error(`rpc=${redactUrl(cfg.endpoints[0])}`);
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(
    process.env.ARBSWAP_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`, "utf8")));
  const trader = Keypair.fromSecretKey(secret);

  // Wait for a fresh quote (no fee, read-only).
  let slot = 0; let qsData: Buffer | null = null;
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  for (;;) {
    slot = await connection.getSlot("processed");
    const info = await connection.getAccountInfo(QUOTE_STATE, "processed");
    qsData = info?.data ?? null;
    const exp = qsData ? Number(qsData.readBigUInt64LE(24)) : 0;
    if (exp > 0 && slot < exp) break;
    if (Date.now() > deadline) {
      console.error(`no fresh quote within ${WAIT_SECONDS}s (slot ${slot} >= expiry ${exp}); the quote is expired`);
      break;
    }
    await sleep(300);
  }

  const cfgData = (await connection.getAccountInfo(CONFIG, "processed"))!.data;
  const feeBps = cfgData.readUInt16LE(136);
  const qs = qsData!;
  const version = qs.readBigUInt64LE(8);
  const expirySlot = qs.readBigUInt64LE(24);
  const pResSqrt = u128(qs, 48);

  const fee = (AMOUNT_IN * BigInt(feeBps) + 9999n) / 10000n;
  const netIn = AMOUNT_IN - fee;
  const priceQ64 = (pResSqrt * pResSqrt) / (1n << 64n);
  const expectedOut = (netIn * (1n << 64n)) / priceQ64;
  const minOut = (expectedOut * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;

  const attributedKeeper = new PublicKey(qs.subarray(845, 877));
  const [keeperReward] = PublicKey.findProgramAddressSync(
    [Buffer.from("reward"), VAULT.toBuffer(), attributedKeeper.toBuffer()], PROGRAM);
  const traderBase = ata(WSOL, trader.publicKey);
  const traderQuote = ata(USDC, trader.publicKey);

  const data = Buffer.concat([disc("swap"), Buffer.from([BUY_BASE]), u64(AMOUNT_IN), u64(minOut), u64(version)]);
  const ix = new TransactionInstruction({
    programId: PROGRAM, data,
    keys: [
      meta(trader.publicKey, true, true), meta(VAULT, true), meta(CONFIG), meta(QUOTE_STATE, true),
      meta(BASE_RESERVE, true), meta(QUOTE_RESERVE, true), meta(traderBase, true), meta(traderQuote, true),
      meta(keeperReward, true), meta(PublicKey.default), meta(TOKEN_PROGRAM_ID),
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

  const usdcBal = await connection.getTokenAccountBalance(traderQuote, "processed").then((r) => r.value.uiAmountString).catch(() => null);
  const wsolBal = await connection.getTokenAccountBalance(traderBase, "processed").then((r) => r.value.uiAmountString).catch(() => null);
  const sol = (await connection.getBalance(trader.publicKey)) / 1e9;

  console.log(JSON.stringify({
    side: "buyBase", amount_in_atoms: AMOUNT_IN.toString(), fee_bps: feeBps,
    fee_atoms: fee.toString(), net_in_atoms: netIn.toString(),
    expected_out_atoms: expectedOut.toString(), min_out_atoms: minOut.toString(), slippage_bps: SLIPPAGE_BPS,
    quote_version: version.toString(), quote_expiry_slot: expirySlot.toString(), current_slot: slot,
    quote_fresh: BigInt(slot) < expirySlot, attributed_keeper: attributedKeeper.toBase58(),
    wallet: trader.publicKey.toBase58(), balances: { sol, wsol: wsolBal, usdc: usdcBal },
    accounts: { vault: VAULT.toBase58(), config: CONFIG.toBase58(), quote_state: QUOTE_STATE.toBase58(),
      base_reserve: BASE_RESERVE.toBase58(), quote_reserve: QUOTE_RESERVE.toBase58(),
      trader_base: traderBase.toBase58(), trader_quote: traderQuote.toBase58(),
      keeper_reward: keeperReward.toBase58(), token_program: TOKEN_PROGRAM_ID.toBase58() },
    pre_instructions: pre.length, tx_size_bytes: tx.serialize().length,
    simulation_err: sim.value.err, simulation_logs_tail: (sim.value.logs ?? []).slice(-6),
  }, null, 2));
}
main().catch((e) => { console.error(String((e as Error).message ?? e)); process.exit(1); });
