import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, AccountMeta } from "@solana/web3.js";
import fs from "fs";
import { createHash } from "crypto";
const SOL_USD = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const PROGRAM = new PublicKey("2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm");
const VAULT = new PublicKey("8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt");
const CONFIG = new PublicKey("ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT");
const QUOTE_STATE = new PublicKey("5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG");
const PRICE_UPDATE = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const KEEPER_BOND = new PublicKey("DsSQaVCdwzKjbxRJm4vmbbqqJwLgLMmDgzMjkeneUryd");
const BASE_RESERVE = new PublicKey("8vfr2KmMmXYUTjRg5cAiSYD6EhN1d8pjJnmFC95E2vfm");
const QUOTE_RESERVE = new PublicKey("G8q1WMKT8fnGQh85kCB8Aihf6F7tctXJDKbA6gn1jPeS");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const SYS = PublicKey.default;
const disc = (n: string) => createHash("sha256").update(`global:${n}`).digest().subarray(0,8);
function meta(pk: PublicKey, w=false, s=false): AccountMeta { return { pubkey: pk, isWritable: w, isSigner: s }; }
async function main() {
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ARBSWAP_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`,"utf8")));
  const wallet = new Wallet(Keypair.fromSecretKey(secret));
  const keeper = wallet.payer as Keypair;
  const connection = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com","confirmed");
  const hermes = new HermesClient(process.env.HERMES_URL ?? "https://hermes.pyth.network", process.env.PYTH_API_KEY?{accessToken:process.env.PYTH_API_KEY}:{});
  const updates = await hermes.getLatestPriceUpdates([SOL_USD], { encoding: "base64" });
  const receiver = new PythSolanaReceiver({ connection, wallet });

  const [pending] = PublicKey.findProgramAddressSync([Buffer.from("pending_quote"), VAULT.toBuffer(), keeper.publicKey.toBuffer()], PROGRAM);

  // ---- Tx A: stage_quote (disc + nonce u64 + QuoteUpdate 692B) ----
  const stageData = Buffer.concat([disc("stage_quote"), Buffer.alloc(8+692)]);
  const stageIx = new TransactionInstruction({ programId: PROGRAM, data: stageData, keys: [
    meta(keeper.publicKey, true, true), meta(VAULT), meta(CONFIG), meta(pending, true),
    meta(BASE_RESERVE), meta(QUOTE_RESERVE), meta(KEEPER_BOND), meta(SYS),
  ]});
  const bh = await connection.getLatestBlockhash();
  const msgA = new TransactionMessage({ payerKey: keeper.publicKey, recentBlockhash: bh.blockhash, instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({units:80_000}), stageIx ]}).compileToV0Message();
  const txA = new VersionedTransaction(msgA); txA.sign([keeper]);
  console.log(`TX A stage_quote: data=${stageData.length} keys=${msgA.staticAccountKeys.length} size=${txA.serialize().length}`);

  // ---- Tx B: push (updatePriceFeed) + commit_quote ----
  const { postInstructions } = await receiver.buildUpdatePriceFeedInstructions(updates.binary.data, 0);
  const updateFeed = postInstructions.filter((p:any)=>p.instruction.programId.toBase58().startsWith("pyth")).map((p:any)=>p.instruction);
  const commitData = Buffer.concat([disc("commit_quote"), Buffer.alloc(8)]);
  const commitIx = new TransactionInstruction({ programId: PROGRAM, data: commitData, keys: [
    meta(keeper.publicKey, true, true), meta(VAULT,true), meta(CONFIG), meta(QUOTE_STATE,true),
    meta(pending,true), meta(PRICE_UPDATE), meta(KEEPER_BOND), meta(BASE_RESERVE), meta(QUOTE_RESERVE),
    meta(WSOL), meta(USDC),
  ]});
  const pushKeys = updateFeed[0]?.keys.length ?? 0;
  const pushData = updateFeed[0]?.data.length ?? 0;
  const msgB = new TransactionMessage({ payerKey: keeper.publicKey, recentBlockhash: bh.blockhash, instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({units:200_000}), ComputeBudgetProgram.setComputeUnitPrice({microLamports:1000}),
    ...updateFeed, commitIx ]}).compileToV0Message();
  const txB = new VersionedTransaction(msgB); txB.sign([keeper]);
  console.log(`TX B push+commit: pushIx=${updateFeed.length} pushData=${pushData} pushKeys=${pushKeys} commitData=${commitData.length} totalKeys=${msgB.staticAccountKeys.length} size=${txB.serialize().length}`);
  console.log(`HEADROOM A=${1232-txA.serialize().length}  B=${1232-txB.serialize().length}`);
  console.log("pending_quote PDA =", pending.toBase58());
}
main().catch(e=>{console.error(e);process.exit(1);});
