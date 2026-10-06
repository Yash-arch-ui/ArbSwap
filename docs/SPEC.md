# ArbSwap — specification index

The full agent-ready specification is **`docs/BUILD_PLAN.md`** (imported from the
TruQuote Build Plan, v1.0). Naming: the project is **ArbSwap**; read "TruQuote"
in the Build Plan as ArbSwap (same scope, same math, same phases).

Document map:
- `BUILD_PLAN.md` — authoritative spec: math (§5), program (§6), keeper (§7),
  simulator/evaluation (§8), analytics (§9), testing (§10), security (§11),
  phases (§12), decisions log (§14), definition of done (§15).
- `ASSUMPTIONS.md` — verified vs unverified claims; resolve every *verify* item here (T0.3).
- `THREAT_MODEL.md` — threats, mitigations, tests (§11).
- `FORMULA.md` — P1 mathematical source map, derivations, status, and open decisions.

Build rules (Build Plan §0): math lives in one place (`crates/arb-math` + its
Python reference); no floats on-chain; test-first for math and accounting;
security over speed; small reviewable commits; stop and ask on OPEN decisions;
never claim an unmeasured result.
