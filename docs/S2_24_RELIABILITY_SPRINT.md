# S2-24 — Reliability sprint (confidence boundary, pipeline, RPC failover, frontend)

Status: **local changes + bounded live quote maintenance. No swaps/asset movement.**
Builds on the deployed S2-23 release (upgrade + QuoteState migration verified).

## 1. Confidence-boundary depth fix (keeper engine)

**Root cause (verified):** `compute_quote` in `vault/keeper/src/lib.rs` set
`confidence_factor = BPS - conf*BPS/confidence_max_bps`, which is exactly **0** at
`conf == confidence_max_bps` (10). The deployed program **accepts** `conf <= 10`
(`max_conf_bps = 10`), so every observation at the cap produced depth 0 and was
dropped — the dominant reason a keeper could not quote when Pyth confidence sat at
the cap.

**Fix:** added `KeeperParams.confidence_floor_bps` (default `1_000` = 10%) and made
the throttle ramp from full depth at `conf = 0` down to the floor at the cap —
never to zero:

```
factor = floor + (BPS - min(conf*BPS/max, BPS)) * (BPS - floor) / BPS
```

At `conf = 0` → `BPS`; at `conf >= max` → `floor`. No protocol parameter changed;
the program still rejects `conf > max` via its own check. The keeper does not
fabricate confidence and does not force depth where no valid ladder exists (a
positive floor still yields `liquidity > 0` per level and stays inside the
utilization cap).

**Test:** `confidence_at_the_deployed_cap_still_quotes_conservatively` asserts a
quote exists at `conf == 10` with `depth_mult_bps == 1_000` and positive per-level
liquidity, that `conf == 9` is strictly deeper, and that `conf == 11` clamps to the
same floor. Keeper unit tests: **45 passed**.

## 2. Staged-quote pipeline fixes (`scripts/devnet/keeper_live.ts`)

- **Fresh blockhash for the push tx:** the stage/vaa/push txs previously shared one
  blockhash; under load the push expired (`block height exceeded`). The push+commit
  tx now fetches its own recent blockhash.
- **Ambiguous confirmation handling:** on a `confirmTransaction` timeout the keeper
  now inspects the signature (`getSignatureStatuses`) and only treats it as failed
  if it is missing/errored/not confirmed — instead of aborting an attempt whose
  stage/vaa already finalized.
- These are keeper-side only; no on-chain freshness or pending-age rule changed.

**Measured effect (bounded live run, 180 s, configured keeper `8R3V…`):** the
quote advanced **v24 → v28** with **16 `COMMITTED_AND_VERIFIED`** cycles; earlier
S2-23 runs landed 0–1 commits in 240–360 s. Sample is a single 180 s window on the
public RPC (not a statistical benchmark).

## 3. RPC failover (Node + browser)

- **Node** (`scripts/devnet/rpc.ts`, 23 tests) — unchanged this task, re-verified.
- **Browser (new):** `app/src/chain/rpcFailover.ts` + `app/test/rpcFailover.test.ts`
  (5 tests). `RpcFailover` orders the resolved endpoints, retries transport
  failures (`rate_limited`/`timeout`/`http`/`network`) with bounded backoff and
  fails over to the next endpoint; `unknown` (program) errors are rethrown
  immediately. `activeEndpoint` is redacted. Wired into `ProtocolContext`'s read
  path (`fetchProtocolState`, `getSlot`, `loadWalletBalances`, share/ticket reads)
  so a failing primary actually falls back.
- Cluster mixing is prevented in the config layer (`rpcConfig.ts`); no secrets in
  browser env.

## 4. Frontend / backend integration

- **Keeper-claim workflow (new):** `fetchKeeperReward`/`claimKeeperReward` in
  `app/src/chain/program.ts` + `app/src/components/KeeperRewards.tsx`, rendered on
  `RiskPage`. It shows the **connected** wallet's own `KeeperReward`
  (`[b"reward", vault, wallet]`) and claims it; non-keepers show "nothing to
  claim"; RPC/tx errors are surfaced; it never assigns another keeper's reward or a
  keeper to an unattributed legacy quote.
