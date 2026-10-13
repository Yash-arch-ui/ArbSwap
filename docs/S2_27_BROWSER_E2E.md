# S2-27 — Browser E2E, wallet/RPC reliability, and demo gate

Status: **local implementation + real browser E2E + read-only Devnet. No tx sent.**

## 1. Browser environment (real render, no npm browser stack)

Playwright/Puppeteer are **not** installed and `sudo` requires a password, so
system packages could not be installed. Resolution (non-root, reproducible):

1. The Playwright **cached** browser was reused:
   `~/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`.
2. The missing system libs (`libnspr4`, `libnss3`, `libasound2`, …) were fetched
   **without root** via `apt-get download` + `dpkg-deb -x` into a local prefix and
   exposed through `LD_LIBRARY_PATH`.
3. The browser is driven over the DevTools Protocol by
   `app/e2e/browser-smoke.mjs` using Node's built-in `WebSocket` (no dependency).

In CI (where `npx playwright install --with-deps chromium` runs as root) the same
script works unchanged against a Playwright-launched browser.

### Exact commands

```bash
# terminal 1
cd app && yarn dev

# terminal 2 — start the headless shell with remote debugging
SHELL=~/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell
LD_LIBRARY_PATH=/path/to/nss-libs "$SHELL" --no-sandbox --disable-gpu \
  --disable-background-networking --remote-debugging-port=9222 about:blank &

# terminal 3 — run the E2E
APP_URL=http://localhost:5173/ node app/e2e/browser-smoke.mjs
```

Output: JSON summary + screenshots in `app/test-results/e2e/` (gitignored).

## 2. Routes and viewports verified (rendered DOM)

Desktop (1440×900) and narrow (390×844). Tabs (client-side state): Overview,
Swap, Vault, Risk, Analytics. `app/e2e/browser-smoke.mjs` clicks each nav anchor,
captures `document.body.innerText` and a screenshot.

Result (this session): **exceptions: 0, consoleErrors: 0**, and
`hasKeeperRewardsPanel: true`, `swapExpiredHonest: true`, `analyticsHonest: true`.

Rendered evidence (live, read-only):
- **Swap:** `Quote expired. Version v28, expiry slot 510667289 (current slot …).
  Swaps stay disabled until the keeper commits a new staged quote.` + `EXPIRED` +
  6-level book with real prices (~$108.4). No fabricated price.
- **Vault:** `Deposit WSOL and USDC pro-rata…` (stale `tSOL/tUSDC` copy fixed).
- **Risk:** `KEEPER: PERMISSIONLESS` (fixed; was a hardcoded `BONDED`), keeper
  rewards panel shows the disconnected state.
- **Analytics:** `No on-chain analytics export is available in this deployment
  (optional, historical only).` (fixed; was a raw JSON parse error).

## 3. Defects found and fixed via the browser

1. Empty `<img src="">` for token logos → React console errors. Now rendered only
   when `logo` is non-empty (`SwapPage`, `VaultPage`).
2. Vault copy said `tSOL and tUSDC` → now uses the canonical token symbols
   (`WSOL`/`USDC`).
3. Risk hardcoded `Keeper: BONDED` → `PERMISSIONLESS`/`BONDED` from
   `riskBreakers.keeperBondActive`; `Active Cranker Address` →
   `Configured keeper (not the quote author)`.
4. Analytics export loader treated an SPA-fallback `index.html` (HTTP 200) as a
   JSON error → now returns `missing` when the response is not JSON.

## 4. Transaction-builder validation

`app/test/instruction-interface.test.ts` pins the deployed IDL account lists
(swap incl. `keeper_reward` + `system_program`; `claim_keeper_reward`; deposit;
request/claim withdraw; crank; `migrate_quote_state`) and the
`keeperRewardPda = PDA([b"reward", vault, keeper])` derivation. `integration.test.ts`
covers attribution (`quoteKeeper` only when genuinely on-chain). No builder calls
`sendTransaction`/broadcast in tests.

## 5. RPC / wallet-adapter connection design

- One app-wide `APP_RPC_FAILOVER` (`app/src/chain/rpcFailover.ts`) is used for
  **reads and transaction construction** (`ProtocolContext`, `SwapPage`,
  `VaultPage`, `KeeperRewards`) → blockhash/send/confirm stay on the active
  same-cluster endpoint; transport errors fail over, program errors do not.
- **Limitation (documented):** the wallet adapter's `ConnectionProvider` still
  points at the primary `SOLANA_DEVNET_RPC` for its internal calls. The adapter
  has no supported API to swap its `Connection` dynamically without risking
  signer/extension compatibility, so it is left as-is; the app never mixes
  clusters (config layer rejects cross-cluster URLs).
- A `Page.navigate` reload cannot duplicate a transaction (builders only run on
  explicit user action; no auto-submit on render/refresh).

## 6. Full validation results (this session)

- `cargo fmt --all --check`: clean. `cargo test --workspace`: green.
- `yarn test`: **53 passed** (6 files). `yarn lint`: clean. `yarn build`
  (tsc + vite): clean.
- Browser E2E (`app/e2e/browser-smoke.mjs`): **PASS** (0 exceptions, 0 console
  errors, all tabs rendered, screenshots captured).
- Keeper TS `rpc.test`/`keeper_commit.test` OK; `tsc --noEmit` clean.
- Analytics `pytest`: **34 passed**. Docs-consistency: pass. Secrets scan:
  **CLEAN**.
- `git status`: no `vault/program` or `vault/math` changes.

## 7. Reproducible demo flow

1. `cd app && yarn dev`; open the printed URL.
2. Connect a Devnet wallet (wallet adapter). Balances shown are the connected
   wallet's ATAs.
3. `cd scripts/devnet && npx tsx keeper_inspect.ts` (read-only) confirms the live
   vault/quote version/author/expiry and that the quote is currently expired.
4. Swap tab: explain fresh vs expired (currently **expired → swaps disabled**).
   The book/price still render from the committed quote; no fabricated price.
5. Vault / Risk / Analytics tabs as above. The historical analytics panel is
   optional and currently absent → shown unavailable.
6. If the public RPC fails, the app fails over to configured fallbacks and reports
   provider errors without exposing secret URLs.

## 8. Remaining prerequisite for live independent-keeper validation

A **funded, non-privileged Devnet keypair** that is neither the configured keeper
`8R3VDePS…` nor the upgrade authority `ddGs6hk5…`. Then a bounded
`keeper_live.ts` run demonstrates an independent keeper committing a quote and
being attributed. (Two-keeper semantics remain proven in LiteSVM.)
