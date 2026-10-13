# KEEPER_LATENCY.md — keeper liveness latency measurements (read-only)

Devnet only. No secrets. No transactions in this measurement (B2 read-only; B3
`DRY_RUN=1`). URLs redacted.

## B2. Endpoint + Hermes latency (n = 33 samples, 1 per ~2 s, 120 s window)

| Metric (ms) | p50 | p90 | p99 | max |
|---|---|---|---|---|
| Hermes fetch (primary) | ~400* | 667 | 1417 | 1417 |
| Hermes publish-age at fetch | 564 | 961 | 1041 | 1041 |
| primary `getLatestBlockhash` | 274 | 951 | 1169 | 1169 |
| primary `getSlot` | 269 | 851 | 919 | 919 |
| **fallback** `getLatestBlockhash` | 108 | 414 | 947 | 947 |
| **fallback** `getSlot` | 105 | 196 | 210 | 210 |

\* Hermes-fetch p50 was not captured in the saved sample; p90/p99 shown.

Findings:
- **The configured primary is slower than the public fallback** for reads
  (`getSlot` p50 269 vs 105; `getLatestBlockhash` p50 274 vs 108).
- A follow-up sampling run hit sustained **HTTP 429** from the configured primary
  (web3.js retried with backoff), i.e. the primary rate-limits under ~0.5 req/s.
- Hermes publish-age at fetch p50 564 ms / p90 961 ms — under the 2 s budget by
  itself, but it consumes a large share of it.

## B3. DRY_RUN pipeline (n = 30 cycles, no transactions sent)

`DRY_RUN=1 ATTEMPTS=30 MAX_FETCH_AGE_MS=100000` (skip disabled to measure).

| Metric (ms) | p50 | p90 | max |
|---|---|---|---|
| Hermes fetch | 319 | 507 | 634 |
| Quote engine (`quote-json`) | 13 | 24 | 65 |
| Publish-age at fetch | 809 | 1290 | 1405 |
| Pre-send total (fetch+engine+getSlot+blockhash+build) | 1517 | 2044 | 2136 |

DRY_RUN does not send, so it cannot time stage/VAA/push. The pre-send path alone
already reaches p50 1.52 s / p90 2.04 s, i.e. at or above the 2 s freshness budget
**before any transaction is sent**.

## Projected critical path vs the deployed rules

Deployed rules (unchanged): freshness **2 s**, stage age **25 slots** (≈ 25 ×
0.25 s = 6.25 s at the measured 0.25 s/slot).

Critical path = publish-age at fetch + (fetch→push send/confirm). From S2-29 chain
measurements (blockTime − publish_time) the full staged pipeline landed at **3–8 s**
(p50 ≈ 4 s) with the same 3-transaction flow; B2 shows confirm/landing latency
dominates (RPC p90 ~0.9–1.2 s per call, and the pipeline needs ≥2 sequential
confirm rounds).

**Largest single contributor: transaction confirmation/landing latency (RPC), not
Hermes or the quote engine.** The stage-age limit (6.25 s) is generally met; the
**2 s freshness limit is not** under these conditions.

## Implications for Task C (keeper-side, safety-neutral)

- The measurements justify: (i) confirming via fast `getSignatureStatuses` polling
  (already done, S2-29), (ii) skipping updates already older than a threshold at
  send time (already done, `MAX_FETCH_AGE_MS`), (iii) preferring the faster
  same-cluster endpoint for reads.
- They do **not** justify any change to on-chain freshness/confidence/anchor/expiry.
- Even the best case (fetch-age ~0.3 s + one confirm round ~0.5 s) is close to the
  2 s line; two confirm rounds exceed it.

Sample sizes are small (33 and 30); treat percentiles as indicative, not
statistical guarantees. The 429 behaviour is qualitative evidence.
