// Post a fully verified SOL/USD Pyth price update to devnet using the official
// `@pythnetwork/pyth-solana-receiver` SDK, and print the resulting
// `PriceUpdateV2` account for ArbSwap's `update_quote`.
//
// Secrets come from the environment only (never the repo):
//   RPC_URL            (default https://api.devnet.solana.com)
//   ARBSWAP_KEYPAIR    (default ~/.config/solana/id.json)
//   HERMES_URL         (default https://hermes.pyth.network)
//   PYTH_API_KEY       (required by Hermes since 2026-08)
//
// Run: PYTH_API_KEY=... npx tsx post_pyth.ts

import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import fs from "fs";

// SOL/USD price feed id (Pyth).
const SOL_USD = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const keyPath =
    process.env.ARBSWAP_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
  const hermesUrl = process.env.HERMES_URL ?? "https://hermes.pyth.network";
  const apiKey = process.env.PYTH_API_KEY;

  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")));
  const wallet = new Wallet(Keypair.fromSecretKey(secret));
  const connection = new Connection(rpc, "confirmed");
  const hermes = new HermesClient(hermesUrl, apiKey ? { accessToken: apiKey } : {});
  const updates = await hermes.getLatestPriceUpdates([SOL_USD], {
    encoding: "base64",
  });

  const receiver = new PythSolanaReceiver({ connection, wallet });
  // Keep the update account open so ArbSwap's update_quote can consume it.
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addPostPriceUpdates(updates.binary.data);
  const priceUpdate = builder.getPriceUpdateAccount(SOL_USD);
  console.log("price_update=" + priceUpdate.toBase58());

  const txs = await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 100_000,
    tightComputeBudget: false,
  });
  const sigs: string[] = [];
  for (const { tx, signers } of txs) {
    tx.sign([wallet.payer as Keypair, ...signers]);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(sig, "confirmed");
    sigs.push(sig);
  }
  console.log("pyth_post_sigs=" + sigs.join(","));
  const parsed = updates.parsed?.[0]?.price as
    | { price: string; conf: string; expo: number; publish_time: number }
    | undefined;
  if (!parsed) throw new Error("no parsed price in Hermes response");
  const priceQ64 =
    (BigInt(parsed.price) * (1n << 64n)) / 10n ** BigInt(-parsed.expo);
  const confBps = Number(
    (BigInt(parsed.conf) * 10_000n + BigInt(parsed.price) - 1n) / BigInt(parsed.price)
  );
  const info = {
    price_update: priceUpdate.toBase58(),
    price_q64: priceQ64.toString(),
    conf_bps: confBps,
    publish_time: parsed.publish_time,
  };
  fs.writeFileSync("/tmp/arbswap_pyth.json", JSON.stringify(info, null, 2));
  console.log("pyth_info=" + JSON.stringify(info));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