- **`app/.env.example`** added (placeholders only, no credentials).
- **Analytics export:** `simulation/analytics/export.py` no longer claims the SPA
  consumes `app/public/analytics/onchain.json`; it is documented as standalone
  historical tooling (the SPA reads `/artifacts/*` + live on-chain state). Tracked
  in `docs/INTEGRATION_GAPS.md`.
- **`docs/INTEGRATION.md`** reconciled: a prominent S2-24 banner plus corrected
  §8 (`QuoteUpdate`/`LevelUpdate` no longer carry `oracle_price`/`inv_lo`/`inv_hi`;
  staged lifecycle noted) and §9 (`swap` now requires `keeper_reward` +
  `system_program`; added `claim_keeper_reward`).

## 5. Reward / attribution (verified, no live swap)

Local program tests (unchanged from S2-20/S2-21A) prove: a legacy unattributed
quote cannot generate rewards (`UnattributedQuote`); a committed quote records its
signer; a swap credits `quote_state.keeper`'s reward PDA; one keeper cannot claim
another's accrual; replacing the quote does not move prior accrual. **No swap or
claim was executed on Devnet.**

## 6. Independent keeper — prerequisite (unmet)

Available funded keypairs: `8R3VDePS…` (the configured keeper/admin) and
`ddGs6hk5…` (the **upgrade authority**). `EHjXVWjj…` (program keypair) has 0 SOL.
There is **no funded, non-privileged, independent keeper wallet** available.
Per the task, I did not substitute the admin or upgrade-authority wallet and call
it independent, and did not generate/fund a new key.

**Exact prerequisite:** provide a funded Devnet keypair that is neither `8R3V…` nor
`ddGs6hk5…`; then a bounded run of the same `keeper_live.ts` will demonstrate an
independent keeper committing a quote (its own pending PDA, attribution to its
public key). Two-keeper semantics remain proven in LiteSVM.

## 7. Live Devnet results (this session)

- QuoteState `5MsGbdHv…`: **897 B**, current layout, author `8R3V…`,
  `unattributed: false`, vault status Active.
- Quote advanced to **v28** during the bounded run; e.g. push+commit
  `2wMaVpX4VsGnDTMcpzcaK1xsoNVCxkSi3P89eYdtbABCPTemNdTRdvS5FkjGAfsa2VXvpcZFr7cJcRHmqAhG2pPN`
  (v25 → v26) and `5tQwK16nWevWnQWXzZKCZa7JbFXcFJtLmTtpPDi9uLZr7nkWwHTcB9YnRiZp4DJdVvXAf157VUG3sFv5MPQWptDZ`
  (v26 → v27).
- **No swap executed** (`swap_executed`/`buybase_preflight` count 0); only Pyth
  pushes and `stage_quote`/`commit_quote`.

## 8. Remaining blockers / limitations

- No independent funded non-privileged keeper wallet (the one unmet prerequisite).
- Public Devnet RPC remains intermittently slow; the 2 s freshness + 25-slot
  pending-age window stays tight (mitigated by the pipeline fixes; not eliminated).
- Admin/upgrade centralization unchanged (single-key upgrade authority,
  discretionary slashing, timelocked params/claims).
- Browser failover covers the app's read path; the wallet-adapter's own connection
  still uses the primary endpoint for signing.

## 9. Local vs Devnet

- **Devnet-proven:** deployed program = local artifact (hash MATCH, S2-23);
  QuoteState migrated 897 B; reliable quote maintenance (v24→v28) by the
  configured keeper with correct attribution; no asset movement.
- **Local-only:** confidence-boundary fix + test; pipeline/confirm fixes; RPC
  failover (Node + browser) and tests; keeper-claim frontend; docs. The independent
  keeper is proven only in LiteSVM.
