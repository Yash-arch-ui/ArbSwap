// Task 6.5 (b)-(d): two-sided devnet lifecycle smoke — SIMULATE THEN SUBMIT.
//
// Proves the post-upgrade program still runs the full two-sided money path with
// the admin wallet `8R3V…`:
//   (b) proportional `deposit`
//   (c) wait warm-up -> `request_withdraw` -> wait epoch -> `crank_epoch` ->
//       `claim_withdraw`, verifying exact token deltas vs the claim event and the
//       pro-rata formula, reserves >= liabilities, and share consistency.
//   (d) `claim_withdraw` while the quote is expired (the instruction reads no
//       quote account; we still catch or simulate an expired window).
//
// Manual Borsh encoding so it does not depend on an IDL coder. Never prints the
// RPC URL. Single-token steps (a)/(e) are NOT run (no single-sided CLI yet).
//
//   npx tsx two_sided_lifecycle.ts deposit
//   npx tsx two_sided_lifecycle.ts settle
//   npx tsx two_sided_lifecycle.ts expired
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
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
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const STATE_FILE = "/tmp/opencode/single_sided_6_5_state.json";

const disc = (name: string): Buffer =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const evDisc = (name: string): Buffer =>
  createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);

const u64 = (d: Buffer, o: number): bigint => d.readBigUInt64LE(o);
const pk = (d: Buffer, o: number): PublicKey => new PublicKey(d.subarray(o, o + 32));

function loadAdmin(): Keypair {
  const path = process.env.ARBSWAP_DEVNET_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

function ata(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0];
}
const pda = (seed: string, user: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), VAULT.toBuffer(), user.toBuffer()], PROGRAM)[0];

async function tokenAmount(c: Connection, a: PublicKey): Promise<bigint> {
  const info = await c.getAccountInfo(a, "confirmed");
  if (!info) return -1n;
  return u64(info.data, 64); // SPL token account amount at offset 64
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface VaultState {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseReserve: PublicKey;
  quoteReserve: PublicKey;
  shareMint: PublicKey;
  shareLock: PublicKey;
  totalShares: bigint;
  insuranceBase: bigint;
  insuranceQuote: bigint;
  keeperBase: bigint;
  keeperQuote: bigint;
  protocolBase: bigint;
  protocolQuote: bigint;
  epoch: bigint;
  epochStart: bigint;
  status: number;
  bump: number;
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
    epoch: u64(d, 288), epochStart: u64(d, 296), status: d[304], bump: d[305],
  };
}
interface ConfigState { warmupSlots: bigint; epochSlots: bigint; feeBps: number; }
async function readConfig(c: Connection): Promise<ConfigState> {
  const d = (await c.getAccountInfo(CONFIG, "confirmed"))!.data;
  return { warmupSlots: u64(d, 152), epochSlots: u64(d, 160), feeBps: d.readUInt16LE(136) };
}
async function readQuote(c: Connection): Promise<{ expirySlot: bigint; version: bigint }> {
  const d = (await c.getAccountInfo(QUOTE_STATE, "confirmed"))!.data;
  return { expirySlot: u64(d, 24), version: u64(d, 8) };
}
const netBase = (v: VaultState, reserve: bigint) =>
  reserve - v.insuranceBase - v.keeperBase - v.protocolBase;
const netQuote = (v: VaultState, reserve: bigint) =>
  reserve - v.insuranceQuote - v.keeperQuote - v.protocolQuote;

function ix(name: string, keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[], data: Buffer): TransactionInstruction {
  return new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.concat([disc(name), data]) });
}
const meta = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

async function simulateThenSend(c: Connection, admin: Keypair, ixs: TransactionInstruction[], label: string) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(admin);
  const sim = await c.simulateTransaction(tx);
  const err = sim.value.err;
  if (err) {
    console.error(`[${label}] simulation FAILED:`, JSON.stringify(err));
    console.error(sim.value.logs?.slice(-12).join("\n"));
    process.exit(2);
  }
  const sig = await sendAndConfirmTransaction(c, tx, [admin], { commitment: "confirmed", skipPreflight: false });
  console.log(`[${label}] sig=${sig}`);
  return sig;
}

async function ensureAtaIx(c: Connection, admin: Keypair, mint: PublicKey): Promise<PublicKey> {
  const a = ata(mint, admin.publicKey);
  if (await c.getAccountInfo(a, "confirmed")) return a;
  const ixCreate = new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      meta(admin.publicKey, true, true), meta(a, false, true), meta(admin.publicKey, false, false),
      meta(mint, false, false), meta(SystemProgram.programId), meta(TOKEN_PROGRAM),
    ],
    data: Buffer.alloc(0),
  });
  await simulateThenSend(c, admin, [ixCreate], `ata-${mint.toBase58().slice(0, 4)}`);
  return a;
}

