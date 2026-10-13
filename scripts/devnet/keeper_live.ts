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
import {
  classifyCommit,
  isSuccess,
  backoffDelayMs,
  type CommitObservation,
} from "./keeper_commit";
import { resolveRpcConfig, RpcPool } from "./rpc";

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
  // S2-19: the quote author (QuoteState.keeper) is appended at byte offset 845;
  // the swap credits that keeper's reward PDA.
  const attributedKeeper = new PublicKey(qsData.subarray(845, 877));
  const [keeperReward] = PublicKey.findProgramAddressSync(
    [Buffer.from("reward"), VAULT.toBuffer(), attributedKeeper.toBuffer()],
    PROGRAM,
  );
  const amounts = (process.env.SWAP_ATOMS ?? "500000,1000000,2000000,3000000,3500000,3600000,4000000")
    .split(",").map((s) => BigInt(s.trim()));

  const buildSwapTx = async (amountIn: bigint, minOut: bigint) => {
    const data = Buffer.concat([disc("swap"), Buffer.from([0]), u64le(amountIn), u64le(minOut), u64le(version)]);
    const ix = new TransactionInstruction({
      programId: PROGRAM,
      data,
      keys: [
        meta(trader.publicKey, true, true), meta(VAULT, true), meta(CONFIG), meta(QUOTE_STATE, true),
        meta(BASE_RESERVE, true), meta(QUOTE_RESERVE, true), meta(TRADER_WSOL, true), meta(TRADER_USDC, true),
        meta(keeperReward, true), meta(SYSTEM), meta(TOKEN),
      ],
    });
    const { blockhash } = await connection.getLatestBlockhash("processed");
    const tx = new Transaction({ feePayer: trader.publicKey, recentBlockhash: blockhash });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }));
    tx.add(ix);
    tx.sign(trader);
    return { tx, blockhash, size: tx.serialize().length };
  };
  const simulate = async (amountIn: bigint, minOut: bigint) => {
    const { tx } = await buildSwapTx(amountIn, minOut);
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
  let execution: any = null;
  if (confirm && confirm.sim_err === null && process.env.EXECUTE_SWAP === "1") {
    const amountIn = BigInt(confirm.amount_in_atoms);
    const minOut = BigInt(confirm.min_out_atoms);
    const { tx, blockhash } = await buildSwapTx(amountIn, minOut);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "processed" });
    const latest = await connection.getLatestBlockhash("confirmed");
    const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, "confirmed");
    const tb = await connection.getTokenAccountBalance(TRADER_WSOL, "confirmed");
    const tq = await connection.getTokenAccountBalance(TRADER_USDC, "confirmed");
    const vb = await connection.getTokenAccountBalance(BASE_RESERVE, "confirmed");
    const vq = await connection.getTokenAccountBalance(QUOTE_RESERVE, "confirmed");
    execution = {
      signature: sig, confirm_err: conf.value.err, amount_in_atoms: amountIn.toString(), min_out_atoms: minOut.toString(),
      trader_wsol: tb.value.amount, trader_usdc: tq.value.amount, vault_base: vb.value.amount, vault_quote: vq.value.amount,
    };
    console.log(JSON.stringify({ swap_executed: execution }));
  }
  console.log(JSON.stringify({ buybase_preflight: { side: "buyBase", fee_bps: feeBps, quote_version: version.toString(), quote_expiry_slot: expiry.toString(), candidates: results, best_with_min_out: confirm, execution } }));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retry `getTransaction` a bounded number of times before declaring it unobserved. */
async function getTransactionWithRetry(
  connection: Connection,
  sig: string,
  attempts = 6,
): Promise<Awaited<ReturnType<Connection["getTransaction"]>>> {
  for (let i = 1; i <= attempts; i += 1) {
    const tx = await connection
      .getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
      .catch(() => null);
    if (tx) return tx;
    await sleep(backoffDelayMs(i, 300, 3_000));
  }
  return null;
}

