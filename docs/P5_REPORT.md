<!-- cu-scan: historical-snapshot -->
# P5_REPORT.md — Hardening and adversarial testing (Build Plan §12 P5)

**Gate: every E7 attack fails or is contained and documented. — PASSED.**
Evidence below. Companion: `docs/THREAT_MODEL.md`, `docs/SECURITY_CHECKLIST.md`.

## T5.1 — Attacker bots (E7)

`python -m simulation.attackers.e7` — 7 adversarial bots + a keeper-alive
control. Synthetic paths (model output, not product claims); the
account/authority attacks are contained on-chain and mapped to LiteSVM tests.

| Scenario | updates | fill% | gap (bps) | mkt 2s | B1 mkt 2s | mitigation |
|---|---|---|---|---|---|---|
| stale-feed (oracle frozen 60s) | 3600 | 59% | −5.85 | −5.93 | −2.06 | staleness/confidence + expiry; on-chain `pyth_verification_rejects_untrusted_or_stale_updates` |
| bad-tick / vol spike | 3600 | 59% | −3.20 | +1.51 | −2.00 | jump detection + anchor-step guard; `level_far_from_the_anchor_is_rejected` |
| sandwich / pick-off | 3600 | 57% | −2.68 | +4.62 | +0.79 | versioned quotes + min_out; `swap_enforces_slippage_version_and_size` |
| phantom-liquidity | 3600 | 58% | −7.17 | +1.65 | −2.00 | warm-up + epoch queue + utilization cap; `second_deposit_reuses_the_ticket...` |
| keeper-alive (control) | 3600 | 54% | −3.53 | +2.90 | +0.08 | control |
| **keeper-down** | **1** | **100%** | **0.00** | 0.00 | +0.08 | **quote expiry stops fills**; `keeper_outage_lets_the_quote_expire` |
| adaptive toxic flow | 3600 | 58% | −5.92 | +3.50 | −1.04 | spread floor + throttle + expiry |
| oracle-update sandwich | 3600 | 61% | −3.53 | +4.05 | −1.01 | versioned quotes + min_out |

**Containment:** the honest vault's quote-versus-fill gap is non-positive
(fills are at or better than the last displayed quote); the keeper-down bot
stops filling entirely (1 update, quotes expire); the on-chain guards bound
every account/authority attack. Structural assertions live in
`simulation/attackers/tests/test_e7.py`.

## T5.2 — Fuzzing and property tests

`cargo-fuzz` is **not installed** in this environment; the fuzzing path is
`proptest` + a differential harness (both run in CI):

| Harness | Coverage |
|---|---|
| `vault/math/tests/proptest.rs` | 6 properties: `mul_q64`, `div_q64`, `sqrt_q64`, fee ceil/bounded, ask-walk monotone + capacity-bounded, withdrawal floor/bounded |
| `vault/math/tests/properties.rs` | 12 deterministic property/fuzz tests |
| `vault/aggregator/tests/properties.rs` | 3: monotone in input, round-trip never creates value, `in_given_out` honours its target |
| `simulation/reference/test_wide_diff.py` | 1,000,000 cases/op differential vs Python big integers (S1) |
| `vault/program/tests/…state_machine_full_action_set_preserves_invariants` | random deposit/quote/buy/sell/trip/reset/unbond; reserves ≥ liabilities, shares consistent |

## T5.3 — Security checklist and threat model

- `docs/SECURITY_CHECKLIST.md` — account-binding table for every instruction,
  per-instruction signer/owner/PDA/math checks, **31-guard mutation table** (all
  caught), CU table.
- `docs/THREAT_MODEL.md` — every threat → mitigation → test (E7 / LiteSVM),
  including the T6 keeper loss bound and the H3 realized-edge breaker.

## T5.4 — Aggregator adapter (Jupiter AMM interface)

- **Interface verified** (official `jup-ag/jupiter-amm-interface` README + trait,
  recorded in `docs/ASSUMPTIONS.md` A-23): the `Amm` trait requires
  `from_keyed_account`, `quote`, `get_swap_and_account_metas`, … and the
  `test-kit` verifies `quote() == on-chain swap` in LiteSVM.
- **Pricing half implemented:** `vault/aggregator` — `out_given_in`,
  `in_given_out`, `best_price` (correct side mapping), 3 property tests.
- **Parity test (test-kit pattern):**
  `aggregator_quote_matches_onchain_swap` — builds the aggregator quote, then
  executes the on-chain `swap` in LiteSVM and asserts the output equals the
  quote.
- **Listing limitation:** `get_swap_and_account_metas` returns a **closed
  `Swap` enum** with a fixed set of DEX variants, so a new program cannot be
  listed without a Jupiter-side variant. This is out of our control and is
  documented, not worked around.

## T5.5 — E8 / E9 / E10

- **E9 sensitivity / E10 cost:** `python -m simulation.sim.e9_e10` — passive fee
  × vault fee × latency; **45/81 cells have negative E1** (losing regimes
  reported). E10: `cu_update_quote = 17,962`, `cu_swap = 71,518`, cost per
  update ≈ 0.00075 quote, 2.71 quote/hour; 26.6× / 4.2× the paper's update /
  swap floor (not like-for-like: the paper excludes on-chain oracle
  verification).
- **E8 (real Solana pool quote gap) — PARTIAL.** A public Jupiter quote
  (`lite-api.jup.ag`) for 1 SOL → USDC routed through the live propAMM
  **BisonFi** at **110.2525 USDC/SOL**, price impact ≈ 0.0005% (a real venue
  quote, no key required). The full **quote-versus-fill gap** requires execution
  data (historical fills) and is **not measured**; no claim is made about
  competitors' fill quality. Status: "honest by construction; measured in
  simulation and on devnet; no measured competitor fill-gap claim."

## Gate verdict — P5: PASS

Every E7 attack is contained and documented; the security checklist and threat
model are finalized; E9/E10 are produced; the aggregator pricing half + parity
test are implemented. Remaining (documented, out of scope or data-blocked):
`cargo-fuzz` (proptest is the substitute), E8 fill data, and the Jupiter-side
`Swap` variant for listing.
