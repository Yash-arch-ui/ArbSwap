// S2-13 liquidity-deposit PREFLIGHT — read-only (SIMULATION only, never sends).
// Builds the proportional vault `deposit` for the given WSOL/USDC atoms, wrapping
// SOL into the WSOL ATA in the same transaction, and simulates it.
//
//   DEPOSIT_BASE_ATOMS=... DEPOSIT_QUOTE_ATOMS=... npx tsx deposit_preflight.ts
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  AccountMeta,
} from "@solana/web3.js";
import { createHash } from "crypto";
import fs from "fs";

const PROGRAM = new PublicKey("2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm");
const VAULT = new PublicKey("8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt");
const CONFIG = new PublicKey("ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT");
const BASE_RESERVE = new PublicKey("8vfr2KmMmXYUTjRg5cAiSYD6EhN1d8pjJnmFC95E2vfm");
const QUOTE_RESERVE = new PublicKey("G8q1WMKT8fnGQh85kCB8Aihf6F7tctXJDKbA6gn1jPeS");
const SHARE_MINT = new PublicKey("AyGcsmW6n8WvgHbHbw2SVbYAsWaw2XcYD5SyH9EdWeL9");
const SHARE_LOCK = new PublicKey("E5mxeoL32RYohrDP9ycGhG7F1hAtm8DQFmT6Bp3Cwm2a");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const USER_WSOL = new PublicKey("5MpRjKvzgW5C7x8sbam4KgA5KGkGyTKNCXarbqZceCnJ");
const USER_USDC = new PublicKey("5SThVCCb6vrvvkwSMukanW5vWkUehBCVW8iT53KqVzgV");
const USER_SHARE = new PublicKey("EuCJjGHw1aBoKsaT5oUPktNw3ZtyQXAsZBYa3Vkgh13L");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM = SystemProgram.programId;

const disc = (n: string) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const meta = (pubkey: PublicKey, w = false, s = false): AccountMeta => ({ pubkey, isWritable: w, isSigner: s });

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const user = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ARBSWAP_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`, "utf8"))));
  const c = new Connection(rpc, "processed");

  const v = (await c.getAccountInfo(VAULT, "processed"))!.data;
  const totalShares = v.readBigUInt64LE(232);
  const baseNet = BigInt((await c.getTokenAccountBalance(BASE_RESERVE, "processed")).value.amount);
  const quoteNet = BigInt((await c.getTokenAccountBalance(QUOTE_RESERVE, "processed")).value.amount);
  const availQuote = BigInt((await c.getTokenAccountBalance(USER_USDC, "processed")).value.amount);
  const walletSol = BigInt(await c.getBalance(user.publicKey, "processed"));

  // Defaults: max matched deposit limited by the available USDC.
  const quoteAmount = process.env.DEPOSIT_QUOTE_ATOMS ? BigInt(process.env.DEPOSIT_QUOTE_ATOMS) : availQuote;
  const baseAmount = process.env.DEPOSIT_BASE_ATOMS ? BigInt(process.env.DEPOSIT_BASE_ATOMS) : (quoteAmount * baseNet) / quoteNet;

  const byBase = (baseAmount * totalShares) / baseNet;
  const byQuote = (quoteAmount * totalShares) / quoteNet;
  const shares = byBase < byQuote ? byBase : byQuote;
  const minShares = (shares * 9950n) / 10000n;
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  const pullBase = ceilDiv(shares * baseNet, totalShares);
  const pullQuote = ceilDiv(shares * quoteNet, totalShares);

  const [ticket] = PublicKey.findProgramAddressSync([Buffer.from("dep"), VAULT.toBuffer(), user.publicKey.toBuffer()], PROGRAM);
  const depositIx = new TransactionInstruction({
    programId: PROGRAM,
    data: Buffer.concat([disc("deposit"), u64(baseAmount), u64(quoteAmount), u64(minShares)]),
    keys: [
      meta(user.publicKey, true, true), meta(VAULT, true), meta(CONFIG), meta(BASE_RESERVE, true),
      meta(QUOTE_RESERVE, true), meta(SHARE_MINT, true), meta(SHARE_LOCK, true), meta(USER_WSOL, true),
      meta(USER_USDC, true), meta(USER_SHARE, true), meta(ticket, true), meta(TOKEN), meta(SYSTEM),
    ],
  });

  const { blockhash } = await c.getLatestBlockhash("processed");
  const tx = new Transaction({ feePayer: user.publicKey, recentBlockhash: blockhash });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }));
  // Wrap exactly pullBase lamports of SOL into the WSOL ATA.
  tx.add(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: USER_WSOL, lamports: Number(pullBase) }));
  tx.add(new TransactionInstruction({
    programId: TOKEN,
    data: Buffer.from([17]), // SyncNative
    keys: [meta(USER_WSOL, true)],
  }));
  tx.add(depositIx);
  tx.sign(user);

  const sim = await c.simulateTransaction(tx);
  console.log(JSON.stringify({
    quote_amount_atoms: quoteAmount.toString(), quote_amount: Number(quoteAmount) / 1e6,
    base_amount_atoms: baseAmount.toString(), base_amount: Number(baseAmount) / 1e9,
    shares: shares.toString(), min_shares: minShares.toString(),
    pull_base_atoms: pullBase.toString(), pull_quote_atoms: pullQuote.toString(),
    wallet_sol: Number(walletSol) / 1e9,
    post_base_reserve: baseNet.toString(), post_quote_reserve: quoteNet.toString(),
    post_base_after: (baseNet + pullBase).toString(), post_quote_after: (quoteNet + pullQuote).toString(),
    tx_size_bytes: tx.serialize().length, simulation_err: sim.value.err,
    logs_tail: sim.value.logs?.slice(-6) ?? [],
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
