// S2-27 browser smoke test for the canonical `app/`.
//
// Drives the Playwright-cached headless Chromium over the DevTools Protocol
// (Node's built-in WebSocket, no npm dependencies) and verifies each tab renders
// real DOM: no uncaught exceptions, no console errors, honest quote/wallet/
// analytics states, and captures screenshots. Read-only — never submits a tx.
//
// Usage (see docs/S2_27_BROWSER_E2E.md):
//   APP_URL=http://localhost:5173/ node app/e2e/browser-smoke.mjs
// Requires a Chromium reachable at CDP (--remote-debugging-port=9222) and its
// system libraries (NSS/NSPR). No secrets are read or printed.
import fs from "node:fs";
import path from "node:path";

const CDP = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const APP = process.env.APP_URL ?? "http://localhost:5173/";
const OUT = process.env.OUT_DIR ?? path.join(process.cwd(), "test-results", "e2e");
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TABS = [
  ["Overview", "01-overview"],
  ["Swap", "02-swap"],
  ["Vault", "03-vault"],
  ["Risk", "04-risk"],
  ["Analytics", "05-analytics"],
];

async function main() {
  const targets = await (await fetch(`${CDP}/json`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error(`no page target at ${CDP}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  const consoleErrors = [];
  const rpcRetryNotices = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails?.text ?? "exception");
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const msg = (m.params.args ?? []).map((a) => a.value ?? a.description).join(" ");
      // Public-RPC 429 retry notices from @solana/web3.js are transport noise,
      // not application errors; track them separately so the gate measures the app.
      if (/429|rate.?limit|Retrying after/i.test(msg)) rpcRetryNotices.push(msg);
      else consoleErrors.push(msg);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: APP });
  await sleep(8000);

  const capture = async (name) => {
    const text = await send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true });
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(shot.data, "base64"));
    return text?.result?.value ?? "";
  };

  const states = {};
  for (const [label, name] of TABS) {
    if (label !== "Overview") {
      await send("Runtime.evaluate", {
        expression: `(() => { const a=[...document.querySelectorAll('a,button')].find(x=>x.textContent.trim().startsWith(${JSON.stringify(label)})); if(a) a.click(); })()`,
      });
      await sleep(2500);
    }
    states[name] = await capture(name);
  }

  // Narrow viewport.
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(1200);
  states["06-narrow"] = await capture("06-narrow");

  const summary = {
    app: APP,
    screenshots: OUT,
    exceptions,
    consoleErrors,
    rpcRetryNotices: rpcRetryNotices.length,
    hasKeeperRewardsPanel: /Keeper rewards/.test(states["04-risk"] ?? ""),
    swapExpiredHonest: /Quote expired|Swaps stay disabled|EXPIRED|Quote unavailable|Read-only/i.test(states["02-swap"] ?? ""),
    analyticsHonest: /analytics (export|unavailable)|historical only/i.test(states["05-analytics"] ?? ""),
    // S2-32 read-only integration checks.
    readOnlyBanner: /Read-only integration mode/i.test(
      `${states["02-swap"] ?? ""}${states["03-vault"] ?? ""}${states["04-risk"] ?? ""}${states["05-analytics"] ?? ""}`,
    ),
    swapReadOnly: /Read-only mode/i.test(states["02-swap"] ?? ""),
    modelLabelled: /model/i.test(states["01-overview"] ?? ""),
    noFabricatedMarkout: !/\+0\.38 bps/.test(states["01-overview"] ?? ""),
  };
  console.log(JSON.stringify(summary, null, 2));
  ws.close();
  const ok =
    exceptions.length === 0 &&
    consoleErrors.length === 0 &&
    summary.readOnlyBanner &&
    summary.swapReadOnly &&
    summary.noFabricatedMarkout;
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
