# ArbSwap — SECURITY.md (headline audit summary)

**Audited commit** `8d89791` (branch `main`); audit-response work on
`audit/fixes`. Full detail: `docs/AUDIT_FULL.md` (+ its addendum). This is a
**same-agent review, NOT an independent audit**; an external review is required
before **real funds** (test funds are not gated on it).

## Gate summary (Phase 0-5, post-response)
| Phase | Verdict | Note |
|---|---|---|
| P0 | PASS | assumptions/CI green |
| P1 | **PARTIAL** | 997 golden vectors + decimal parity; but synthetic flow is **not calibrated to the paper** (spreads ~6×, markout >10× the propAMM range) — headline E1 magnitudes are model-dependent |
| P2 | PASS (local) | LiteSVM lifecycle/invariants; anchor now bound to the verified oracle; devnet gate open |
| P3 | PASS (core) | keeper/replay + bond/slash/reward; live RPC dry-run only |
| P4 | **PARTIAL** | indexer/metrics/tests; no live demo; static dashboard |
| P5 | PARTIAL | E7 bots + property fuzz + aggregator price engine; no cargo-fuzz; E8 NOT DONE |
| P6 | NOT DONE | not requested |

## Verification (this pass)
`cargo test --workspace` **73 passed**; pytest **151 passed**; golden regen
**997** bit-identical; keeper parity 4; replay 347 updates; `report.py` exit 0 in
1 m 39 s.

## Fixes landed on `audit/fixes` (not merged)
- **Anchor↔oracle bound** (`max_anchor_dev_bps`) + negative test — closes the
  first-update anchor gap.
- **Capacity excludes fee buckets** (simulator + keeper) + on-chain
  `reserves ≥ liabilities` invariant test.
- **Timelocked, fixed-treasury fee claim** (`propose_fee_claim` /
  `execute_fee_claim`) and **timelocked keeper rotation**, both tested.
- **Math**: decimal-vs-integer parity (80-digit, 1-ulp) + overflow/rounding
  golden vectors. **CU** measured for every instruction.

## Compute units (measured)
| Instr | CU | | Instr | CU |
|---|---|---|---|---|
| deposit | 46,443 | | claim_keeper_reward | 13,933 |
| bond_keeper | 24,909 | | slash_keeper | 15,507 |
| update_quote | 20,013 | | request_withdraw | 19,920 |
| update_quote (Pyth-rejected) | 12,026 | | crank_epoch | 5,123 |
| swap | 71,554 | | claim_withdraw | 22,578 |

`update_quote` ≈60% accounts+Pyth, ≈40% validation+store. **Not a like-for-like
comparison** with the paper (the paper's update excludes on-chain oracle verify).

## Security posture
- Pyth fully verified on-chain (owner, feed, freshness s, price>0, confidence).
- Anchor bound to the verified oracle; levels bound to the anchor.
- Honest execution `min_out`/`min_version`; expiry stops fills; the ~56% fill rate
  is ≈45% honesty rejections (capacity/expiry ≈ 0 — Item 1g).
- Token-2022 rejected; donation/zero-share guard; warm-up + epoch queue; admin
  cannot touch LP reserves; fee claims are timelocked to a fixed treasury.
- No secrets in repo or git history.

## Known gaps (self-review; not exploits)
- **Synthetic flow not calibrated to the paper** (F-08; credibility).
- **E9 has 45/81 losing cells** (e.g. stale oracle + cheap vault) — reported.
- No per-window cumulative flow cap; README stale; program not in CI clippy; no
  cargo-fuzz. E8 and devnet deployment NOT DONE.

## Limits
The "no exploit" statement is an **internal self-review**. Do not move real funds
until an independent external audit passes.