# S2-28 — Independent keeper provisioning + live permissionless quote test

Status: **keeper provisioned; live independent commit BLOCKED by Devnet faucet
exhaustion.** No protocol/config change, no swap/asset movement, no push.

## 1. Preflight (read-only, verified)

| Item | Value |
|---|---|
| Cluster | Devnet, genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| Program | `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` |
| Deployed ELF vs local artifact | **MATCH** (sha256 `b4df2b0f…`, 769984 B) |
| Upgrade authority | `ddGs6hk5E4oPzSnwFfX4pD4DDhDTLTwRddv1VQym7bH` |
| Vault | `8yvFBv9…82XPt`, status **Active** |
| Config | `ErVDFAH…Eo2aT`, **`min_bond = 0`** → permissionless quoting |
| QuoteState | `5MsGbdHv…TYAgG`, **897 B** current layout, quote **v28**, author `8R3V…`, expired |
| Keeper A (`8R3V…`) | 11.512 SOL |
| Upgrade authority (`ddGs…`) | 0.467 SOL |

The deployed program supports permissionless keeper participation and
`QuoteState.keeper` attribution — no mismatch, so live testing was permitted.

## 2. Independent keeper provisioned

- Generated with `solana-keygen new --no-bip39-passphrase`, exclusive create, mode
  **0600**, at `~/.config/solana/arbswap-independent-keeper.json` (no existing file
  was overwritten; secrets were never printed).
- **Public key: `6FqSc5vm9vdVDLRVbJZ9cYx4Mh4sVtCpM5x6qaLknB2G`** (distinct from
  `8R3V…` and `ddGs…`).
- Derived PDAs: pending_quote `CmzQCPp7iZsoq1KC5KVkFysMe5gGWRu9CDYg4S5Qq45s`,
  keeper_reward `4HYf18ncVxbJx9onax9A3tTTQXL23woGxzWHzJV2niKt`.

## 3. Funding — BLOCKED (exact evidence)

The official Devnet faucet is exhausted/rate-limited for this environment:

```
solana airdrop 2|1|0.5|0.1 6FqSc5… -u https://api.devnet.solana.com
  -> Error: airdrop request failed. This can happen when the rate limit is reached.
RPC requestAirdrop -> {"code":429,"message":"You've either reached your airdrop
  limit today or the airdrop faucet has run dry. Please visit https://faucet.solana.com"}
```

Keeper B balance: **0 SOL**. The web faucet (`faucet.solana.com`) is a captcha UI,
not an API, and is the same pool.

