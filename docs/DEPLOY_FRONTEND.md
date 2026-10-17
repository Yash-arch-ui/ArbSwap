# DEPLOY_FRONTEND.md — deploy the ArbSwap dApp to Vercel (click-by-click)

Operator-run guide. Devnet only. No secret may enter any `VITE_*` variable: Vite
inlines `VITE_*` values into the **public** bundle, so a keyed RPC URL there is a
public leak (this happened once and is fixed — see `docs/DECISIONS.md` D-010).

## 0. Preconditions (verify locally first)

```bash
cd app
yarn install
yarn lint && yarn test && yarn build      # all green
# the built bundle must contain no provider key:
grep -rE "api-key=|helius-rpc" dist && echo "LEAK" || echo "dist clean"
grep -roE "https://api\.devnet\.solana\.com" dist/assets/*.js | head -1   # public endpoint present
```

## 1. What gets deployed

| Field | Value |
|---|---|
| Root directory | `app` |
| Framework preset | Vite |
| Build command | `yarn build` (already in `app/vercel.json`) |
| Output directory | `dist` (already in `app/vercel.json`) |
| Install command | `yarn install` |
| Node | 20.x or 22.x |
| Headers / CSP | applied from `app/vercel.json` at the edge |

## 2. Import the project (Vercel dashboard)

1. **Add New… → Project**.
2. **Import Git Repository** → pick the ArbSwap repo.
3. **Root Directory** → **Edit** → set to **`app`**. (Without this the build runs
   from the repo root and fails.)
4. Framework Preset should auto-detect **Vite**. Confirm Build = `yarn build`,
   Output = `dist`.
5. **Environment Variables** — set these for **Production** (and Preview):

   | Name | Value | Notes |
   |---|---|---|
   | `VITE_ARBSWAP_CLUSTER` | `devnet` | selects the cluster |
   | `VITE_ARBSWAP_MODE` | `trade` | on-chain trade mode |
   | `VITE_SOLANA_RPC_URL` | `https://api.devnet.solana.com` | **public; never a keyed URL** |
   | `VITE_SOLANA_RPC_FALLBACKS` | `https://api.devnet.solana.com` | failover list |

   **Do NOT** set any `VITE_*` variable to a URL containing `api-key=`/`api_key=`.
   If a keyed provider is ever required it must be a separate, restricted,
   browser-scoped key (see `docs/WEB_ASSUMPTIONS.md`), and `app/vercel.json`'s
   CSP `connect-src` must list that provider host.

6. **Deploy**.

## 3. Branch selection

- Default production branch: whichever branch you want live. To preview this
  work, set the **Production Branch** to `deposit-withdraw` (or merge it first),
  or open a **Preview** deployment for the branch. The IDL and program are
  devnet-ready; the browser talks to the devnet program `2mwpYHpZ…`.

## 4. Post-deploy checks

1. Open the deployment URL; open **DevTools → Network**: the first RPC call must
   go to `api.devnet.solana.com` (not a keyed host).
2. **DevTools → Application → Cookies/Local Storage**: no secrets.
3. **View Source** is not enough (SPA); instead search the network-loaded JS for
   `api-key=` (should be absent).
4. Connect a wallet, confirm the cluster banner reads **devnet**, and confirm the
   Risk/Overview page shows live on-chain state (QuoteState version advancing).
5. Check response headers (DevTools → Network → the document request):
   `Content-Security-Policy`, `X-Frame-Options: DENY`,
   `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
   `Permissions-Policy`, `Strict-Transport-Security`.

## 5. Security headers (already in `app/vercel.json`)

- `Content-Security-Policy`: `default-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`; `script-src 'self' 'unsafe-inline'` and
  `style-src 'self' 'unsafe-inline'` (wallet-provider injection needs the
  script exception — `docs/DECISIONS.md` D-013); **no `unsafe-eval`**;
  `connect-src` limited to `*.solana.com`, `*.helius-rpc.com`,
  `*.pyth.network`, `hermes.pyth.network` (+ wss).
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` (camera/mic/geo/payment denied),
  `Strict-Transport-Security`.

> Note: if you switch to a non-listed RPC provider, add its host to the CSP
> `connect-src` list in `app/vercel.json` or the browser will block the calls.

## 6. Rollback

Redeploy a previous commit from the Vercel **Deployments** tab → **⋯ → Redeploy**
(pin to the last known-good commit). Frontend-only; no on-chain action needed.
