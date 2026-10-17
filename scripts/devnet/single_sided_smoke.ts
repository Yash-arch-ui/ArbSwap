// Task 6.5 (a)/(e) / Issue B: single-sided devnet smoke — SIMULATE THEN SUBMIT.
//
// Proves the deployed `deposit_single` / `claim_withdraw_single` money path with
// the authorized admin wallet `8R3V…` on Devnet test tokens:
//   deposit : `deposit_single(SellBase)` — one token in; verify the input-only
//             token movement, the reserve delta, the minted shares and the
//             deposit ticket, and that the ladder conversion is positive.
//   settle  : wait warm-up -> `request_withdraw` -> wait epoch -> `crank_epoch`
//             -> `claim_withdraw_single(BuyBase)` — verify the base-only payout,
//             the untouched quote ATA, the burned shares and the zeroed ticket.
//
// Manual Borsh encoding (no IDL coder). Never prints the RPC URL or key material.
// A live quote must be available (a keeper must be running) because both single
// instructions read `quote_state` and enforce `slot < expiry_slot`.
//
//   npx tsx single_sided_smoke.ts deposit
//   npx tsx single_sided_smoke.ts settle
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import fs from "fs";
import { resolveRpcConfig, redactUrl } from "./rpc";

const PROGRAM = new PublicKey("2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm");
const VAULT = new PublicKey("8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt");
const CONFIG = new PublicKey("ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT");
const QUOTE_STATE = new PublicKey("5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const STATE_FILE = "/tmp/opencode/single_sided_smoke_state.json";

// Borsh enum order from the IDL: BuyBase = 0, SellBase = 1.
const BUY_BASE = 0;
const SELL_BASE = 1;
// `SMOKE_SIDE=base` (default): deposit WSOL (SellBase) and claim WSOL (BuyBase).
// `SMOKE_SIDE=quote`: deposit USDC (BuyBase) and claim USDC (SellBase).
const SMOKE_SIDE = (process.env.SMOKE_SIDE ?? "base").toLowerCase();
const SIDE_IN = SMOKE_SIDE === "quote" ? BUY_BASE : SELL_BASE;
const SIDE_OUT = SIDE_IN === SELL_BASE ? BUY_BASE : SELL_BASE;
const DEPOSIT_AMOUNT = SIDE_IN === SELL_BASE ? 1_000_000n : 100_000n;

const disc = (name: string): Buffer =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (d: Buffer, o: number): bigint => d.readBigUInt64LE(o);
const pk = (d: Buffer, o: number): PublicKey => new PublicKey(d.subarray(o, o + 32));

function loadAdmin(): Keypair {
  const path = process.env.ARBSWAP_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}
function ata(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0];
}
const pda = (seed: string, a: PublicKey, b?: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(
    b ? [Buffer.from(seed), a.toBuffer(), b.toBuffer()] : [Buffer.from(seed), a.toBuffer()],
    PROGRAM,
  )[0];

async function tokenAmount(c: Connection, a: PublicKey): Promise<bigint> {
  const info = await c.getAccountInfo(a, "confirmed");
  if (!info) return -1n;
  return u64(info.data, 64);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface VaultState {
  baseMint: PublicKey; quoteMint: PublicKey;
  baseReserve: PublicKey; quoteReserve: PublicKey;
  shareMint: PublicKey; shareLock: PublicKey;
  totalShares: bigint;
  insuranceBase: bigint; insuranceQuote: bigint;
  keeperBase: bigint; keeperQuote: bigint;
  protocolBase: bigint; protocolQuote: bigint;
  epoch: bigint; epochStart: bigint;
}
async function readVault(c: Connection): Promise<VaultState> {
  const d = (await c.getAccountInfo(VAULT, "confirmed"))!.data;
  return {
    baseMint: pk(d, 40), quoteMint: pk(d, 72),
    baseReserve: pk(d, 104), quoteReserve: pk(d, 136),
    shareMint: pk(d, 168), shareLock: pk(d, 200),
    totalShares: u64(d, 232),
    insuranceBase: u64(d, 240), insuranceQuote: u64(d, 248),
    keeperBase: u64(d, 256), keeperQuote: u64(d, 264),
    protocolBase: u64(d, 272), protocolQuote: u64(d, 280),
    epoch: u64(d, 288), epochStart: u64(d, 296),
  };
}
async function readConfig(c: Connection): Promise<{ warmupSlots: bigint; epochSlots: bigint }> {
  const d = (await c.getAccountInfo(CONFIG, "confirmed"))!.data;
  return { warmupSlots: u64(d, 152), epochSlots: u64(d, 160) };
}
async function readQuote(c: Connection): Promise<{ version: bigint; expirySlot: bigint; keeper: PublicKey }> {
  const d = (await c.getAccountInfo(QUOTE_STATE, "confirmed"))!.data;
  return { version: u64(d, 8), expirySlot: u64(d, 24), keeper: pk(d, 845) };
}
const quotedKeeperReward = (keeper: PublicKey): PublicKey => pda("reward", VAULT, keeper);

function meta(pubkey: PublicKey, isSigner = false, isWritable = false) {
  return { pubkey, isSigner, isWritable };
}
function ix(name: string, keys: ReturnType<typeof meta>[], data: Buffer): TransactionInstruction {
  return new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.concat([disc(name), data]) });
}

