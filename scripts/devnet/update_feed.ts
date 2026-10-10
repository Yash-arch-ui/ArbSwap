// Update the persistent SOL/USD price-feed account on devnet with the official
// Pyth receiver SDK (no custom Merkle/VAA parser).
//   PYTH_API_KEY=... npx tsx update_feed.ts
import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import fs from "fs";

const SOL_USD = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const keyPath = process.env.ARBSWAP_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
  const hermesUrl = process.env.HERMES_URL ?? "https://hermes.pyth.network";
  const apiKey = process.env.PYTH_API_KEY;
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")));
  const wallet = new Wallet(Keypair.fromSecretKey(secret));
  const connection = new Connection(rpc, "confirmed");
  const hermes = new HermesClient(hermesUrl, apiKey ? { accessToken: apiKey } : {});
  const updates = await hermes.getLatestPriceUpdates([SOL_USD], { encoding: "base64" });
  const receiver = new PythSolanaReceiver({ connection, wallet });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addUpdatePriceFeed(updates.binary.data, 0);
  const txs = await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 100_000,
    tightComputeBudget: false,
  });
  const sigs: string[] = [];
  for (const { tx, signers } of txs) {
    tx.sign([wallet.payer as Keypair, ...signers]);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig, "confirmed");
    sigs.push(sig);
  }
  console.log("update_feed_sigs=" + sigs.join(","));
  console.log("parsed=" + JSON.stringify(updates.parsed?.[0]?.price ?? null));
}
main().catch((e) => { console.error(e); process.exit(1); });