/** Inspect ambiguous signatures on-chain (never blindly resubmit). */
async function inspectAmbiguous(connection: Connection, sigs: string[]): Promise<void> {
  if (sigs.length === 0) return;
  const statuses = await connection
    .getSignatureStatuses(sigs, { searchTransactionHistory: false })
    .catch(() => null);
  console.log(
    JSON.stringify({
      ambiguous_signatures: sigs.map((s, i) => ({ sig: s, status: statuses?.value?.[i] ?? null })),
    }),
  );
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
  const rpcConfig = resolveRpcConfig(process.env);
  const keyPath = process.env.ARBSWAP_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")));
  const keeper = Keypair.fromSecretKey(secret);
  // S2-22: primary + optional fallback endpoints, cluster-guarded. Availability
  // only — the program remains the source of truth for quote validity.
  const pool = new RpcPool({ endpoints: rpcConfig.endpoints, cluster: rpcConfig.cluster });
  await pool.assertCluster();
  const connection = pool.connection;
  const wallet = new Wallet(keeper);
  const hermes = new HermesClient(process.env.HERMES_URL ?? "https://hermes.pyth.network", process.env.PYTH_API_KEY ? { accessToken: process.env.PYTH_API_KEY } : {});
  const receiver = new PythSolanaReceiver({ connection, wallet });
  const dryRun = process.env.DRY_RUN === "1";
  if (dryRun) console.error(`keeper DRY_RUN: no transactions will be sent (rpc=${rpcConfig.endpoints[0]})`);

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
  let failures = 0;
  for (let attempt = 1; attempt <= attempts && !(success && runSeconds === 0); attempt += 1) {
    if (runSeconds > 0 && Date.now() > deadline) break;
    const tCycle = Date.now();
    // 1. Fresh Hermes update (fetched immediately before staging/posting).
    const tH = Date.now();
    const updates = await hermes.getLatestPriceUpdates([`0x${FEED_ID}`], { encoding: "base64" });
    const hermesMs = Date.now() - tH;
    const parsed = updates.parsed?.[0]?.price;
    if (!parsed) throw new Error("hermes returned no parsed price");
    const publishTime = parsed.publish_time;
    const conf = confBps(String(parsed.conf), String(parsed.price));
    const slot = await connection.getSlot("processed");
    const q64 = priceQ64(String(parsed.price), parsed.expo);
    console.log(`attempt=${attempt} publish_time=${publishTime} age_ms=${Date.now() - publishTime * 1000} slot=${slot} price_q64=${q64} conf_bps=${conf}`);

    // S2-29: never spend a transaction on an update that is already too old to
    // realistically satisfy the deployed 2 s freshness check (fetch age + the
    // stage/VAA/push pipeline). Skip and refetch instead of failing on-chain.
    const fetchAgeMs = Date.now() - publishTime * 1000;
    const maxFetchAgeMs = Number(process.env.MAX_FETCH_AGE_MS ?? 1_000);
    if (fetchAgeMs > maxFetchAgeMs) {
      console.log(`attempt=${attempt} skip: update already ${fetchAgeMs}ms old (> ${maxFetchAgeMs}ms budget)`);
      continue;
    }

    // 2. Quote engine. Returns no quote (non-zero exit) when its own depth
    // throttle fails closed (e.g. confidence at the cap); skip and retry.
    let quote: any;
    const tE = Date.now();
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
    const engineMs = Date.now() - tE;
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
    const vaaSigners: any[] = [];
    for (const item of vaaItems) {
      vaaTx.add(item.instruction);
      vaaSigners.push(...(item.signers ?? []));
    }
    vaaTx.sign(keeper, ...vaaSigners);

    // S2-23: the push+commit tx is sent after stage/vaa confirm, so it gets its
    // own fresh blockhash to avoid a stale blockhash/lastValidBlockHeight.
    const { blockhash: pushBlockhash } = await connection.getLatestBlockhash("processed");
    const pushTx = new Transaction({ feePayer: keeper.publicKey, recentBlockhash: pushBlockhash });
    pushTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    pushTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
    pushTx.add(pushItems[0].instruction);
    pushTx.add(commitIx);
    pushTx.sign(keeper);
    console.log(`sizes stage=${stageTx.serialize().length} vaa=${vaaTx.serialize().length} push+commit=${pushTx.serialize().length}`);

    if (dryRun) {
      // S2-22: dry-run mode — build and size-check everything but never sign-send.
      console.log(JSON.stringify({ dry_run: true, attempt, publish_time: publishTime, conf_bps: conf, body_len: body.length, stage_ok: true, hermes_ms: hermesMs, engine_ms: engineMs, fetch_age_ms: fetchAgeMs, total_ms: Date.now() - tCycle }));
      continue;
    }

    const txTimes: Record<string, { sendMs: number; confirmMs: number }> = {};
    const send = async (tx: Transaction, _bh: string, label: string): Promise<string> => {
      const ts = Date.now();
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2, preflightCommitment: "processed" });
      const sendMs = Date.now() - ts;
      const tc = Date.now();
      // S2-29: confirm by fast bounded `getSignatureStatuses` polling rather than
      // `confirmTransaction` (which relies on the websocket and fell back to slow
      // polling, pushing the staged pipeline past the 2 s freshness window). A
      // program error is surfaced; a missing status is never treated as success.
      const deadline = Date.now() + 12_000;
      for (;;) {
        const status = await connection
          .getSignatureStatuses([sig], { searchTransactionHistory: false })
          .catch(() => null);
        const v = status?.value?.[0];
        if (v?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(v.err)}`);
        if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) {
          txTimes[label] = { sendMs, confirmMs: Date.now() - tc };
          return sig;
        }
        if (Date.now() > deadline) throw new Error(`tx ${sig} not confirmed within 12s`);
        await sleep(150);
      }
    };

    // S2-18: capture the version we are updating FROM, so success can require a
    // strict version increase (never `version > 0`, which the stale v18 already
    // satisfied and which previously masked every failed commit).
    const prevVersion =
      (await connection.getAccountInfo(QUOTE_STATE, "processed"))?.data.readBigUInt64LE(8) ?? 0n;

    let stageSig: string | null = null;
    let vaaSig: string | null = null;
    let pushSig: string | null = null;
    try {
      [stageSig, vaaSig] = await Promise.all([send(stageTx, blockhash, "stage"), send(vaaTx, blockhash, "vaa")]);
      console.log(`stage_sig=${stageSig}`);
      console.log(`vaa_sig=${vaaSig}`);
      pushSig = await send(pushTx, pushBlockhash, "push");
    } catch (e) {
      // Ambiguous submit/confirm: inspect whatever landed before doing anything
      // else, then back off. Never blindly resubmit the same transaction.
      await inspectAmbiguous(connection, [stageSig, vaaSig, pushSig].filter((s): s is string => !!s));
      failures += 1;
      console.error(`attempt=${attempt} submit/confirm failed:`, (e as Error).message);
      await sleep(backoffDelayMs(failures));
      continue;
    }

    const tx = await getTransactionWithRetry(connection, pushSig);
    const currentSlot = await connection
      .getSlot("processed")
      .then((s) => BigInt(s))
      .catch(() => null);
    const qs = await connection.getAccountInfo(QUOTE_STATE, "processed").catch(() => null);
    const newVersion = qs ? qs.data.readBigUInt64LE(8) : null;
    const expirySlot = qs ? qs.data.readBigUInt64LE(24) : null;
    const observation: CommitObservation = {
      signature: pushSig,
      txFound: tx != null,
      txErr: tx?.meta?.err ?? null,
      prevVersion,
      newVersion,
      currentSlot,
      expirySlot,
    };
    const { state, reason } = classifyCommit(observation);
    const txSlot = (tx as { slot?: number } | null)?.slot ?? "?";
    console.log(JSON.stringify({ push_commit_sig: pushSig, slot: txSlot, state, reason }));
    // S2-31 (Task B1): structured per-cycle timing line (side-effect free).
    const commitBlockTime = (tx as { blockTime?: number } | null)?.blockTime ?? null;
    console.log(JSON.stringify({
      cycle: attempt, hermes_ms: hermesMs, engine_ms: engineMs, fetch_age_ms: fetchAgeMs,
      stage: txTimes.stage ?? null, vaa: txTimes.vaa ?? null, push: txTimes.push ?? null,
      commit_slot: txSlot, commit_block_time: commitBlockTime,
      publish_time: publishTime,
      age_at_commit_ms: commitBlockTime != null ? commitBlockTime * 1000 - publishTime * 1000 : null,
      result: state, version_before: prevVersion.toString(), version_after: (newVersion ?? 0n).toString(),
    }));
    if (tx == null) {
      console.error("unobserved push/commit transaction:", pushSig);
    } else if (tx.meta?.err) {
      console.error("commit logs:", tx.meta.logMessages?.slice(-8).join(" | "));
    }
    if (isSuccess(state)) {
      success = true;
      failures = 0;
      console.log(
        JSON.stringify({
          ok: true,
          state,
          stage_sig: stageSig,
          vaa_sig: vaaSig,
          push_commit_sig: pushSig,
          version: (newVersion ?? 0n).toString(),
          update_slot: (qs?.data.readBigUInt64LE(16) ?? 0n).toString(),
        }),
      );
      if (process.env.SIMULATE_SWAP === "1") {
        await simulateSwap(connection, keeper, qs!.data);
      }
      if (runSeconds > 0) {
        await sleep(200);
      }
    } else {
      failures += 1;
      await sleep(backoffDelayMs(failures));
    }
  }
  if (!success) {
    console.error("no live quote landed");
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