async function simulateThenSend(c: Connection, admin: Keypair, ixs: TransactionInstruction[], label: string) {
  // The single-sided instructions walk the committed ladder and exceed the
  // default 200k simulation budget; request a bounded explicit limit.
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ...ixs,
  );
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(admin);
  const sim = await c.simulateTransaction(tx);
  if (sim.value.err) {
    console.error(`[${label}] simulation FAILED:`, JSON.stringify(sim.value.err));
    console.error((sim.value.logs ?? []).slice(-12).join("\n"));
    throw new Error(`${label} simulation failed`);
  }
  const sig = await sendAndConfirmTransaction(c, tx, [admin], { commitment: "confirmed", skipPreflight: false });
  console.log(`[${label}] sig=${sig}`);
  return sig;
}

async function ensureAta(c: Connection, admin: Keypair, mint: PublicKey): Promise<PublicKey> {
  const a = ata(mint, admin.publicKey);
  if (await c.getAccountInfo(a, "confirmed")) return a;
  const create = new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      meta(admin.publicKey, true, true), meta(a, false, true), meta(admin.publicKey),
      meta(mint), meta(SystemProgram.programId), meta(TOKEN_PROGRAM),
    ],
    data: Buffer.alloc(0),
  });
  await simulateThenSend(c, admin, [create], `ata-${mint.toBase58().slice(0, 4)}`);
  return a;
}

/** Wait until the on-chain quote is fresh (used only for the claim leg). */
async function waitForFreshQuote(c: Connection, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const q = await readQuote(c);
    const slot = BigInt(await c.getSlot("confirmed"));
    if (q.version > 0n && slot < q.expirySlot) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for a fresh quote (is a keeper running?)");
    await sleep(2000);
  }
}

