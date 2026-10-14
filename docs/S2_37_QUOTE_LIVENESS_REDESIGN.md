# S2-37 — Quote Liveness Architecture Redesign

Status: **diagnosis complete and quantified; no program, keeper, config or IDL
change made; no deploy; not pushed.** The measured evidence shows the current
3-transaction design cannot present a *reliably* fresh, executable quote on the
available infrastructure. The conservative local optimizations are already in place; the
remaining fixes are a policy decision (quote lifetime) or a program redesign —
both require separate explicit approval. The live browser swap remains unproven
and is **not** claimed.

## 0. Current state re-verified (2026-10-14, Helius Devnet)

Read-only only (`scripts/devnet/preflight.ts`, `devnet_program_hash.py`):

- Cluster genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` (Devnet).
- Program `2mwpYHpZ…`, owner `BPFLoaderUpgradeab1e…`; on-chain ELF
  `772256 B sha256=0cdf9575…` == HEAD `target/deploy/arbswap.so` (**MATCH**).
- Vault `8yvFBv9…` Active, `total_shares 108,980,882`; reserves `0.313621726`
  WSOL / `37.75` USDC.
- Config: `fee_bps 1`, `expiry_slots 10`, `grace_slots 0`,
  `max_staleness_seconds 2`, `max_conf_bps 10`, `min_bond 0`, keeper `8R3V…`.
- Operator `8R3V…`: ~11.2 SOL, `0.25` WSOL, `2.25` USDC.
- `QuoteState` advanced continuously across sessions (v77→v119 observed).

## 1. Measured pipeline timings and root cause (Phase 1)

Instrumentation already emitted by `keeper_live.ts` (30 timed cycles aggregated
across bounded runs; Helius primary + public fallback):

| Stage | p50 | p90 | max |
|---|---|---|---|
| Hermes fetch (`hermes_ms`) | 417 ms | 1,299 ms | 1,319 ms |
| Quote engine (`engine_ms`) | 9 ms | 12 ms | 30 ms |
| **Update age at fetch** (`fetch_age_ms`) | **1,013 ms** | **1,410 ms** | 1,455 ms |
| `stage_quote` confirm | 796 ms | 1,124 ms | 1,334 ms |
| Wormhole VAA confirm | 858 ms | 1,163 ms | 1,541 ms |
| push+`commit_quote` confirm | 865 ms | **9,313 ms** | 9,768 ms |
| **Age at commit** (`blockTime−publish_time`) | **2,000 ms** | **3,000 ms** | 3,000 ms |

Outcomes across runs: **44 `COMMITTED_AND_VERIFIED` vs 8 committed-but-already-
expired**, plus `6015 InvalidOracle` and `6037 UpdateSlotTooOld` failures; one
50 s run produced **150 attempts, 69 skipped** (update already too old), **6
verified commits** (≈ 1 commit / 25 s).

**Which timestamp controls freshness.** The program compares the Pyth feed's
`publish_time` (carried in the staged payload and re-checked against the posted
price account) with the **on-chain `Clock::unix_timestamp` at `commit_quote`
execution**, requiring `≤ Config.max_staleness_seconds` (2 s). It is *not* wall
time and *not* the frontend clock. The cluster clock lags wall/block time by
~1 s, which is why several commits measured at `age_at_commit = 3,000 ms`
by block time still passed on-chain.

**Why the publication becomes too old.** The wall path from a Pyth publication to
an accepted commit is `age_at_fetch + VAA/stage + push+commit`:

```
~1.0 s (update already old at fetch, p50)
+ ~0.9 s (VAA; stage overlaps concurrently)
+ ~0.9 s (push + commit, one atomic tx)
≈ 2.8 s wall   >   2.0 s cluster rule  (with ~1 s clock-lag slack: marginal)
```

With `expiry_slots = 10` and Devnet slot time ≈ 0.29–0.6 s, a committed quote is
executable for only **~2.5–3 s**. The keeper's commit interval is ~10–25 s, so the
book is genuinely fresh only ~10–15 % of the time. A user cannot be expected to
land inside a ~3 s window that opens at an unpredictable moment.

**Five distinct notions, kept separate** (do not conflate):

1. **Account readable** — `fetchProtocolState`/`fetchQuoteOnly` decode succeeded.
2. **Oracle fresh at commit** — `clock − publish_time ≤ 2 s` at `commit_quote`.
3. **Quote valid at swap** — `slot < expiry_slot` **and** `version ≥ min_version`
   **and** attributed keeper; the 2 s oracle rule is *not* re-checked at swap.
4. **Frontend observed fresh** — the live `LiveQuoteFeed` saw `slot < expiry_slot`
   (S2-36; verified).
5. **Wallet signed + confirmed** — not demonstrated here.

## 2. Architecture options (Phase 2)

| Option | Txn count / size | Critical-path latency | Freshness margin | Risk |
|---|---|---|---|---|
| **A. Keeper/RPC optimization** (already largely done: concurrent Hermes/slot/blockhash, one blockhash, first-accepted multi-endpoint broadcast, `processed` reads, bounded backoff) | 3 tx: stage ~300 B, VAA ~700 B, push+commit 573–900 B | hermes(0.4–1.3 s) + VAA(0.86 s) + push(0.87 s) | p50 ≈ 0–0.5 s; p90 negative | none to protocol |
| **B. Sequencing** — move stage/VAA earlier | same 3 tx | stage already overlaps VAA; push must follow VAA, and commit must follow stage | ~0 | low |
| **C. Quote lifetime** (`expiry_slots`) | 0 tx | unchanged | window 10→e.g. 40 slots ⇒ ~12 s | **market-risk**: swap does not re-check oracle age, so a longer expiry lets a trader fill against a quote priced from a >2 s-old oracle → more adverse selection/LVR. Needs explicit policy approval + parameter-change (timelocked) tx. |
| **D. Program redesign** — single-tx commit, or keeper-signed price feed | 1–2 tx | remove the VAA round trip ⇒ ≈1.4 s saved | +1.4 s | program upgrade, IDL/migration, redeploy |

**Verified, not assumed:** push and `commit_quote` are **already atomic** — the
final transaction is `[Pyth updatePriceFeed, ArbSwap commit_quote]` (see
`keeper_live.ts` pushTx). Option D's premise ("collapse push+commit") is already
satisfied; the residual cost is the **separate `stage_quote` + Wormhole VAA**
confirmations, which must precede it.

## 3. Selected solution (Phase 3)

**No local-only change reliably fixes liveness.** Options A and B are already
implemented (the keeper is at its practical floor) and B's ordering constraints
are hard. The smallest *correct* options are:

- **C (recommended, needs approval):** raise `expiry_slots` enough to give a
  realistic execution window while keeping the 2 s oracle rule at commit. This is
  a parameter change via the timelocked admin path, not a code change.
- **D (if a hard guarantee is required):** keep the deployed price account hot
  without a per-commit VAA (e.g. collapse stage+push+commit, or an
  oracle-forwarder) — requires a clean SBF rebuild, IDL check, redeploy and a
  migration/compatibility assessment.

I did **not** apply C or D. No rule, expiry, freshness, confidence, stage-age,
anchor/ladder/inventory/flow/edge limit, attribution, replay protection or token
math was changed. `docs/S2_36`'s frontend live-feed fix is preserved and remains
the reason the UI is no longer stale.

## 4. Tests / evidence (Phase 4)

- `cargo test --workspace` green; `pytest simulation` 228 passed / 2 skipped;
  keeper TS 17/9/24; app 99 tests; `cargo fmt`/`clippy` clean; browser E2E exit 0
  (S2-36). No source changed in this task, so these remain valid.
- **Expiry gate proven by simulation (read-only):**
  `scripts/devnet/swap_preflight.ts` builds the real BuyBase swap and
  `simulateTransaction` returns `QuoteExpired (6030)` when the active quote is
  past its slot — a stale/expired quote remains unusable.
- **Fresh-window not single-shot reachable:** 18/18 consecutive preflight
  invocations (each ~2.5 s of CLI + RPC latency) read the quote already expired;
  the keeper committed only v118→v119 over ~50 s. The fresh window (~2.5 s) is
  shorter than one probe's latency and opens only every ~25 s.
- Timing distribution (p50/p90/max) is §1; failure categories `6015`/`6037`
  remained, no guard was relaxed.

## 5. Read-only swap preflight for the next stage (Phase 5)

`RPC_URL=$ARBSWAP_RPC_URL npx tsx swap_preflight.ts` (simulate only, never sends):

```json
{
  "side": "buyBase",
  "amount_in_atoms": "500000",            // 0.5 USDC
  "fee_bps": 1, "fee_atoms": "50", "net_in_atoms": "499950",
  "expected_out_atoms": "4658847",        // ≈ 0.004658847 WSOL @ oracle
  "min_out_atoms": "4635552",             // 0.5% slippage floor
  "slippage_bps": 50,
  "quote_version": "118", "quote_expiry_slot": "510894840",
  "current_slot": "510894887", "quote_expired": true,
  "accounts": {
    "trader": "8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH",
    "vault": "8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt",
    "config": "ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT",
    "quote_state": "5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG",
    "base_reserve": "8vfr2KmMmXYUTjRg5cAiSYD6EhN1d8pjJnmFC95E2vfm",
    "quote_reserve": "G8q1WMKT8fnGQh85kCB8Aihf6F7tctXJDKbA6gn1jPeS",
    "trader_base": "5MpRjKvzgW5C7x8sbam4KgA5KGkGyTKNCXarbqZceCnJ",
    "trader_quote": "5SThVCCb6vrvvkwSMukanW5vWkUehBCVW8iT53KqVzgV",
    "token_program": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  },
  "tx_size_bytes": 573,
  "simulation_err": { "InstructionError": [1, { "Custom": 6030 }] },
  "simulation_logs_tail": [ "... Error Code: QuoteExpired. Error Number: 6030 ..." ]
}
```

Required accounts and expected fee are confirmed; the only reason simulation
fails is the expired quote. **No swap submitted.**

## 6. Remaining blockers and next steps

1. **External/architectural:** reliable liveness needs option C (approval) or D
   (program redesign + redeploy). No local keeper change closes the gap.
2. **Wallet:** the frontend signs with the connected adapter; the live swap is
   blocked here only by the absence of a browser wallet extension.
3. **If D is approved** — deployment plan: clean `cargo build-sbf`, record the SBF
   sha256, verify `anchor keys sync`/IDL parity, LiteSVM + workspace tests, a
   program upgrade signed by authority `ddGs6hk5…`, then on-chain re-preflight.
   Estimated cost: one program upgrade (~0.0028 SOL rent for buffer + fees) plus
   keeper tx fees (~5,000 lamports/tx).

## 7. Boundary

No program deploy/upgrade, no `anchor keys sync`, no authority/config/oracle
change, no mint/deposit/withdraw/claim/transfer, no swap, no push. Secrets never
printed; the Helius endpoint is redacted/absent from any built bundle.
