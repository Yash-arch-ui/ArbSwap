// Postinstall shim: `jito-ts` -> `@solana/web3.js@1.77` requires the legacy
// `rpc-websockets/dist/lib/client` subpath, which rpc-websockets 8.x ships as
// `.cjs`. This creates the `.js` re-export shims so the official Pyth SDK can
// load. Reproducible and node_modules-only (no source changes).
const fs = require("fs");
const path = require("path");
const base = path.join(__dirname, "node_modules", "rpc-websockets", "dist", "lib");
if (!fs.existsSync(base)) process.exit(0);
const shims = [
  ["client.js", "module.exports = require('./client.cjs');"],
  [path.join("client", "websocket.js"), "module.exports = require('./websocket.cjs');"],
];
for (const [rel, body] of shims) {
  const p = path.join(base, rel);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    console.log("shim wrote", p);
  }
}
