# REMAINING_WORK.md — what is left vs MasterPlan.md and BuilderPlan.md

Generated 2026-10-10 at `main`/HEAD. Status words are defined in `docs/STATUS.md`.
This lists the **true remaining gaps**; everything not listed has a verified
implementation status in `docs/AUDIT_ACHIEVED_VS_PLAN.md`.

## 1. Economic proof (the central gap)
| Item | Plan ref | Status |
|---|---|---|
| E1 LVR < passive on real flow | MasterPlan §10, §2.5; BuilderPlan §2.5 | model-only |
| E2 2s markout positive | BuilderPlan §2.5 | model-only |
| E3 hedged return > passive | BuilderPlan §2.5 | model-only |
| E4 quiet half-spread ≤ passive | BuilderPlan §2.5 | FAIL (~8 vs ~2 bps) |
| Real-flow calibration gap (F-08) | MasterPlan §17.12 | unresolved; real-flow residual negative |
| E8 real-pool **fill gap** | MasterPlan §10, §7 caveat; BuilderPlan §12 P5 | proxy run only; needs funded mainnet trades |
| Independent external audit | MasterPlan §9; BuilderPlan §12 P5 | EXTERNAL |

## 2. Code / on-chain mechanisms
| Item | Plan ref | Status |
|---|---|---|
| Glosten–Milgrom toxicity belief update | MasterPlan §6.1 layer 5; BuilderPlan §5 | optional; not implemented |
| On-chain `max_vol` breaker field | MasterPlan §8.3 (M9) | keeper-side only (program has no vol input) |
| On-chain high-water-mark performance fee | MasterPlan §8.5 (M11) | off-chain only (plan says off-chain first) |
| `flow_n` consumed by the live quote policy | BuilderPlan §5.9 | stored/exposed; not yet consumed |

## 3. Product / interface
| Item | Plan ref | Status |
|---|---|---|
| Frontend dApp integrated with `artifacts/public` | MasterPlan §4 M17, §12 P4; BuilderPlan §9 | dApp on `frontend` branch (mock data, old layout); not merged |
| Jupiter listing / aggregator integration | MasterPlan §4 M18; BuilderPlan §12 T5.4 | adapter + parity done; listing is Jupiter-side (external) |

## 4. Testing / tooling
| Item | Plan ref | Status |
|---|---|---|
| Fuzzing (cargo-fuzz) | MasterPlan §9, §13; BuilderPlan §10, T5.2 | **DONE** — 3 targets (`arb_math`, `walk_ladder`, `quote_validation`) in `fuzz/`, nightly CI job (`scripts/fuzz_short.sh`) |
| CU/update < ~1,000 | MasterPlan §2.5, §17.14; BuilderPlan §2.5 | NOT met (~48k); LiteSVM non-deterministic |
| Verify-instead-of-compute redesign | C3/B2 roadmap | NOT DONE |
| Property/state-machine/adversarial suite | BuilderPlan §10 | present |

## 5. Deploy / process
| Item | Plan ref | Status |
|---|---|---|
| Devnet program == exact HEAD build | MasterPlan §5; BuilderPlan §12 P2 | MISMATCH; redeploy blocked (`ARBSWAP_DEVNET_KEYPAIR` unset) |
| Keeper from HEAD on devnet | BuilderPlan §12 P3 | ran historically, not from HEAD |
| Devnet CU measurement (ours vs Pyth) | BuilderPlan §12 T2.6/P5 | not measured (no funded run) |
| Multisig kill switch (Squads) | MasterPlan §8.9 (M19) | admin rotation + pause-only `wind_down`; multisig wallet-level external |

## 6. Docs / layout conformance
| Item | Plan ref | Status |
|---|---|---|
| Repo layout names (`programs/ keeper/ research/ analytics/ app/ attackers/`) | MasterPlan §12; BuilderPlan §4 | differs: actual `vault/ simulation/ frontend/ artifacts/ scripts/` (functionally equivalent) |

## 7. Explicit non-goals / roadmap (not "left" by design)
Single-sided deposits/zap, multi-pair vaults, cross-venue routing, RFQ/batch,
options overlay, LVR-rights auction, on-chain HWM fee, formal verification of
share accounting (MasterPlan §2.4, §8.5, §16; BuilderPlan §2.4, §15.3).

## Bottom line
Every mandatory code requirement has a verified status. What remains is
(a) the economic proof (real-flow E1–E4, fill gap, audit), (b) the frontend
integration, (c) fuzzing / CU / deploy hardening, and (d) items the plans
themselves mark optional or roadmap.