async function main() {
  const phase = process.argv[2] ?? "deposit";
  const cfg = resolveRpcConfig(process.env);
  const c = new Connection(cfg.endpoints[0], "confirmed");
  const admin = loadAdmin();
  const v = await readVault(c);
  const conf = await readConfig(c);
  const q = await readQuote(c);
  console.error(`rpc=${redactUrl(cfg.endpoints[0])} admin=${admin.publicKey.toBase58()} epoch=${v.epoch} warmup=${conf.warmupSlots} epochSlots=${conf.epochSlots}`);

  const userBase = await ensureAta(c, admin, v.baseMint);
  const userQuote = await ensureAta(c, admin, v.quoteMint);
  const userShares = await ensureAta(c, admin, v.shareMint);
  const depTicket = pda("dep", VAULT, admin.publicKey);
  const wdTicket = pda("wd", VAULT, admin.publicKey);
  const keeperReward = quotedKeeperReward(q.keeper);

  if (phase === "deposit") {
    await waitForFreshQuote(c, 120_000);
    const baseReserveBefore = await tokenAmount(c, v.baseReserve);
    const quoteReserveBefore = await tokenAmount(c, v.quoteReserve);
    const userBaseBefore = await tokenAmount(c, userBase);
    const userQuoteBefore = await tokenAmount(c, userQuote);
    const sharesBefore = await tokenAmount(c, userShares);
    const totalBefore = v.totalShares;

    const d = Buffer.alloc(1 + 8 + 8 + 8);
    d.writeUInt8(SIDE_IN, 0);
    d.writeBigUInt64LE(DEPOSIT_AMOUNT, 1);
    d.writeBigUInt64LE(1n, 9); // min_shares
    d.writeBigUInt64LE(0n, 17); // min_swap_out
    const depositIx = ix("deposit_single", [
      meta(admin.publicKey, true, true), meta(VAULT, false, true), meta(CONFIG), meta(QUOTE_STATE, false, true),
      meta(v.baseReserve, false, true), meta(v.quoteReserve, false, true),
      meta(v.shareMint, false, true), meta(v.shareLock, false, true),
      meta(userBase, false, true), meta(userQuote, false, true), meta(userShares, false, true),
      meta(depTicket, false, true), meta(keeperReward, false, true),
      meta(TOKEN_PROGRAM), meta(SystemProgram.programId),
    ], d);

    const sig = await simulateThenSend(c, admin, [depositIx], "deposit_single");
    const slot = await c.getSlot("confirmed");
    const userBaseAfter = await tokenAmount(c, userBase);
    const userQuoteAfter = await tokenAmount(c, userQuote);
    const sharesAfter = await tokenAmount(c, userShares);
    const v2 = await readVault(c);
    const baseReserveAfter = await tokenAmount(c, v2.baseReserve);
    const quoteReserveAfter = await tokenAmount(c, v2.quoteReserve);
    const ticket = await c.getAccountInfo(depTicket, "confirmed");
    const ticketShares = ticket ? u64(ticket.data, 40) : -1n;
    const minted = sharesAfter - sharesBefore;
    const inputIsBase = SIDE_IN === SELL_BASE;
    const userInputDelta = inputIsBase ? userBaseBefore - userBaseAfter : userQuoteBefore - userQuoteAfter;
    const userOtherDelta = inputIsBase ? userQuoteBefore - userQuoteAfter : userBaseBefore - userBaseAfter;
    const reserveInputDelta = inputIsBase ? baseReserveAfter - baseReserveBefore : quoteReserveAfter - quoteReserveBefore;
    const reserveOtherDelta = inputIsBase ? quoteReserveAfter - quoteReserveBefore : baseReserveAfter - baseReserveBefore;
    const report = {
      phase: "deposit_single", side: inputIsBase ? "SellBase" : "BuyBase", sideEnum: SIDE_IN,
      inputToken: inputIsBase ? "base(WSOL)" : "quote(USDC)",
      sig, slot,
      input: { atoms: DEPOSIT_AMOUNT.toString() },
      deltas: {
        userBase: (userBaseBefore - userBaseAfter).toString(),
        userQuote: (userQuoteBefore - userQuoteAfter).toString(),
        baseReserve: (baseReserveAfter - baseReserveBefore).toString(),
        quoteReserve: (quoteReserveAfter - quoteReserveBefore).toString(),
        sharesMinted: minted.toString(),
      },
      ticketShares: ticketShares.toString(),
      totalShares: { before: totalBefore.toString(), after: v2.totalShares.toString() },
      checks: {
        pullsOnlyInput: userInputDelta === DEPOSIT_AMOUNT,
        otherAtaUntouched: userOtherDelta === 0n,
        wholeInputToReserve: reserveInputDelta === DEPOSIT_AMOUNT,
        otherReserveUntouched: reserveOtherDelta === 0n,
        mintedSharesPositive: minted > 0n,
        ticketMatchesMinted: ticketShares === minted,
        totalSharesConsistent: v2.totalShares - totalBefore === minted,
      },
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify({ depositSig: sig, minted: minted.toString(), slot }, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (Object.values(report.checks).some((ok) => !ok)) process.exit(3);
    return;
  }

  if (phase === "settle") {
    const dep = await c.getAccountInfo(depTicket, "confirmed");
    if (!dep) throw new Error("no deposit ticket — run `deposit` first");
    const activateSlot = u64(dep.data, 48);
    let slot = BigInt(await c.getSlot("confirmed"));
    while (slot < activateSlot) {
      console.error(`warm-up: slot ${slot} < activate ${activateSlot}`);
      await sleep(8000);
      slot = BigInt(await c.getSlot("confirmed"));
    }
    const shares = u64(dep.data, 40);

    const reqSig = await simulateThenSend(c, admin, [ix("request_withdraw", [
      meta(admin.publicKey, true, true), meta(VAULT, false, true), meta(v.shareLock, false, true),
      meta(depTicket), meta(userShares, false, true), meta(wdTicket, false, true),
      meta(TOKEN_PROGRAM), meta(SystemProgram.programId),
    ], (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(shares, 0); return b; })())], "request_withdraw");

    let vs = await readVault(c);
    const target = vs.epochStart + conf.epochSlots;
    slot = BigInt(await c.getSlot("confirmed"));
    while (slot < target) {
      console.error(`epoch wait: slot ${slot} < ${target} (ticketEpoch=${vs.epoch + 1n})`);
      await sleep(15000);
      slot = BigInt(await c.getSlot("confirmed"));
    }
    const crankSig = await simulateThenSend(c, admin, [ix("crank_epoch", [
      meta(VAULT, false, true), meta(CONFIG),
    ], Buffer.alloc(0))], "crank_epoch");

    // Claim the one-token payout. Retry across freshness windows.
    let claimSig = "";
    let lastErr = "";
    for (let attempt = 0; attempt < 20 && !claimSig; attempt += 1) {
      try {
        await waitForFreshQuote(c, 60_000);
        const vc = await readVault(c);
        const fresh = await readQuote(c);
        const reward = quotedKeeperReward(fresh.keeper);
        const d = Buffer.alloc(1 + 8);
        d.writeUInt8(SIDE_OUT, 0);
        d.writeBigUInt64LE(1n, 1); // min_out
        const baseBefore = await tokenAmount(c, userBase);
        const quoteBefore = await tokenAmount(c, userQuote);
        const lockBefore = await tokenAmount(c, vc.shareLock);
        const totalBefore = vc.totalShares;
        const claimIx = ix("claim_withdraw_single", [
          meta(admin.publicKey, true, true), meta(VAULT, false, true), meta(CONFIG), meta(QUOTE_STATE, false, true),
          meta(vc.baseReserve, false, true), meta(vc.quoteReserve, false, true),
          meta(vc.shareMint, false, true), meta(vc.shareLock, false, true),
          meta(wdTicket, false, true), meta(userBase, false, true), meta(userQuote, false, true),
          meta(reward, false, true), meta(TOKEN_PROGRAM), meta(SystemProgram.programId),
        ], d);
        claimSig = await simulateThenSend(c, admin, [claimIx], "claim_withdraw_single");
        const baseAfter = await tokenAmount(c, userBase);
        const quoteAfter = await tokenAmount(c, userQuote);
        const lockAfter = await tokenAmount(c, vc.shareLock);
        const vAfter = await readVault(c);
        const ticketAfter = await c.getAccountInfo(wdTicket, "confirmed");
        const ticketShares = ticketAfter ? u64(ticketAfter.data, 40) : -1n;
        const outIsBase = SIDE_OUT === BUY_BASE;
        const payout = outIsBase ? baseAfter - baseBefore : quoteAfter - quoteBefore;
        const otherDelta = outIsBase ? quoteAfter - quoteBefore : baseAfter - baseBefore;
        const burned = lockBefore - lockAfter;
        const report = {
          phase: "claim_withdraw_single", side: outIsBase ? "BuyBase" : "SellBase", sideEnum: SIDE_OUT,
          outputToken: outIsBase ? "base(WSOL)" : "quote(USDC)",
          requestSig: reqSig, crankSig, claimSig,
          ticketShares: shares.toString(),
          payout: { baseAtoms: (baseAfter - baseBefore).toString(), quoteAtoms: (quoteAfter - quoteBefore).toString() },
          sharesBurnedFromLock: burned.toString(),
          totalShares: { before: totalBefore.toString(), after: vAfter.totalShares.toString() },
          ticketSharesAfter: ticketShares.toString(),
          checks: {
            payoutPositive: payout > 0n,
            otherAtaUntouched: otherDelta === 0n,
            sharesBurnedMatchesTicket: burned === shares,
            totalSharesConsistent: totalBefore - vAfter.totalShares === shares,
            ticketZeroed: ticketShares === 0n,
          },
        };
        console.log(JSON.stringify(report, null, 2));
        if (Object.values(report.checks).some((ok) => !ok)) process.exit(3);
      } catch (e) {
        lastErr = (e as Error).message ?? String(e);
        console.error(`claim attempt ${attempt + 1} failed: ${lastErr}`);
        await sleep(4000);
      }
    }
    if (!claimSig) throw new Error(`claim_withdraw_single did not land: ${lastErr}`);
    return;
  }

  throw new Error(`unknown phase ${phase}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
