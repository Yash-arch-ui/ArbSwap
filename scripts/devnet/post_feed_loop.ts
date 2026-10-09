// Continuously refresh the persistent SOL/USD price-feed account on devnet with
// the official Pyth receiver SDK (no custom parser). One process per poster.
//   PYTH_API_KEY=... POST_INTERVAL_MS=25000 npx tsx post_feed_loop.ts
import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import fs from "fs";

const SOL_USD = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const keyPath = process.env.ARBSWAP_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
  const hermesUrl = process.env.HERMES_URL ?? "https://hermes.pyth.network";
  const intervalMs = Number(process.env.POST_INTERVAL_MS ?? 25_000);
  const apiKey = process.env.PYTH_API_KEY;
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")));
  const wallet = new Wallet(Keypair.fromSecretKey(secret));
  const connection = new Connection(rpc, "confirmed");
  const hermes = new HermesClient(hermesUrl, apiKey ? { accessToken: apiKey } : {});
  const receiver = new PythSolanaReceiver({ connection, wallet });
  while (true) {
    try {
      const updates = await hermes.getLatestPriceUpdates([SOL_USD], { encoding: "base64" });
      const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
      await builder.addUpdatePriceFeed(updates.binary.data, 0);
      const txs = await builder.buildVersionedTransactions({
        computeUnitPriceMicroLamports: 50_000,
        tightComputeBudget: false,
      });
      for (const { tx, signers } of txs) {
        tx.sign([wallet.payer as Keypair, ...signers]);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
        await connection.confirmTransaction(sig, "confirmed");
        console.log("feed_updated,sig=" + sig + ",publish_time=" + updates.parsed?.[0]?.price?.publish_time);
      }
    } catch (e) {
      console.error("poster error:", (e as Error).message);
    }
    await sleep(intervalMs);
  }
}
main();