**The task forbids funding from existing wallets** ("Do not transfer funds from
existing wallets"). Therefore the live independent-keeper commit could not be
executed without violating the authorization boundary. Keeper B is retained
unfunded.

## 4. What was proven locally (not a substitute for the live proof)

- **Two-keeper LiteSVM (real program instructions):** 100 lifecycle tests pass,
  including `two_independent_keepers_stage_without_interference`,
  `keeper_attribution_is_isolated_across_two_keepers`,
  `permissionless_quote_maintenance_by_non_configured_keeper`,
  `independent_keeper_recovers_expired_quote_after_large_jump`,
  `params_update_cannot_change_keeper_eligibility`.
- **Frontend attribution (mocked):** `app/test/integration.test.ts` now asserts a
  quote authored by `6FqSc5…` surfaces that public key and never `config.keeper`;
  a disconnected/unrelated wallet is never assigned it. Frontend suite **54 tests**.

## 5. Exact next step (requires the faucet to recover or separate authorization)

1. Fund `6FqSc5vm9vdVDLRVbJZ9cYx4Mh4sVtCpM5x6qaLknB2G` from the official Devnet
   faucet (or a separately authorized transfer).
2. `cd scripts/devnet && set -a; . ../../.ENV; set +a; \
   ARBSWAP_KEYPAIR=$HOME/.config/solana/arbswap-independent-keeper.json \
   NODE_OPTIONS=--no-network-family-autoselection ATTEMPTS=100000 RUN_SECONDS=240 \
   SIMULATE_SWAP=0 npx tsx keeper_live.ts`
3. Verify a confirmed commit with `QuoteState.version` strictly advanced and
   `QuoteState.keeper == 6FqSc5…`; then alternate Keeper A to prove no single
   keeper is required. (Recovery-by-another-keeper and large-jump behavior remain
   proven in LiteSVM; live recovery requires a qualifying market move.)

## 6. Boundaries respected

No deployment/upgrade, migration, config/oracle/authority change, swap, deposit,
withdrawal, claim, transfer, mint, or faucet bypass. No secrets printed. No push.

---

## Update — Keeper B funded, live attempts run (blocked by freshness)

The operator funded Keeper B: **balance 5 SOL** (verified read-only). The live
independent-keeper test was then executed with the existing pipeline:

- **Keeper B (`6FqSc5…`)**, three bounded windows (240 s + 300 s + 300 s): **0
  commits**. Failures: `InvalidOracle` (6015, freshness), `StalePendingQuote`
  (6039, stage age > 25 slots), `UpdateSlotTooOld` (6037). Measured Hermes
  `publish_time` age at fetch ranged **748 ms – 2994 ms**.
- **Keeper A (`8R3V…`)**, 180 s control run under the same conditions: **0
  commits** — confirming the blocker is **not Keeper-B-specific**.

Root cause: the deployed **2 s freshness rule** plus the 3-transaction staged
pipeline (stage + Wormhole VAA + Pyth push/commit) exceeds 2 s under current
public-RPC/Hermes latency. The on-chain rule was **not** changed. Earlier (S2-24)
the same keeper code committed 16 quotes in 180 s when the network was faster, so
this is provider/market-condition dependent.

Final read-only state (unchanged): QuoteState **v28**, author `8R3V…`, expiry
510667289, **897 B**, `min_bond = 0`, vault Active. Keeper B balance 4.9047847 SOL
(fees/rent spent on attempts); Keeper A 11.492523307 SOL. No swap, deposit,
withdrawal, claim, transfer, mint, config, oracle, or authority change; no push.

**Conclusion:** the independent keeper is **provisioned and funded**, but the
**live independent-commit proof is INCOMPLETE** — blocked by the same provider
freshness constraint that currently affects every keeper. It is not a
decentralization or authorization defect (permissionless `min_bond=0` and
`QuoteState.keeper` attribution are confirmed on-chain).

### Compatible remediations (separately authorized)
1. Retry when the network is fast / Hermes is fresh (as in S2-24).
2. Use a lower-latency dedicated RPC + co-located Hermes to meet the 2 s window.
3. A keeper-side latency reduction is possible but did not prove sufficient here;
   the on-chain rule must not be weakened.

---

## S2-29 — RPC latency optimization + bounded live attempt

### Configured endpoints
Only **one** RPC is configured: `.ENV` contains `PYTH_API_KEY` only (no
`ARBSWAP_RPC_URL`/`ARBSWAP_RPC_FALLBACKS`), so the keeper uses the default
`https://api.devnet.solana.com` (genesis verified `EtWTRABZ…pkrZBG`). No other
authorized endpoint is available; no credentials were invented.

### Measurements (read-only, bounded samples)
- Hermes fetch: p50 438 ms / p90 1125 ms; **publish-age at fetch p50 665 ms /
  p90 1242 ms / max 1278 ms**.
- RPC `getLatestBlockhash` p50 204 ms / p90 585 ms; `getSlot` p50 205 ms / p90
  614 ms.
- **End-to-end pipeline (publish_time → push+commit execution, from chain
  `blockTime`): 3–8 s** across attempts (e.g. 672 ms fetch-age → 3 s commit;
  450 ms → 8 s). The 3-transaction staged pipeline (stage + Wormhole VAA + Pyth
  push/commit) plus public-RPC landing latency dominates.

### Keeper changes (local, safety-neutral)
- Skip an attempt when the Hermes update is already older than `MAX_FETCH_AGE_MS`
  (default 1000) — never spend a tx on a doomed update.
- Confirm via bounded fast `getSignatureStatuses` polling instead of
  `confirmTransaction` (websocket fallback was slow).

### Bounded live attempt — Keeper B
12 attempts / 180 s with `ARBSWAP_KEYPAIR=…arbswap-independent-keeper.json`:
**0 commits**. Failures: `InvalidOracle` (6015), `UpdateSlotTooOld` (6037),
`StalePendingQuote` (6039). Example failed signatures + measured commit ages:
`3oB4JcuR…` (3 s), `55CTT3Te…` (4 s), `5d57rhds…` (5 s), `2B2yYe5d…` (8 s),
`3ccfzm1c…` (8 s). No quote could be committed.

### Verdict
**Live gate: INCOMPLETE — PROVIDER/PYTH LATENCY.** The configured provider cannot
reliably satisfy the deployed 2 s freshness rule for the 3-tx staged pipeline
(3–8 s observed). Keeper A fails identically, so this is not Keeper-B-specific.
The on-chain limits were **not** weakened. QuoteState remains **v28**, author
`8R3V…`, 897 B, `min_bond=0`, vault Active; no swap/asset movement, no config/
oracle/authority change.

### Required to pass (separately authorized)
A lower-latency dedicated Devnet RPC (and/or co-located Hermes) such that
publish_time → commit execution < ~1.5 s. Configure via `ARBSWAP_RPC_URL` /
`ARBSWAP_RPC_FALLBACKS`; the keeper already honours them.
