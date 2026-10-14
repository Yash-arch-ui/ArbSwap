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
  ["Demo", "07-demo"],
  ["Evidence", "08-evidence"],
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
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails ?? {};
      const desc = d.exception?.description ?? d.text ?? "exception";
      exceptions.push(String(desc).split("\n").slice(0, 3).join(" | "));
    }
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

  // Optional focused fresh-quote sampling (S2-35). With a live keeper committing
  // quotes, click back to the Swap tab and sample the rendered book over a
  // window, counting samples that show the fresh/active book. This is recorded
  // evidence of the app reading a *fresh* on-chain quote — it is intentionally
  // NOT part of the deterministic gate (a quote is fresh for only ~2.4 s).
  let freshSamples = 0;
  let freshSampleTotal = 0;
  const freshSampleMs = Number(process.env.FRESH_SAMPLE_MS ?? 0);
  if (freshSampleMs > 0) {
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Runtime.evaluate", {
      expression: `(() => { const a=[...document.querySelectorAll('a,button')].find(x=>x.textContent.trim().startsWith('Swap')); if(a) a.click(); })()`,
    });
    await sleep(1500);
    const until = Date.now() + freshSampleMs;
    while (Date.now() < until) {
      const t = await send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true });
      const txt = t?.result?.value ?? "";
      freshSampleTotal += 1;
      if (/6-LEVEL ACTIVE BOOK|quote v\d+ · Fresh|Pyth Mid/.test(txt)) freshSamples += 1;
      await sleep(500);
    }
  }

  const summary = {
    app: APP,
    screenshots: OUT,
    exceptions,
    consoleErrors,
    rpcRetryNotices: rpcRetryNotices.length,
    hasKeeperRewardsPanel: /Keeper rewards/.test(states["04-risk"] ?? ""),
    // S2-35: the normal Devnet build is transaction-enabled. The read-only
    // diagnostic banner must NOT render, the mode badge must say `trading`, and
    // the swap page must present a real on-chain state honestly (a fresh quote
    // enables submission; an expired/unavailable quote shows the concrete
    // reason) rather than a blanket "read-only" block.
    modeBadge: /trading/i.test(states["01-overview"] ?? ""),
    readOnlyBanner: /Read-only diagnostic mode|Read-only integration mode/i.test(
      `${states["02-swap"] ?? ""}${states["03-vault"] ?? ""}${states["04-risk"] ?? ""}${states["05-analytics"] ?? ""}`,
    ),
    walletNotConnectedHonest: /Connect Wallet|connect wallet|Wallet not connected/i.test(states["02-swap"] ?? ""),
    swapHonestState:
      /6-LEVEL ACTIVE BOOK|LAST-KNOWN BOOK|Quote expired|quote expired|Quote unavailable|no fresh Pyth quote|Vault not initialized|RPC (rate limited|unavailable)|Swaps unavailable/i.test(
        states["02-swap"] ?? "",
      ),
    vaultLive: /\d/.test(states["03-vault"] ?? ""),
    // Observed fresh quote (requires a live keeper during the run); recorded but
    // not part of the deterministic gate.
    freshQuoteObserved: /6-LEVEL ACTIVE BOOK|quote v\d+ · Fresh|Pyth Mid/i.test(states["02-swap"] ?? ""),
    analyticsHonest: /INDEXED HISTORY|RESEARCH artifacts|analytics (export|unavailable)|historical only/i.test(states["05-analytics"] ?? ""),
    modelLabelled: /model/i.test(states["01-overview"] ?? ""),
    noFabricatedMarkout: !/\+0\.38 bps/.test(states["01-overview"] ?? ""),
    // S2-33: indexed history panel renders with explicit provenance.
    analyticsHistory:
      /INDEXED HISTORY/.test(states["05-analytics"] ?? "") &&
      /Historical swaps \(indexed\)/.test(states["05-analytics"] ?? ""),
    // Expired state is labelled from the export's server-computed freshness flag
    // (robust to public-RPC rate limiting) and/or the live pages when reachable.
    expiredQuoteLabelled: /EXPIRED|Quote expired|last-known/i.test(
      `${states["01-overview"] ?? ""}${states["02-swap"] ?? ""}${states["05-analytics"] ?? ""}`,
    ),
    // S2-35 focused live evidence (recorded, not gated): how many samples of the
    // Swap page showed the fresh/active book while the keeper was committing.
    freshSamples,
    freshSampleTotal,
  };
  console.log(JSON.stringify(summary, null, 2));
  ws.close();
  const ok =
    exceptions.length === 0 &&
    consoleErrors.length === 0 &&
    summary.modeBadge &&
    !summary.readOnlyBanner &&
    summary.swapHonestState &&
    summary.noFabricatedMarkout &&
    summary.analyticsHistory &&
    summary.expiredQuoteLabelled;
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
