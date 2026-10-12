// S2-11 live staged-quote driver.
//
// The quote engine is the Rust keeper (`arbswap-keeper quote-json`), which
// computes the exact `QuoteUpdate` payload from a genuine Pyth update and emits
// its Borsh body. This driver:
//   1. fetches a fresh Hermes SOL/USD update;
//   2. asks the Rust engine for the quote built from that exact update;
//   3. sends `stage_quote` (Tx A) and the Wormhole VAA post (Tx V);
//   4. sends the Pyth push-oracle `updatePriceFeed` and `commit_quote` as ONE
//      transaction (Tx B), so the oracle write and the quote commit are atomic;
//   5. rereads `QuoteState.version` from devnet.
//
// Requires the official Pyth receiver SDK (TypeScript only) for the Pyth
// instructions; no oracle constraint is relaxed.
//
//   PYTH_API_KEY=... npx tsx keeper_live.ts
import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver, getPriceFeedAccountForProgram } from "@pythnetwork/pyth-solana-receiver";
import { Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  AccountMeta,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";

const PROGRAM = new PublicKey("2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm");
const VAULT = new PublicKey("8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt");
const CONFIG = new PublicKey("ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT");
const QUOTE_STATE = new PublicKey("5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG");
const BASE_RESERVE = new PublicKey("8vfr2KmMmXYUTjRg5cAiSYD6EhN1d8pjJnmFC95E2vfm");
const QUOTE_RESERVE = new PublicKey("G8q1WMKT8fnGQh85kCB8Aihf6F7tctXJDKbA6gn1jPeS");
const KEEPER_BOND = new PublicKey("DsSQaVCdwzKjbxRJm4vmbbqqJwLgLMmDgzMjkeneUryd");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const PUSH_ORACLE = "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT";
const WORMHOLE = "HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ";
const SYSTEM = PublicKey.default;
const KEEPER_BIN = process.env.KEEPER_BIN ?? "/home/ash10/solana/arbswap/target/debug/arbswap-keeper";

const disc = (name: string): Buffer => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64le = (n: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const meta = (pubkey: PublicKey, writable = false, signer = false): AccountMeta => ({ pubkey, isWritable: writable, isSigner: signer });

const TRADER_WSOL = new PublicKey("5MpRjKvzgW5C7x8sbam4KgA5KGkGyTKNCXarbqZceCnJ");
const TRADER_USDC = new PublicKey("5SThVCCb6vrvvkwSMukanW5vWkUehBCVW8iT53KqVzgV");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// Read-only BuyBase swap preflight: builds each candidate against the
// just-committed quote and SIMULATES it (never sends). Runs inside the keeper
// loop so the quote is still within its (10-slot) expiry window. For each amount
// it first simulates with min_out=0 to read the exact `SwapEvent.amount_out`,
// then re-simulates with a 0.5% floor to prove the intended min_out passes.
async function simulateSwap(connection: Connection, trader: Keypair, qsData: Buffer): Promise<void> {
  const cfg = (await connection.getAccountInfo(CONFIG, "processed"))!.data;
  const feeBps = cfg.readUInt16LE(136);
  const version = qsData.readBigUInt64LE(8);
  const expiry = qsData.readBigUInt64LE(24);
  const pResSqrt = qsData.readBigUInt64LE(48) | (qsData.readBigUInt64LE(56) << 64n);
  const priceQ64 = (pResSqrt * pResSqrt) / (1n << 64n);
  const amounts = (process.env.SWAP_ATOMS ?? "500000,1000000,2000000,3000000,3500000,3600000,4000000")
    .split(",").map((s) => BigInt(s.trim()));

  const simulate = async (amountIn: bigint, minOut: bigint) => {
    const data = Buffer.concat([disc("swap"), Buffer.from([0]), u64le(amountIn), u64le(minOut), u64le(version)]);
    const ix = new TransactionInstruction({
      programId: PROGRAM,
      data,
      keys: [
        meta(trader.publicKey, true, true), meta(VAULT, true), meta(CONFIG), meta(QUOTE_STATE, true),
        meta(BASE_RESERVE, true), meta(QUOTE_RESERVE, true), meta(TRADER_WSOL, true), meta(TRADER_USDC, true), meta(TOKEN),
      ],
    });
    const { blockhash } = await connection.getLatestBlockhash("processed");
    const tx = new Transaction({ feePayer: trader.publicKey, recentBlockhash: blockhash });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }));
    tx.add(ix);
    tx.sign(trader);
    const sim = await connection.simulateTransaction(tx);
    return { err: sim.value.err, logs: sim.value.logs, size: tx.serialize().length };
  };

  const results: any[] = [];
  for (const amountIn of amounts) {
    const fee = (amountIn * BigInt(feeBps) + 9999n) / 10000n;
    const first = await simulate(amountIn, 0n);
    let eventOut: bigint | null = null;
    const evDisc = createHash("sha256").update("event:SwapEvent").digest().subarray(0, 8);
    for (const line of first.logs ?? []) {
      const m = line.match(/^Program data: (.+)$/);
      if (!m) continue;
      const raw = Buffer.from(m[1], "base64");
      if (raw.length >= 49 && raw.subarray(0, 8).equals(evDisc)) {
        eventOut = raw.readBigUInt64LE(33);
      }
    }
    results.push({
      amount_in_atoms: amountIn.toString(), amount_in_usdc: Number(amountIn) / 1e6,
      fee_atoms: fee.toString(), net_in_atoms: (amountIn - fee).toString(),
      event_out_atoms: eventOut === null ? null : eventOut.toString(),
      event_out_sol: eventOut === null ? null : Number(eventOut) / 1e9,
      sim_err: first.err, tx_size_bytes: first.size,
    });
  }
  const passing = results.filter((r) => r.sim_err === null && r.event_out_atoms !== null);
  passing.sort((a, b) => Number(BigInt(b.amount_in_atoms) - BigInt(a.amount_in_atoms)));
  let confirm: any = null;
  if (passing.length > 0) {
    const best = passing[0];
    const floor = (BigInt(best.event_out_atoms) * 9950n) / 10000n;
    const second = await simulate(BigInt(best.amount_in_atoms), floor);
    confirm = { amount_in_atoms: best.amount_in_atoms, min_out_atoms: floor.toString(), sim_err: second.err, tx_size_bytes: second.size };
  }
  console.log(JSON.stringify({ buybase_preflight: { side: "buyBase", fee_bps: feeBps, quote_version: version.toString(), quote_expiry_slot: expiry.toString(), candidates: results, best_with_min_out: confirm } }));
}

