# ArbSwap — SECURITY.md (headline audit summary)

**Audited commit** `8d89791` (branch `main`); audit + hardening work on
`audit/fixes` → `chore/repo-layout` → `audit/hardening2`. Full detail:
`docs/AUDIT_FULL.md` (+ Addenda 1-2). This is a **same-agent review, NOT an
independent audit**; external review is required before **real funds** (test
funds are not gated on it).

## Gate summary (Phase 0-5)
| Phase | Verdict | Note |
|---|---|---|
| P0 | PASS | assumptions/CI green |
| P1 | **PARTIAL** | 997 golden vectors + decimal parity; simulator **not calibrated** to the paper (B1 adverse selection ~50×) |
| P2 | PASS (local) | 75 Rust tests; anchor bound to oracle; per-window flow cap; devnet gate open |
| P3 | PASS (core) | keeper/replay + bond/slash/reward + rotation; live RPC dry-run only |
| P4 | **PARTIAL** | indexer/metrics/tests; no live demo |
| P5 | PARTIAL | E7 bots + property fuzz + aggregator price engine; no cargo-fuzz; E8 NOT DONE |
| P6 | NOT DONE | not requested |

## Verification (this pass)
`cargo test --workspace` **75 passed**; `pytest simulation` **153 passed**;
`cargo fmt --check` + `clippy -D warnings` (incl. the program) clean; golden
regen 997; keeper parity passes.

## Keeper-compromise loss bound (Items 1a-1c)
- **Per-window cumulative one-sided flow cap** on `QuoteState` (window + cap in
  `Config`, timelocked). Window rolls on the slot clock, not on `update_quote`.
- **Anchor bound to the verified Pyth price** (`max_anchor_dev_bps`, default
  tightened 500 → **100 bps**). Worst-case per update: `u·d·V = 0.5·0.01·V ≤
  0.5% of V`, plus the flow cap per window.
- **Insurance bucket is not claimable**; only protocol fees go to the fixed
  treasury, timelocked. (Insurance-use governance is design-only.)

## Honesty rejections / survivorship (Item 2)
- The ~55% fill rate is **honesty-limited, not capacity-limited** (capacity
  rejects = 0). See the tolerance-vs-rejection table in `docs/AUDIT_FULL.md`.
- Post-rejection gap is **non-positive by construction**; the would-be gap of
  rejected fills averages **+0.25 bps** (tail p95 **+6.3 bps**) — so fill-rate
  must be read together with the trader's `min_out` tolerance.

## Calibration / envelope (Item 3)
- **B1 is not calibrated to the paper** (target markout −0.2 bps / half-spread
  2.6 bps; best fit −98.7 / 52.9). Headline E1 is **model-dependent, not a
  result**.
- Operating envelope (latency × vault fee × regime): **25 win / 1 tie / 1 lose**;
  the loss is **crash + 1 bp vault fee + 4 s oracle latency**.
- `InformedFlow.fee_bps` is dead code in the engine.

## Security posture
- Pyth fully verified on-chain (owner, feed, freshness s, price>0, confidence).
- Anchor bound to the oracle; levels bound to the anchor; per-window flow cap.
- Honest execution (`min_out`/`min_version`); expiry stops fills.
- Token-2022 rejected; donation/zero-share guard; warm-up + epoch queue; admin
  cannot touch LP reserves; fee claims timelocked to a fixed treasury; keeper
  rotation timelocked (rotation absence was a DoS risk).
- No secrets in repo or git history.

## Known gaps (self-review; not exploits)
- Uncalibrated synthetic flow (F-08); no routing/fill-share (F-10); aggTrades not
  the flow (F-11); no cargo-fuzz (F-14); `InformedFlow.fee_bps` dead (F-15);
  no per-window study re-run after the capacity change (F-18); E8 and devnet NOT
  DONE.

## Limits
The "no exploit" statement is an **internal self-review**. Do not move real funds
until an independent external audit passes.