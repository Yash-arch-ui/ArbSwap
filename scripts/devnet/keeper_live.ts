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
import { resolveRpcConfig, redactUrl, RpcPool } from "./rpc";
import { broadcastTransaction, type RpcEndpoint } from "./broadcast";
import { reclaimStaleVaas } from "./keeper_reclaim";
import {
  buildCommitKeys,
  buildObserveIx,
  buildStageKeys,
  clampQuoteBody,
  decodeVolatilityState,
  volatilityAction,
  volatilityLimits,
  volatilityPda,
  type OnChainVolatility,
} from "./volatility";

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
// The vault-bound volatility PDA `[b"vol", vault]` (required by the upgraded
// program on stage/commit/observe). Derived, never hardcoded.
const VOLATILITY = volatilityPda(VAULT, PROGRAM);
// Config byte offsets (verified against the program's `Config` layout).
const CONFIG_MIN_SPREAD_OFFSET = 204;
const CONFIG_MAX_SPREAD_OFFSET = 208;

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
  attempts = 3,
): Promise<Awaited<ReturnType<Connection["getTransaction"]>>> {
  for (let i = 1; i <= attempts; i += 1) {
    const tx = await connection
      .getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
      .catch(() => null);
    if (tx) return tx;
    await sleep(backoffDelayMs(i, 200, 1_000));
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
  // S2-35: the same signed bytes are broadcast to every configured endpoint
  // concurrently; the first to land wins and duplicate submissions collapse to
  // the one signature. This removes a single-provider send bottleneck without
  // changing what is sent or relaxing any on-chain guard.
  const endpoints: RpcEndpoint[] = rpcConfig.endpoints.map((url) => ({
    url,
    connection: new Connection(url, "processed"),
  }));
  const broadcastBuckets = new Map();
  const wallet = new Wallet(keeper);
  const hermes = new HermesClient(process.env.HERMES_URL ?? "https://hermes.pyth.network", process.env.PYTH_API_KEY ? { accessToken: process.env.PYTH_API_KEY } : {});
  const receiver = new PythSolanaReceiver({ connection, wallet });
  const dryRun = process.env.DRY_RUN === "1";
  // S2-35: bounded, short backoff so a transient timing failure (freshness /
  // stage-age) is retried while the current Hermes update is still usable,
  // instead of waiting out a long exponential delay and missing the window.
  const backoffBase = Number(process.env.KEEPER_BACKOFF_BASE_MS ?? 200);
  const backoffCap = Number(process.env.KEEPER_BACKOFF_CAP_MS ?? 1_500);
  // S2-42: each Pyth push creates a Wormhole EncodedVaa account (~0.00237 SOL
  // rent) that a failed push leaves orphaned. Reclaim keeper-owned orphans once
  // they are older than a grace window exceeding the maximum transaction
  // lifetime, so an in-flight/ambiguous push can never race the close. The
  // priority fee is configurable (0 is devnet-viable).
  const priorityFeeMicroLamports = Number(process.env.KEEPER_PRIORITY_FEE_MICROLAMPORTS ?? 0);
  const vaaGraceMs = Number(process.env.VAA_GRACE_MS ?? 90_000);
  const vaaReclaimIntervalMs = Number(process.env.VAA_RECLAIM_INTERVAL_MS ?? 30_000);
  const vaaLedger = new Map<string, number>();
  const activeVaas = new Set<string>();
  let lastReclaimMs = 0;
  if (dryRun) console.error(`keeper DRY_RUN: no transactions will be sent (rpc=${redactUrl(rpcConfig.endpoints[0])})`);

  /** Broadcast a keeper-signed transaction with bounded poll rate (S2-42). */
  const broadcastKeeperTx = async (tx: Transaction) =>
    broadcastTransaction(
      endpoints,
      tx.serialize(),
      { pollIntervalMs: 250, timeoutMs: 12_000, rpcPerMinuteCap: 240, now: Date.now },
      broadcastBuckets,
    );
  // Reclaim dependencies: discovery is filtered by the keeper's write authority
  // (SDK), and `closeEncodedVaa` requires the keeper signer, which receives the
  // rent back. Never closes an `active` address or one younger than `vaaGraceMs`.
  const reclaimDeps = {
    findOwned: async () =>
      (await receiver.findOwnedEncodedVaaAccounts()).map((k: PublicKey) => k.toBase58()),
    closeAccounts: async (addresses: string[]): Promise<{ closed: string[]; failed: string[] }> => {
      const closed: string[] = [];
      const failed: string[] = [];
      const batchSize = Number(process.env.VAA_RECLAIM_BATCH ?? 8);
      for (let i = 0; i < addresses.length; i += batchSize) {
        const batch = addresses.slice(i, i + batchSize);
        try {
          const built = await Promise.all(
            batch.map((a) => receiver.buildCloseEncodedVaaInstruction(new PublicKey(a))),
          );
          const { blockhash: bh } = await connection.getLatestBlockhash("processed");
          const tx = new Transaction({ feePayer: keeper.publicKey, recentBlockhash: bh });
          tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 + batch.length * 40_000 }));
          if (priorityFeeMicroLamports > 0) {
            tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));
          }
          for (const b of built) tx.add(b.instruction);
          tx.sign(keeper, ...built.flatMap((b: any) => b.signers ?? []));
          await broadcastKeeperTx(tx);
          closed.push(...batch);
        } catch (e) {
          failed.push(...batch);
          console.log(`reclaim batch failed: ${(e as Error).message}`);
        }
      }
      return { closed, failed };
    },
    firstSeenMs: vaaLedger,
    active: activeVaas,
    nowMs: () => Date.now(),
    graceMs: vaaGraceMs,
    maxPerPass: Number(process.env.VAA_RECLAIM_MAX_PER_PASS ?? 40),
    log: (m: string) => console.log(m),
  };

  const feed = Buffer.from(FEED_ID, "hex");
  const priceUpdate = getPriceFeedAccountForProgram(0, feed);
  const [pending] = PublicKey.findProgramAddressSync(
    [Buffer.from("pending_quote"), VAULT.toBuffer(), keeper.publicKey.toBuffer()],
    PROGRAM,
  );
  const baseDec = 9;
  const quoteDec = 6;
  console.log("feed_account", priceUpdate.toBase58(), "pending_quote", pending.toBase58(), "volatility", VOLATILITY.toBase58());

  /** Read the vault-bound volatility PDA (owner-checked). */
  const readVolatility = async (): Promise<{ exists: boolean; state: OnChainVolatility | null }> => {
    const info = await connection.getAccountInfo(VOLATILITY, "processed").catch(() => null);
    if (!info) return { exists: false, state: null };
    if (!info.owner.equals(PROGRAM)) return { exists: true, state: null };
    return { exists: true, state: decodeVolatilityState(info.data) };
  };

  /**
   * Submit `observe_volatility` in its OWN transaction (its own Pyth push), so a
   * later quote rejection can never roll back a valid observation. Returns true
   * only after the on-chain state is re-read and verified to be a usable
   * baseline at or after `expectedPublishTime`. Never initializes the PDA.
   */
  const observeVolatility = async (binaryData: string[], expectedPublishTime: number): Promise<boolean> => {
    try {
      const built = await receiver.buildUpdatePriceFeedInstructions(binaryData, 0);
      const vaaItems = built.postInstructions.filter((p: any) => p.instruction.programId.toBase58() !== PUSH_ORACLE);
      const pushItems = built.postInstructions.filter((p: any) => p.instruction.programId.toBase58() === PUSH_ORACLE);
      if (pushItems.length !== 1) throw new Error(`observe: expected 1 push instruction, got ${pushItems.length}`);
      const { blockhash } = await connection.getLatestBlockhash("processed");
      const vaaTx = new Transaction({ feePayer: keeper.publicKey, recentBlockhash: blockhash });
      vaaTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      if (priorityFeeMicroLamports > 0) vaaTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));
      const vaaSigners: any[] = [];
      for (const item of vaaItems) {
        vaaTx.add(item.instruction);
        vaaSigners.push(...(item.signers ?? []));
      }
      vaaTx.sign(keeper, ...vaaSigners);
      const observeTx = new Transaction({ feePayer: keeper.publicKey, recentBlockhash: blockhash });
      observeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      if (priorityFeeMicroLamports > 0) observeTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));
      observeTx.add(pushItems[0].instruction);
      observeTx.add(buildObserveIx({
        programId: PROGRAM, observer: keeper.publicKey, vault: VAULT, config: CONFIG,
        volatilityState: VOLATILITY, priceUpdate, baseMint: WSOL, quoteMint: USDC,
      }));
      observeTx.sign(keeper);
      if (dryRun) {
        console.log(JSON.stringify({ dry_run_observe: true, vaa_size: vaaTx.serialize().length, observe_size: observeTx.serialize().length }));
        return false;
      }
      await broadcastKeeperTx(vaaTx);
      const res = await broadcastKeeperTx(observeTx);
      // The account — not the log — is authoritative.
      const after = await readVolatility();
      const s = after.state;
      const ok = !!s && s.lastPriceQ64 > 0n && s.lastPublishTime >= BigInt(expectedPublishTime);
      console.log(JSON.stringify({
        observe_sig: res.signature, observed: ok,
        nonce: s?.observationNonce?.toString() ?? null,
        last_publish_time: s?.lastPublishTime?.toString() ?? null,
      }));
      return ok;
    } catch (e) {
      console.error(`observe failed: ${(e as Error).message}`);
      return false;
    }
  };

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
    // S2-42: at the start of each cycle (no tx of this cycle exists yet), reclaim
    // keeper-owned encoded-VAA accounts left orphaned by earlier failed pushes.
    // Rate-limited and best-effort so it can never affect the quote pipeline.
    activeVaas.clear();
    if (!dryRun && Date.now() - lastReclaimMs >= vaaReclaimIntervalMs) {
      lastReclaimMs = Date.now();
      try {
        const rr = await reclaimStaleVaas(reclaimDeps);
        if (rr.closed || rr.failed) {
          console.log(JSON.stringify({ reclaim: { ...rr, rent_recovered_sol: rr.rentRecoveredLamports / 1e9 } }));
        }
      } catch (e) {
        console.error(`reclaim pass failed: ${(e as Error).message}`);
      }
    }
    const tCycle = Date.now();
    try {
    // 1. Fetch the fresh Hermes update, the current slot and a blockhash
    // concurrently (S2-35). None of these round trips needs the others, so
    // serialising them would spend latency inside the deployed 2 s oracle
    // freshness window. The blockhash is valid for ~150 slots; the pipeline
    // lands in a handful.
    const tH = Date.now();
    // S2-37: guard the fetch/read leg. A transient RPC timeout (not an on-chain
    // rejection) must back off and retry, not crash the whole keeper — otherwise
    // the quote stops advancing and the frontend correctly shows it as expired.
    let updates: Awaited<ReturnType<typeof hermes.getLatestPriceUpdates>>;
    let slot: number;
    let blockhash: string;
    try {
      const [u, s, bh] = await Promise.all([
        hermes.getLatestPriceUpdates([`0x${FEED_ID}`], { encoding: "base64" }),
        connection.getSlot("processed"),
        connection.getLatestBlockhash("processed"),
      ]);
      updates = u; slot = s; blockhash = bh.blockhash;
    } catch (e) {
      failures += 1;
      console.error(`attempt=${attempt} fetch/read failed: ${(e as Error).message}; backing off`);
      await sleep(backoffDelayMs(failures, backoffBase, backoffCap));
      continue;
    }
    const hermesMs = Date.now() - tH;
    const parsed = updates.parsed?.[0]?.price;
    if (!parsed) throw new Error("hermes returned no parsed price");
    const publishTime = parsed.publish_time;
    const conf = confBps(String(parsed.conf), String(parsed.price));
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

    // 1b. Volatility gate. The upgraded program requires the vault-bound
    // volatility PDA on stage/commit/observe. If it is absent, stop quote
    // maintenance cleanly — never fall back to legacy layouts or treat
    // volatility as zero. When a baseline is missing or the observation is
    // stale, submit a permissionless observation first, in its own transaction.
    const volRead = await readVolatility();
    const volAction = volatilityAction(volRead.state, BigInt(slot));
    if (volAction === "blocked-absent") {
      failures += 1;
      console.error(
        `attempt=${attempt} VolatilityStateNotInitialized: PDA ${VOLATILITY.toBase58()} absent; ` +
          `quote maintenance stopped (initialize_volatility required)`,
      );
      await sleep(backoffDelayMs(failures, backoffBase, backoffCap));
      continue;
    }
    let volState = volRead.state!;
    if (volAction !== "quote") {
      const observed = await observeVolatility(updates.binary.data, publishTime);
      if (observed) {
        volState = (await readVolatility()).state ?? volState;
      } else if (volState.enabled && !dryRun) {
        // Enforcement is active but the observation could not be established:
        // fail closed rather than quote on an unusable state.
        failures += 1;
        console.error(`attempt=${attempt} observation not established while enforcement is enabled; skipping quote (fail closed)`);
        await sleep(backoffDelayMs(failures, backoffBase, backoffCap));
        continue;
      }
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
    let body = Buffer.from(quote.body_hex, "hex");
    if (body.length !== 692) throw new Error(`unexpected quote body length ${body.length}`);
    const oraclePublishTime = BigInt(quote.oracle_publish_time);
    if (oraclePublishTime !== BigInt(publishTime)) throw new Error("quote publish_time mismatch");

    // 2b. Respect the on-chain volatility limits while the guard is active.
    // The local math only anticipates a rejection; the program stays the
    // authority. A quote that cannot satisfy the guard is skipped, never loosened.
    if (volState.enabled) {
      const cfg = (await connection.getAccountInfo(CONFIG, "processed"))!.data;
      const minSpread = BigInt(cfg.readUInt32LE(CONFIG_MIN_SPREAD_OFFSET));
      const maxSpread = BigInt(cfg.readUInt32LE(CONFIG_MAX_SPREAD_OFFSET));
      const lim = volatilityLimits(volState, BigInt(slot), minSpread);
      if (lim.overCeiling) {
        failures += 1;
        console.error(`attempt=${attempt} volatility kill-switch: sigma above ceiling; skipping quote`);
        await sleep(backoffDelayMs(failures, backoffBase, backoffCap));
        continue;
      }
      if (lim.floorBps > maxSpread) {
        failures += 1;
        console.error(`attempt=${attempt} volatility floor ${lim.floorBps}bps exceeds max spread ${maxSpread}bps; risk-blocked`);
        await sleep(backoffDelayMs(failures, backoffBase, backoffCap));
        continue;
      }
      body = clampQuoteBody(body, lim.floorBps, lim.capBps);
      console.log(`attempt=${attempt} volatility enabled: floor_bps=${lim.floorBps} cap_bps=${lim.capBps} nonce=${volState.observationNonce}`);
    }

    const nonce = BigInt(Date.now());
    const stageData = Buffer.concat([disc("stage_quote"), body, u64le(nonce)]);
    const commitData = Buffer.concat([disc("commit_quote"), u64le(nonce)]);

    // 3. stage + VAA + push/commit transaction pieces.
    const stageIx = new TransactionInstruction({
      programId: PROGRAM,
      data: stageData,
      // The volatility PDA is required immediately before `system_program`.
      keys: buildStageKeys({
        programId: PROGRAM, keeper: keeper.publicKey, vault: VAULT, config: CONFIG,
        quoteState: QUOTE_STATE, pendingQuote: pending, baseReserve: BASE_RESERVE,
        quoteReserve: QUOTE_RESERVE, keeperBond: KEEPER_BOND, volatilityState: VOLATILITY,
        systemProgram: SYSTEM,
      }),
    });
    const commitIx = new TransactionInstruction({
      programId: PROGRAM,
      data: commitData,
      // The volatility PDA is the last of the 12 `commit_quote` accounts. The
      // Pyth receiver (CPI'd by the push oracle) verifies against the Wormhole
      // program, which must be present in the transaction's account list; it is
      // an extra trailing account Anchor ignores, kept after the PDA.
      keys: buildCommitKeys({
        programId: PROGRAM, keeper: keeper.publicKey, vault: VAULT, config: CONFIG,
        quoteState: QUOTE_STATE, pendingQuote: pending, priceUpdate, baseReserve: BASE_RESERVE,
        quoteReserve: QUOTE_RESERVE, keeperBond: KEEPER_BOND, baseMint: WSOL, quoteMint: USDC,
        volatilityState: VOLATILITY, extraTrailing: [new PublicKey(WORMHOLE)],
      }),
    });

    const { postInstructions, closeInstructions } = await receiver.buildUpdatePriceFeedInstructions(updates.binary.data, 0);
    // S2-42: record the encoded-VAA accounts this cycle creates so reclamation
    // will not close them until they age past the in-flight grace window.
    for (const c of (closeInstructions ?? []) as any[]) {
      const addr = c?.instruction?.keys?.[0]?.pubkey?.toBase58?.();
      if (typeof addr === "string") { vaaLedger.set(addr, Date.now()); activeVaas.add(addr); }
    }
    // Everything except the push is the VAA pipeline: the system `create` (which
    // funds/owns the encoded-VAA account), then init/write/verify on Wormhole.
    const vaaItems = postInstructions.filter((p: any) => p.instruction.programId.toBase58() !== PUSH_ORACLE);
    const pushItems = postInstructions.filter((p: any) => p.instruction.programId.toBase58() === PUSH_ORACLE);
    if (pushItems.length !== 1) throw new Error(`expected 1 push instruction, got ${pushItems.length}`);

    // S2-35: one blockhash for the whole pipeline (fetched concurrently with
    // the Hermes update above). A blockhash is valid for ~150 slots while the
    // pipeline lands in a handful, so re-fetching before the push only injects
    // an extra RPC round trip inside the deployed 2 s oracle-freshness window.
    // The program — not the blockhash — is the safety gate, so this removes
    // latency without weakening any check.
    const stageTx = new Transaction({ feePayer: keeper.publicKey, recentBlockhash: blockhash });
    stageTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    if (priorityFeeMicroLamports > 0) stageTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));
    stageTx.add(stageIx);
    stageTx.sign(keeper);

    const vaaTx = new Transaction({ feePayer: keeper.publicKey, recentBlockhash: blockhash });
    vaaTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    if (priorityFeeMicroLamports > 0) vaaTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));
    const vaaSigners: any[] = [];
    for (const item of vaaItems) {
      vaaTx.add(item.instruction);
      vaaSigners.push(...(item.signers ?? []));
    }
    vaaTx.sign(keeper, ...vaaSigners);

    const pushTx = new Transaction({ feePayer: keeper.publicKey, recentBlockhash: blockhash });
    pushTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    if (priorityFeeMicroLamports > 0) pushTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));
    pushTx.add(pushItems[0].instruction);
    pushTx.add(commitIx);
    pushTx.sign(keeper);
    console.log(`sizes stage=${stageTx.serialize().length} vaa=${vaaTx.serialize().length} push+commit=${pushTx.serialize().length}`);

    if (dryRun) {
      // S2-22: dry-run mode — build and size-check everything but never sign-send.
      console.log(JSON.stringify({ dry_run: true, attempt, publish_time: publishTime, conf_bps: conf, body_len: body.length, stage_ok: true, hermes_ms: hermesMs, engine_ms: engineMs, fetch_age_ms: fetchAgeMs, total_ms: Date.now() - tCycle }));
      continue;
    }

    const txTimes: Record<string, { sendMs: number; confirmMs: number; endpoint?: string }> = {};
    // S2-35: broadcast the same signed bytes to every configured endpoint
    // concurrently; the first to land wins and duplicate submissions collapse
    // to one signature. `processed` ordering is enough for the staging legs (the
    // push must simply be scheduled after them); the push+commit leg is
    // additionally re-verified at `confirmed` via `getTransaction` below before
    // any success is reported. A program error is surfaced; a missing status is
    // never treated as success.
    const send = async (tx: Transaction, label: string): Promise<string> => {
      const res = await broadcastTransaction(
        endpoints,
        tx.serialize(),
        // S2-42: bound status-poll RPC. A 50 ms poll across two shared free-tier
        // endpoints self-inflicted 429 storms that delayed confirmation past the
        // 2 s oracle window (InvalidOracle 6015 / StalePendingQuote 6039). The
        // cap is per endpoint and shared with sends; confirmation still resolves
        // on the first landed status.
        { pollIntervalMs: 250, timeoutMs: 12_000, rpcPerMinuteCap: 240, now: Date.now },
        broadcastBuckets,
      );
      txTimes[label] = {
        sendMs: Math.round(res.sendMs),
        confirmMs: Math.round(res.confirmMs),
        endpoint: res.endpoint,
      };
      return res.signature;
    };

    // S2-18: capture the version we are updating FROM, so success can require a
    // strict version increase (never `version > 0`, which the stale v18 already
    // satisfied and which previously masked every failed commit).
    const prevVersion = await connection
      .getAccountInfo(QUOTE_STATE, "processed")
      .then((a) => a?.data.readBigUInt64LE(8) ?? 0n)
      .catch(() => null);
    if (prevVersion === null) {
      failures += 1;
      console.error(`attempt=${attempt} read QuoteState failed; backing off`);
      await sleep(backoffDelayMs(failures, backoffBase, backoffCap));
      continue;
    }

    let stageSig: string | null = null;
    let vaaSig: string | null = null;
    let pushSig: string | null = null;
    try {
      [stageSig, vaaSig] = await Promise.all([send(stageTx, "stage"), send(vaaTx, "vaa")]);
      console.log(`stage_sig=${stageSig} stage_ms=${JSON.stringify(txTimes.stage)}`);
      console.log(`vaa_sig=${vaaSig} vaa_ms=${JSON.stringify(txTimes.vaa)}`);
      pushSig = await send(pushTx, "push");
    } catch (e) {
      // Ambiguous submit/confirm: inspect whatever landed before doing anything
      // else, then back off. Never blindly resubmit the same transaction.
      await inspectAmbiguous(connection, [stageSig, vaaSig, pushSig].filter((s): s is string => !!s));
      failures += 1;
      console.error(`attempt=${attempt} submit/confirm failed:`, (e as Error).message);
      await sleep(backoffDelayMs(failures, backoffBase, backoffCap));
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
      await sleep(backoffDelayMs(failures, backoffBase, backoffCap));
    }
    } catch (e) {
      // S2-39: catch-all so a transient RPC/Pyth-SDK error (e.g. a Helius
      // connect timeout) backs off and retries instead of crashing the process
      // and stopping quote commits.
      failures += 1;
      console.error(`attempt=${attempt} unhandled error: ${(e as Error).message}; backing off`);
      await sleep(backoffDelayMs(failures, backoffBase, backoffCap));
      continue;
    }
  }
  if (!success) {
    console.error("no live quote landed");
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
