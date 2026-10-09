# AUDIT_PACKAGE.md — independent-review handoff (C6.1)

**Independent external audit: EXTERNAL — not performed by an agent.** This
package hands the code and evidence to a reviewer. Everything in-repo is a
same-agent self-review: *no known issues in self-review, independent audit
pending.*

| | |
|---|---|
| Audited head | `main` (see `simulation/data/results/artifacts.json` → `meta.commit`) |
| Program id (devnet) | `CCR33kX4Q9iucvgN4kRga2txmtu32vxy3bXpKyxPdBQx` |
| Reviewer deliverables | findings by severity, invariant coverage, guard-mutation re-run, claim audit |

## 1. Scope

**In scope:** the on-chain program (`vault/program`), shared math (`vault/math`),
keeper (`vault/keeper`), aggregator (`vault/aggregator`), the simulator/analytics
that produce claims (`simulation/`), and the docs.

**Out of scope:** mainnet; the Solana runtime and Pyth program; third-party
crates; the Next.js frontend (not built); regulatory.

## 2. Architecture and trust

- Program (Anchor): `Vault`, `QuoteState`, `Config`, `PendingConfig`,
  `DepositTicket`, `WithdrawTicket`, `KeeperBond`, `ProgramConfig`. PDAs with
  canonical bumps; every account bound to its vault (seeds/address/mint-owner).
- Trust: runtime + Pyth program **trusted** (with checks); keeper
  **semi-trusted** (bounded on-chain); traders/LPs/RPC **untrusted**; admin
  **timelocked**, pause-only kill switch, no fund seizure.
- Full account/instruction map: `docs/ARCHITECTURE.md`, `docs/SECURITY_CHECKLIST.md`.

## 3. Build and test

```bash
cargo fmt --all -- --check
cargo clippy -p arb-math -p arbswap-keeper -p arb-aggregator -p arbswap -- -D warnings
cargo test --workspace                       # 133 Rust
anchor build
python3 -m venv .venv && .venv/bin/pip install -r simulation/requirements.txt
.venv/bin/pytest simulation -q               # 185 Python
.venv/bin/python scripts/export_artifacts.py # rebuild the numbers bundle
.venv/bin/python scripts/check_docs_consistency.py
.venv/bin/python scripts/banned_words.py
```

## 4. Invariants to attack

1. `out >= min_out` or revert; expired quote always reverts.
2. Sell-then-buy the same size never yields more than the start (up to rounding).
3. Reserves ≥ tracked liabilities (insurance + keeper + protocol) after swaps.
4. Ladder capacity ≤ `utilization_max × available reserves` (buckets excluded).
5. First-depositor / donation cannot steal; `MIN_LIQUIDITY` burned.
6. Every keeper update outside bounds reverts; flow cap bounds one-sided flow.
7. Rounding always favors the vault; no unchecked arithmetic.
8. `insurance` bucket is not claimable to the treasury; `protocol` only, timelocked.

Tests: `vault/program/tests/{litesvm_lifecycle,litesvm_breaker,litesvm_security}.rs`.

## 5. Known issues / gaps (from the self-review)

| ID | Issue | Sev | Status |
|---|---|---|---|
| F-08 | Flow not calibrated to the paper (real-flow B1 saturates −7.9/13 bps) | HIGH (credibility) | CLOSED-BY-DECISION (`docs/THESIS.md` C2.2) |
| E8 | Real Solana quote/fill gap: proxy only (no funded fill data) | MEDIUM | CLOSED-BY-DECISION (`e8_proxy.json`) |
| A-24 | Admin NOT rotatable via timelock (keeper rotation is) | MEDIUM | CLOSED-BY-DECISION (change specified) |
| A-08 | Priority-fee introspection feasible but not implemented | LOW | CLOSED-BY-DECISION |
| C3 | "verify-instead-of-compute" reciprocal-sqrt redesign not implemented | MEDIUM | NOT DONE (roadmap) |
| C4.2 | `cargo-fuzz` not installed; `proptest` used instead | LOW | CLOSED-BY-DECISION |
| C4.8 | 30-min devnet keeper re-run | LOW | SKIPPED (`ARBSWAP_DEVNET_KEYPAIR` unset) |
| — | No independent audit | — | **EXTERNAL** |

## 6. Evidence artifacts

- Numbers bundle: `simulation/data/results/artifacts.json` (commit, data hashes,
  frozen-param hash).
- CU: `simulation/data/results/cu.json`.
- Mutation table: `docs/SECURITY_CHECKLIST.md` §2c + §S4.1.
- Thesis: `docs/THESIS.md`; calibration residual; routed world.
- Fuzz/property: `vault/math/tests/proptest.rs`, `properties.rs`,
  `vault/aggregator/tests/properties.rs`; program state-machine test.
- Devnet: `docs/DEVNET.md` (deploy + lifecycle signatures).

## 7. What the reviewer should NOT trust

- Every simulation number is **model output** (synthetic flow on a real price
  path); the routed competitor is a **model**, not a measured venue.
- The security wording is a **self-review**, not an audit.
