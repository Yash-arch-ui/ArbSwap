# S2-36 — Independent Diagnosis: the 0/85 Fresh-Quote Observation Gap

Status: **root cause identified with evidence and fixed on branch
`s2-36-fresh-quote-diagnosis`.** The frontend now observes genuinely fresh quotes
and never renders a stale quote as live. **Not pushed.** No keeper/swap/gating
file, on-chain state, expiry or freshness rule was changed.

## 1. Root cause

The frontend did **not** lag because the chain had no fresh quote. It lagged
because the quote was read as one field of a single slow, adaptive poll
(`ProtocolContext.refreshProtocol` → `readVault`: vault + 2 reserves + quote +
config, then `getSlot`, cluster/program verify, tickets, blocktime), and the
*freshness status was frozen at the slot captured during that read*. Consequences,
all observed:

1. **Behind the chain.** While the chain held a fresh quote, the UI still showed
   the previous version as `EXPIRED`. Timestamped correlation (same clock, browser
   DOM vs a `confirmed` RPC read):
   ```
   05:15:11.004  chain v111 slot 510878077 exp 510878086 FRESH
                 browser v110 slot 510878057 exp 510877978 EXPIRED
   05:15:20.578  chain v112 slot 510878116 exp 510878125 FRESH
                 browser v111 slot 510878104 exp 510878086 EXPIRED
   ```
2. **Ahead of expiry.** Once displayed, `Fresh` froze: the same version kept
   showing `Fresh` for ~5 s after it had already expired on-chain
   (`05:15:22–25` browser v112 `Fresh` while chain slot > exp).
3. **Cadence.** With the slow poll plus adaptive backoff, the UI's slot advanced
   in ~8 s steps, versus a ~3 s fresh window.

Aggregate proof (110 s run, keeper committing, 157 chain samples / 194 browser
samples):

| Metric | Before fix |
|---|---|
| Browser samples showing fresh | 0 / 85 (earlier run) |
| Browser samples while chain **was** fresh | 19 |
| …that showed fresh | **2 / 19** |
| Classified mismatches (browser vs chain) | **22** |

This is a **frontend observation** defect, not a keeper or protocol defect.

## 2. Live-state semantics verified

Read-only probe `scripts/devnet/fresh_quote_probe.ts` (added) reads QuoteState at
`processed` and `confirmed` and classifies exactly as each consumer does.
Confirmed on-chain (2026-10-14, Helius):

- `Config`: `expiry_slots = 10`, `grace_slots = 0`, `max_staleness_seconds = 2`,
  `max_conf_bps = 10`, `fee_bps = 1`.
- Program `2mwpYHpZ…` ELF `772256 B sha256=0cdf9575…` == HEAD build (**MATCH**).
- `QuoteState` readable and fresh by `processed` **and** `confirmed`
  (e.g. commit → `rem_conf = 10`, `status = Fresh`); a readable quote is distinct
  from a fresh one.
- The keeper committed **v77→v117** across runs with `COMMITTED_AND_VERIFIED`
  (e.g. v78 `3bWpwRgW…`, v92 `4NcFkqY8…`, v115 `…`), author `8R3V…`.

## 3. Fix — a live quote feed (safety-preserving)

The quote now has its **own** fast feed, decoupled from the vault/config read:

- `app/src/chain/liveQuote.ts` (new) — pure `classifyQuoteFreshness` +
  `LiveQuoteFeed`. Reads QuoteState at the **`processed`** commitment (the
  commitment the program uses for freshness) with one lightweight RPC per tick
  (~700 ms), recomputes status against the **current** slot every tick, ignores
  out-of-order/regressing slots, and on a transient error **retains** the last
  value but still re-classifies by slot, so a stale quote can never be
  `executable`.
- `app/src/chain/program.ts` — `fetchQuoteOnly` (single-account `processed`
  read) and shared `mapQuote`; `fetchFreshQuote` now reads at `processed`.
- `app/src/chain/rpcFailover.ts` — `APP_LIVE_RPC` (processed-commitment failover).
- `app/src/context/ProtocolContext.tsx` — the feed owns
  `quoteState`/`quoteAvailable`/`quoteFresh`/`currentSlot`; the slow vault poll no
  longer writes quote freshness.

The submit-time re-read (`fetchFreshQuote` + `submitFreshnessReason`) from S2-35
is unchanged, so execution still validates against the live quote version and
current slot.

Explicitly **not** done: no expiry extension, no changed freshness/confidence/
stage-age rules, no keeper or program change, no redeploy.

## 4. Result after fix (same methodology)

| Metric | Before | After |
|---|---|---|
| Browser samples while chain fresh | 19 | 15 |
| …that showed fresh | 2 | **14 / 15** |
| Browser fresh samples (whole run) | 0 / 85 | **15 / 194** |
| Classified mismatches | 22 | **2** (≤ one 700 ms poll interval) |

Browser rendered `6-LEVEL ACTIVE BOOK` on chain versions 115/116/117 while fresh
and flipped to `EXPIRED` once the window passed.

## 5. Tests / validation (actual)

- `app/test/liveQuote.test.ts` (new, +7): new version observed; `Fresh`→`Expired`
  on slot advance; `Unavailable` for absent/undecodable; out-of-order slot
  ignored; transient RPC error retained but never executable; recovery.
- `yarn test`: **99 passed (10 files)**; `npx tsc -b` clean; `yarn lint` clean;
  `yarn build` clean (no `helius`/`api-key` in `dist`).
- Browser E2E `node app/e2e/browser-smoke.mjs`: **exit 0** (0 exceptions/console
  errors; `modeBadge: true`, `readOnlyBanner: false`, `swapHonestState: true`).
- Read-only only: no sign/swap/deploy; no on-chain change.

## 6. Wallet connection via extension — code is correct; environment lacks one

The wallet path is implemented correctly: `app/src/chain/WalletProvider.tsx`
registers `PhantomWalletAdapter` + `SolflareWalletAdapter` with `autoConnect`, and
`SwapPage`/`VaultPage` sign with the **connected adapter** (`getProgram(connection,
wallet)`); no server/CLI key is ever substituted, and no private material is in the
bundle. In this headless container there is **no browser wallet extension**, so a
real signature cannot be produced here; it is not a code defect. On a desktop
browser with Phantom/Solflare on Devnet the connect → build → sign → send flow is
wired end to end.

## 7. Remaining limitation (not fixed by this task)

The frontend is now *always live*, but a quote is only `Fresh` for `expiry_slots
= 10` (~3 s), and the keeper's 3-tx `stage → VAA → push+commit` pipeline cannot
beat the deployed 2 s oracle rule continuously, so commits are intermittent and
the UI correctly shows `EXPIRED` between them. Making the book *always fresh*
requires the smallest correct architecture change (collapse push+commit into one
packet) and a redeploy — out of scope and not performed. No rule was weakened.

## 8. Deliverables & boundary

- New: `docs/S2_36_FRESH_QUOTE_OBSERVATION.md`,
  `app/src/chain/liveQuote.ts`, `app/test/liveQuote.test.ts`,
  `scripts/devnet/fresh_quote_probe.ts`.
- Changed: `app/src/chain/program.ts`, `app/src/chain/rpcFailover.ts`,
  `app/src/context/ProtocolContext.tsx`, `docs/PROGRESS.md`.
- Branch `s2-36-fresh-quote-diagnosis`; **not pushed**; no deploy, no swap, no
  config/oracle change.