function decodeEvents(logs: string[], name: string): bigint[][] {
  const want = evDisc(name).toString("hex");
  const out: bigint[][] = [];
  for (const line of logs) {
    const m = /^Program data: (.*)$/.exec(line.trim());
    if (!m) continue;
    const b = Buffer.from(m[1], "base64");
    if (b.subarray(0, 8).toString("hex") !== want) continue;
    const words: bigint[] = [];
    for (let o = 8; o + 8 <= b.length; o += 8) words.push(u64(b, o));
    out.push(words);
  }
  return out;
}

async function main() {
  const phase = process.argv[2] ?? "deposit";
  const cfg = resolveRpcConfig(process.env);
  const c = new Connection(cfg.endpoints[0], "confirmed");
  const admin = loadAdmin();
  const v = await readVault(c);
  const conf = await readConfig(c);
  console.error(`rpc=${redactUrl(cfg.endpoints[0])} admin=${admin.publicKey.toBase58()} vault=${VAULT.toBase58()} epoch=${v.epoch} warmup=${conf.warmupSlots} epochSlots=${conf.epochSlots}`);

  const depTicket = pda("dep", admin.publicKey);
  const wdTicket = pda("wd", admin.publicKey);
  const userBase = await ensureAtaIx(c, admin, v.baseMint);
  const userQuote = await ensureAtaIx(c, admin, v.quoteMint);
  const userShares = await ensureAtaIx(c, admin, v.shareMint);

  if (phase === "deposit") {
    const baseReserveAmt = u64((await c.getAccountInfo(v.baseReserve, "confirmed"))!.data, 64);
    const quoteReserveAmt = u64((await c.getAccountInfo(v.quoteReserve, "confirmed"))!.data, 64);
    const bn = netBase(v, baseReserveAmt);
    const qn = netQuote(v, quoteReserveAmt);
    const baseAmount = 1_000_000n; // 0.001 WSOL
    const quoteAmount = (baseAmount * qn) / bn; // proportional
    const minShares = 0n;
    console.log(JSON.stringify({ netBase: bn.toString(), netQuote: qn.toString(), baseAmount: baseAmount.toString(), quoteAmount: quoteAmount.toString() }));

    const d = Buffer.alloc(24);
    d.writeBigUInt64LE(baseAmount, 0); d.writeBigUInt64LE(quoteAmount, 8); d.writeBigUInt64LE(minShares, 16);
    const ixDeposit = ix("deposit", [
      meta(admin.publicKey, true, true), meta(VAULT, false, true), meta(CONFIG, false, false),
      meta(v.baseReserve, false, true), meta(v.quoteReserve, false, true),
      meta(v.shareMint, false, true), meta(v.shareLock, false, true),
      meta(userBase, false, true), meta(userQuote, false, true), meta(userShares, false, true),
      meta(depTicket, false, true), meta(TOKEN_PROGRAM), meta(SystemProgram.programId),
    ], d);

    const sharesBefore = await tokenAmount(c, userShares);
    const sig = await simulateThenSend(c, admin, [ixDeposit], "deposit");
    const sharesAfter = await tokenAmount(c, userShares);
    const minted = sharesAfter - sharesBefore;
    const v2 = await readVault(c);
    const info = await c.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const ev = decodeEvents(info?.meta?.logMessages ?? [], "DepositEvent");
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      depositSig: sig, baseAmount: baseAmount.toString(), quoteAmount: quoteAmount.toString(),
      sharesMinted: minted.toString(), activateSlot: null, expectedShares: minted.toString(),
      depositEvent: ev[0]?.map(String) ?? null,
    }, null, 2));
    console.log(JSON.stringify({ sig, sharesMinted: minted.toString(), totalShares: v2.totalShares.toString(), depositEvent: ev[0]?.map(String) }));
    return;
  }

  if (phase === "settle") {
    // Wait out warm-up.
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
    console.log(JSON.stringify({ warmupDone: true, activateSlot: activateSlot.toString(), shares: shares.toString() }));

    // request_withdraw
    const reqSig = await simulateThenSend(c, admin, [ix("request_withdraw", [
      meta(admin.publicKey, true, true), meta(VAULT, false, true), meta(v.shareLock, false, true),
      meta(depTicket, false, false), meta(userShares, false, true), meta(wdTicket, false, true),
      meta(TOKEN_PROGRAM), meta(SystemProgram.programId),
    ], (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(shares, 0); return b; })())], "request_withdraw");

    // Wait for epoch.
    let vs = await readVault(c);
    const target = vs.epochStart + conf.epochSlots;
    slot = BigInt(await c.getSlot("confirmed"));
    while (slot < target) {
      console.error(`epoch wait: slot ${slot} < ${target} (ticketEpoch=${vs.epoch + 1n})`);
      await sleep(15000);
      slot = BigInt(await c.getSlot("confirmed"));
    }
    const crankSig = await simulateThenSend(c, admin, [ix("crank_epoch", [
      meta(VAULT, false, true), meta(CONFIG, false, false),
    ], Buffer.alloc(0))], "crank_epoch");

    // Snapshot immediately before claim.
    const vc = await readVault(c);
    const baseReserveAmt = u64((await c.getAccountInfo(vc.baseReserve, "confirmed"))!.data, 64);
    const quoteReserveAmt = u64((await c.getAccountInfo(vc.quoteReserve, "confirmed"))!.data, 64);
    const bn = netBase(vc, baseReserveAmt);
    const qn = netQuote(vc, quoteReserveAmt);
    const wd = await c.getAccountInfo(wdTicket, "confirmed");
    const wShares = u64(wd!.data, 40);
    const expectBase = (wShares * bn) / vc.totalShares;
    const expectQuote = (wShares * qn) / vc.totalShares;
    const balBefore = { base: await tokenAmount(c, userBase), quote: await tokenAmount(c, userQuote), shares: await tokenAmount(c, userShares) };

    const claimSig = await simulateThenSend(c, admin, [ix("claim_withdraw", [
      meta(admin.publicKey, true, true), meta(VAULT, false, true),
      meta(vc.baseReserve, false, true), meta(vc.quoteReserve, false, true),
      meta(vc.shareMint, false, true), meta(vc.shareLock, false, true),
      meta(wdTicket, false, true), meta(userBase, false, true), meta(userQuote, false, true),
      meta(TOKEN_PROGRAM),
    ], Buffer.alloc(0))], "claim_withdraw");

    const balAfter = { base: await tokenAmount(c, userBase), quote: await tokenAmount(c, userQuote), shares: await tokenAmount(c, userShares) };
    const info = await c.getTransaction(claimSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const ev = decodeEvents(info?.meta?.logMessages ?? [], "WithdrawClaimed")[0] ?? [];
    const vAfter = await readVault(c);
    const baseReserveAfter = u64((await c.getAccountInfo(vAfter.baseReserve, "confirmed"))!.data, 64);
    const quoteReserveAfter = u64((await c.getAccountInfo(vAfter.quoteReserve, "confirmed"))!.data, 64);
    const delta = { base: balAfter.base - balBefore.base, quote: balAfter.quote - balBefore.quote, shares: balBefore.shares - balAfter.shares };
    const report = {
      requestSig: reqSig, crankSig, claimSig,
      ticketShares: wShares.toString(),
      expected: { base: expectBase.toString(), quote: expectQuote.toString() },
      deltas: { base: delta.base.toString(), quote: delta.quote.toString(), sharesBurned: delta.shares.toString() },
      event: { slot: ev[0]?.toString(), shares: ev[1]?.toString(), base: ev[2]?.toString(), quote: ev[3]?.toString() },
      totalShares: { before: vc.totalShares.toString(), after: vAfter.totalShares.toString() },
      reserves: {
        base: { before: baseReserveAmt.toString(), after: baseReserveAfter.toString() },
        quote: { before: quoteReserveAmt.toString(), after: quoteReserveAfter.toString() },
      },
      liabilities: { base: (vAfter.insuranceBase + vAfter.keeperBase + vAfter.protocolBase).toString(), quote: (vAfter.insuranceQuote + vAfter.keeperQuote + vAfter.protocolQuote).toString() },
      checks: {
        baseDeltaMatchesFormula: delta.base === expectBase,
        quoteDeltaMatchesFormula: delta.quote === expectQuote,
        eventMatchesDelta: BigInt(ev[2] ?? -1) === delta.base && BigInt(ev[3] ?? -1) === delta.quote,
        sharesBurnedMatches: delta.shares === wShares,
        totalSharesConsistent: vc.totalShares - vAfter.totalShares === wShares,
      },
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (phase === "expired") {
    // (d) claim_withdraw reads no quote account; catch an expired window and
    // simulate a representative claim (the real claim already ran in `settle`).
    let sawExpired = false;
    for (let i = 0; i < 40; i++) {
      const q = await readQuote(c);
      const slot = BigInt(await c.getSlot("confirmed"));
      if (slot >= q.expirySlot) { sawExpired = true; console.log(JSON.stringify({ expired: true, slot: slot.toString(), expirySlot: q.expirySlot.toString(), version: q.version.toString() })); break; }
      await sleep(4000);
    }
    const vv = await readVault(c);
    const claimIx = ix("claim_withdraw", [
      meta(admin.publicKey, true, true), meta(VAULT, false, true),
      meta(vv.baseReserve, false, true), meta(vv.quoteReserve, false, true),
      meta(vv.shareMint, false, true), meta(vv.shareLock, false, true),
      meta(wdTicket, false, true), meta(userBase, false, true), meta(userQuote, false, true),
      meta(TOKEN_PROGRAM),
    ], Buffer.alloc(0));
    const tx = new Transaction().add(claimIx);
    tx.feePayer = admin.publicKey;
    tx.recentBlockhash = (await c.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(admin);
    const sim = await c.simulateTransaction(tx);
    console.log(JSON.stringify({ sawExpiredQuoteWindow: sawExpired, claimAccountsIncludeQuoteState: false, simulatedWithSettledTicketErr: sim.value.err, note: "claim_withdraw has no quote_state account and no freshness check" }, null, 2));
    return;
  }

  throw new Error(`unknown phase ${phase}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
