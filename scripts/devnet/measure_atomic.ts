import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import fs from "fs";
const SOL_USD = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
async function main() {
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ARBSWAP_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`,"utf8")));
  const wallet = new Wallet(Keypair.fromSecretKey(secret));
  const connection = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com","confirmed");
  const hermes = new HermesClient(process.env.HERMES_URL ?? "https://hermes.pyth.network", process.env.PYTH_API_KEY?{accessToken:process.env.PYTH_API_KEY}:{});
  const updates = await hermes.getLatestPriceUpdates([SOL_USD], { encoding: "base64" });
  const receiver = new PythSolanaReceiver({ connection, wallet });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addUpdatePriceFeed(updates.binary.data, 0);
  const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 0, tightComputeBudget: false });
  txs.forEach((t:any,i:number)=>{
    const msg=t.tx.message;
    console.log(`tx${i}: raw=${t.tx.serialize().length} keys=${msg.staticAccountKeys.length}`);
    msg.compiledInstructions.forEach((ci:any,j:number)=>{
      const prog=msg.staticAccountKeys[ci.programIdIndex].toBase58();
      console.log(`   ix${j} prog=${prog} data=${ci.data.length} accounts=${ci.accountKeyIndexes.length}`);
    });
  });
  const totalPostBytes = txs.reduce((a:number,t:any)=>a+t.tx.serialize().length,0);
  console.log("TOTAL post (all txs) raw bytes:", totalPostBytes);
  const quoteTx = 1220; // measured S2-9
  console.log("combined single-tx estimate (post data+keys merged with update_quote):",
    ">= postData(752) + quoteData(700) + ~ (keys) >=", 752+700, "data alone; > 1232");
  console.log("deficit vs 1232 if attempting one combined tx: ~", (totalPostBytes+quoteTx)-1232, "B across txs");
}
main().catch(e=>{console.error(e);process.exit(1);});
