# S2-18 — Quote-liveness fixes without changing vault mathematics

Status: **local code + tests only. No deployment, no transactions, no live keeper.**
Companion: [`DECENTRALIZATION_AUDIT.md`](DECENTRALIZATION_AUDIT.md) (S2-17).

The deployed program (`2mwpYHpZ…hyiNm`) is unchanged. This task lands the first
local-code phase of the S2-17 remediation, under the frozen-math invariant.

## 1. Frozen mathematics (unchanged, and now regression-pinned)

No AMM/quote/share/fee/ladder/capacity function was refactored. Deterministic
reference values are pinned in `vault/math/tests/liveness_regression.rs`:

- `price_from_sqrt(6036613448307627517) == 1975454409660514979` (deployed v18).
- `sqrt_q64(1975454409660514979) == 6036613448307627515` (floor round-trip).
- 9/6 normalization of 150.0 → `2767011611056432742`.
- `price_from_sqrt(225887000000000000000) == 2766067364794264765714`.
- floor/ceil rounding sanity.

These run under `cargo test -p arb-math` and fail if any frozen value moves.

## 2. Keeper anchor candidate selection (implemented)

**Defect.** The keeper proposed `anchor_sqrt = sqrt_q64(P_oracle)` (the full
jump) and never clamped. After a market gap the full jump violates the
previous-anchor step bound, so every refresh was rejected `AnchorStepTooLarge`
even when a feasible in-band anchor existed. The S2-17 audit's "disjoint bands"
for the reported sample (108.272) was a units error: the step guard is in
**√price** space, so 50 bps ≈ 1.0 % in price.

**Fix.** `vault/keeper/src/lib.rs`:
- `anchor_interval(old, P, step_bps, dev_bps)` returns the exact integer
  intersection of the step band (√ P space) and the dev band (P space), using
  the program's own `price_from_sqrt`/`sqrt_q64` (no floating point).
- `select_anchor_sqrt(...)` returns `sqrt_q64(P)` clamped into that
  intersection, or `None` when the intervals are disjoint.
- `anchor_within_bounds(...)` independently re-checks a candidate with the exact
  on-chain comparison order/rounding.
- `KeeperCore::step` clamps the anchor into the intersection before the offline
  prevalidation gate; when disjoint it returns `None` (never fabricates or loops).

Tests (in the keeper crate): target kept when already in band; moderate jump
clamped to the step edge; disjoint intervals return `None`; exact integer
boundary (`old + floor(old*step/10_000)` passes, `+1` fails).

## 3. Expired-quote recovery (implemented, program-side)

`vault/program/src/lib.rs` adds `quote_reanchor_eligible(config, quote_state, clock)`
and gates the step guard on it:

- Normal refresh (live quote): the anchor-step **and** oracle-deviation guards are
  unchanged.
- Recovery: when there is no prior quote, the stored quote is **expired**
  (`clock.slot >= expiry_slot`), or its stored oracle is **stale**
  (`now - oracle_publish_time > max_staleness_seconds`), the step guard is
  skipped; the **oracle-deviation bound and every other check still apply**.
- Eligibility is derived only from the on-chain clock + committed state (no
  caller flag), so a keeper cannot request recovery early. After a successful
  re-anchor the quote is fresh again and the step guard immediately resumes.
- All ladder/spread/inventory/capacity/version/replay/pending-quote/update-slot
  protections and the staged commit atomicity are untouched; the change is a
  guard condition, not quote math.

Tests `vault/program/tests/litesvm_recovery.rs` (8, LiteSVM, symbolic errors):
normal in-band refresh passes; a large jump is rejected while the quote is live;
the same jump recovers after expiry and the new quote is live; recovery still
rejects an anchor far from the verified Pyth price; replayed slots rejected in
both paths; stale oracle, wrong feed and low confidence rejected in both paths.

## 4. Keeper transaction-result handling (implemented)

New pure module `scripts/devnet/keeper_commit.ts` + local test
`keeper_commit.test.ts` (run with `npx tsx`). It classifies a commit as
`SUBMITTED | CONFIRMED | FAILED | UNOBSERVED | COMMITTED_AND_VERIFIED` and
requires all of: a signature, a retrieved transaction, `meta.err == null`, a
**strictly greater** reread `QuoteState.version`, and a still-live expiry.

`scripts/devnet/keeper_live.ts` now:
- records the pre-attempt version and never treats `version > 0` as success;
- treats a missing `getTransaction` as `UNOBSERVED` (never success);
- inspects ambiguous signatures with `getSignatureStatuses` before any retry;
- applies bounded exponential backoff between attempts.

`scripts/devnet/keeper_loop.sh` is now a **bounded, single-instance** runner:
an exclusive `flock`, exponential-backoff restarts, and a non-zero exit after
`MAX_CONSECUTIVE_FAILURES` — no unbounded `while true`.

## 5. Permissionless keeper participation — plan (not implemented)

Current: with `min_bond == 0`, `require_keeper_authorized` and the inline check
in `update_quote` require `keeper == config.keeper` (an allowlist). The bonded
path is already permissionless in code but `claim_keeper_reward` still pays only
`config.keeper`.

Why this is a **plan** and not a code change here:
1. Removing the allowlist inverts existing security tests that assert
   `NotKeeper` (`litesvm_lifecycle.rs:997`, `:1951`, `:4576`), i.e. it is a
   reviewable security-policy change, not a liveness bug fix.
2. Routing rewards to the **committing** keeper needs the committing keeper
   recorded at commit time — a `QuoteState` layout change (store the keeper
   pubkey or a per-epoch reward accumulator), with migration implications.
3. A bond value / optional slashing rule must be chosen (anti-spam), which the
   task forbids inventing.

Proposed design (for a separate authorized task):
- Drop the `min_bond == 0` allowlist; authorization becomes "quote passes the
  on-chain checks". Keep the bonded path as an explicit anti-spam policy.
- Record the committing keeper in `QuoteState` (layout bump + migration) or emit
  a `QuoteCommitted` event and settle rewards from indexed events; pay the
  committing keeper, never exceeding realised `keeper_bps` revenue.
- Move `config.keeper` from "sole keeper" to "reward recipient / governance
  role", and update the existing tests accordingly.

## 6. Oracle freshness — unchanged

The deployed freshness/confidence/feed/verification rules are untouched. S2-17
measured log evidence remains the basis for any future, separately-authorized
freshness proposal; this task did not change it.

## 7. Verification

- `cargo test --workspace`: green — program lifecycle 87, recovery 8, oracle 3,
  security 3, breaker 2, fixtures 1, keeper 44, math (incl. 4 new regression).
- `yarn test` 29, `yarn lint` clean, `yarn build` (tsc + vite) clean.
- `npx tsc --noEmit` on the keeper TS: clean.
- `npx tsx keeper_commit.test.ts`: 9 passed.
- Local SBF artifact rebuilt for the LiteSVM tests (`target/deploy/arbswap.so`);
  **not deployed**.

## 8. Remaining blockers to an independent multi-keeper Devnet test

- Permissionless authorization + reward routing (section 5) not yet implemented.
- Deployment + a second independent funded keeper wallet (needs authorization).
- Freshness remains provider-sensitive on a single public RPC (S2-17).