function priceQ64(price: string, expo: number): bigint {
  const p = BigInt(price);
  if (expo >= 0) return p * 10n ** BigInt(expo) * (1n << 64n);
  return (p * (1n << 64n)) / 10n ** BigInt(-expo);
}
function confBps(conf: string, price: string): number {
  const bps = (BigInt(conf) * 10000n + BigInt(price) - 1n) / BigInt(price);
  return Number(bps);
}

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const keyPath = process.env.ARBSWAP_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")));
  const keeper = Keypair.fromSecretKey(secret);
  const connection = new Connection(rpc, "processed");
  const wallet = new Wallet(keeper);
  const hermes = new HermesClient(process.env.HERMES_URL ?? "https://hermes.pyth.network", process.env.PYTH_API_KEY ? { accessToken: process.env.PYTH_API_KEY } : {});
  const receiver = new PythSolanaReceiver({ connection, wallet });

  const feed = Buffer.from(FEED_ID, "hex");
  const priceUpdate = getPriceFeedAccountForProgram(0, feed);
  const [pending] = PublicKey.findProgramAddressSync(
    [Buffer.from("pending_quote"), VAULT.toBuffer(), keeper.publicKey.toBuffer()],
    PROGRAM,
  );
  const baseDec = 9;
  const quoteDec = 6;
  console.log("feed_account", priceUpdate.toBase58(), "pending_quote", pending.toBase58());

  const vaultInfo = await connection.getAccountInfo(VAULT, "processed");
  if (!vaultInfo) throw new Error("vault missing");
  const baseBal = await connection.getTokenAccountBalance(BASE_RESERVE, "processed");
  const quoteBal = await connection.getTokenAccountBalance(QUOTE_RESERVE, "processed");
  const baseAvail = BigInt(baseBal.value.amount);
  const quoteAvail = BigInt(quoteBal.value.amount);
  console.log("reserves", baseAvail.toString(), quoteAvail.toString());

  const attempts = Number(process.env.ATTEMPTS ?? 8);
  const runSeconds = Number(process.env.RUN_SECONDS ?? 0);
  const deadline = Date.now() + runSeconds * 1000;
  let success = false;
  for (let attempt = 1; attempt <= attempts && !(success && runSeconds === 0); attempt += 1) {
    if (runSeconds > 0 && Date.now() > deadline) break;
    // 1. Fresh Hermes update (fetched immediately before staging/posting).
    const updates = await hermes.getLatestPriceUpdates([`0x${FEED_ID}`], { encoding: "base64" });
    const parsed = updates.parsed?.[0]?.price;
    if (!parsed) throw new Error("hermes returned no parsed price");
    const publishTime = parsed.publish_time;
    const conf = confBps(String(parsed.conf), String(parsed.price));
    const slot = await connection.getSlot("processed");
    const q64 = priceQ64(String(parsed.price), parsed.expo);
    console.log(`attempt=${attempt} publish_time=${publishTime} age_ms=${Date.now() - publishTime * 1000} slot=${slot} price_q64=${q64} conf_bps=${conf}`);

    // 2. Quote engine. Returns no quote (non-zero exit) when its own depth
    // throttle fails closed (e.g. confidence at the cap); skip and retry.
    let quote: any;
    try {
      const out = execFileSync(KEEPER_BIN, [
        "quote-json", q64.toString(), baseAvail.toString(), quoteAvail.toString(),
        "0", String(baseDec), String(quoteDec), String(publishTime), String(slot), String(conf),
      ], { encoding: "utf8" });
      quote = JSON.parse(out);
    } catch {
      console.error(`attempt=${attempt} quote engine returned no quote (conf_bps=${conf}); skipping`);
      continue;
    }
    const body = Buffer.from(quote.body_hex, "hex");
    if (body.length !== 692) throw new Error(`unexpected quote body length ${body.length}`);
    const oraclePublishTime = BigInt(quote.oracle_publish_time);
    if (oraclePublishTime !== BigInt(publishTime)) throw new Error("quote publish_time mismatch");

    const nonce = BigInt(Date.now());
    const stageData = Buffer.concat([disc("stage_quote"), body, u64le(nonce)]);
    const commitData = Buffer.concat([disc("commit_quote"), u64le(nonce)]);

    // 3. stage + VAA + push/commit transaction pieces.
    const stageIx = new TransactionInstruction({
      programId: PROGRAM,
      data: stageData,
      keys: [
        meta(keeper.publicKey, true, true), meta(VAULT), meta(CONFIG), meta(QUOTE_STATE),
        meta(pending, true), meta(BASE_RESERVE), meta(QUOTE_RESERVE), meta(KEEPER_BOND), meta(SYSTEM),
      ],
    });
    const commitIx = new TransactionInstruction({
      programId: PROGRAM,
      data: commitData,
      keys: [
        meta(keeper.publicKey, true, true), meta(VAULT), meta(CONFIG), meta(QUOTE_STATE, true),
        meta(pending, true), meta(priceUpdate), meta(BASE_RESERVE), meta(QUOTE_RESERVE),
        meta(KEEPER_BOND), meta(WSOL), meta(USDC),
        // The Pyth receiver (CPI'd by the push oracle) verifies against the
        // Wormhole program, which must be present in the transaction's account
        // list; the SDK adds it to its own push transaction for the same reason.
        // Extra trailing accounts are ignored by our Anchor `commit_quote`.
        meta(new PublicKey(WORMHOLE)),
      ],
    });

    const { postInstructions } = await receiver.buildUpdatePriceFeedInstructions(updates.binary.data, 0);
    // Everything except the push is the VAA pipeline: the system `create` (which
    // funds/owns the encoded-VAA account), then init/write/verify on Wormhole.
    const vaaItems = postInstructions.filter((p: any) => p.instruction.programId.toBase58() !== PUSH_ORACLE);
    const pushItems = postInstructions.filter((p: any) => p.instruction.programId.toBase58() === PUSH_ORACLE);
    if (pushItems.length !== 1) throw new Error(`expected 1 push instruction, got ${pushItems.length}`);

    const { blockhash } = await connection.getLatestBlockhash("processed");
    const stageTx = new Transaction({ feePayer: keeper.publicKey, recentBlockhash: blockhash });
    stageTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    stageTx.add(stageIx);
    stageTx.sign(keeper);

    const vaaTx = new Transaction({ feePayer: keeper.publicKey, recentBlockhash: blockhash });
    vaaTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
    const vaaSigners: Keypair[] = [];
    for (const item of vaaItems) {
      vaaTx.add(item.instruction);
      vaaSigners.push(...(item.signers ?? []));
    }
    vaaTx.sign(keeper, ...vaaSigners);

    const pushTx = new Transaction({ feePayer: keeper.publicKey, recentBlockhash: blockhash });
    pushTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    pushTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
    pushTx.add(pushItems[0].instruction);
    pushTx.add(commitIx);
    pushTx.sign(keeper);
    console.log(`sizes stage=${stageTx.serialize().length} vaa=${vaaTx.serialize().length} push+commit=${pushTx.serialize().length}`);

    const send = async (tx: Transaction): Promise<string> => {
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2, preflightCommitment: "processed" });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight }, "processed");
      return sig;
    };

    try {
      const [stageSig, vaaSig] = await Promise.all([send(stageTx), send(vaaTx)]);
      console.log(`stage_sig=${stageSig}`);
      console.log(`vaa_sig=${vaaSig}`);
      const pushSig = await send(pushTx);
      const tx = await connection.getTransaction(pushSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const err = tx?.meta?.err ?? null;
      console.log(`push_commit_sig=${pushSig} slot=${tx?.slot ?? "?"} err=${JSON.stringify(err)}`);
      if (err) {
        console.error("commit logs:", tx?.meta?.logMessages?.slice(-8).join(" | "));
        continue;
      }
      const qs = await connection.getAccountInfo(QUOTE_STATE, "processed");
      const version = qs!.data.readBigUInt64LE(8);
      const updateSlot = qs!.data.readBigUInt64LE(16);
      console.log(`QuoteState version=${version} update_slot=${updateSlot}`);
      if (version > 0n) {
        success = true;
        console.log(JSON.stringify({ ok: true, stage_sig: stageSig, vaa_sig: vaaSig, push_commit_sig: pushSig, slot: tx?.slot, version: version.toString(), update_slot: updateSlot.toString() }));
        if (process.env.SIMULATE_SWAP === "1") {
          await simulateSwap(connection, keeper, qs!.data);
        }
        if (runSeconds > 0) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    } catch (e) {
      console.error("attempt failed:", (e as Error).message);
    }
  }
  if (!success) {
    console.error("no live quote landed");
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
