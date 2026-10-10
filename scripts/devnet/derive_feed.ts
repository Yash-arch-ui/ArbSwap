import { getPriceFeedAccountForProgram } from "@pythnetwork/pyth-solana-receiver";
const feed = Buffer.from("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d","hex");
for (const shard of [0,1,2,3]) {
  console.log("shard", shard, getPriceFeedAccountForProgram(shard, feed).toBase58());
}
