# ASSUMPTIONS.md

Per Build Plan §0 rule 1: nothing is invented; anything that cannot be verified
from official docs or source is written here and escalated to the human.
Statuses: **VERIFIED** (checked against primary source), **ASSUMPTION** (acting
on it, needs human confirmation), **OPEN** (blocks a decision; see Build Plan §14).

## A-01. Orca Whirlpools license — VERIFIED, ACTION CHANGED
`orca-so/whirlpools` was Apache 2.0 **only until 2025-02-26**; since 2025-02-27 it
is under a custom proprietary "Orca License" (GitHub reports NOASSERTION).
**Consequence:** do not copy Orca code. Implement Q64.64 / segment math from the
published formulas (Uniswap v3 whitepaper; formulas independently confirmed in
the LVR paper, Example 4). Build Plan §6.5's "verify against Orca's code" is
superseded by this note.

## A-02. Nadler et al. "~57 bps average oracle deviation" — ASSUMPTION
Paper identity verified: *Blockchain price oracles: Accuracy and violation
recovery*, Nadler, Schuler, Schär — **Journal of Corporate Finance vol. 96 (2026)**
(not 2025 as cited in Build Plan §13), 150M+ observations, 40 Chainlink feeds on
Ethereum over 18 months; findings describe "economically significant deviations"
correlated with configuration and market stress. The **57 bps figure could not be
verified** (SSRN and ScienceDirect block automated access). Do not cite the number
until a human reads the paper. Citation year corrected here to 2026.

## A-03. "1.23 bps inter-block vs 8.62 bps intra-block variance" (Master Plan R10) — VERIFIED (2026-10-06)
Found in the 0x post itself, inside the **chart alt-text**: "Charts comparing
inter-block price variance of 1.23 basis points to intra-block price variance of
8.62 basis points for a second propAMM on Base, a 7x inversion indicating
aggregator spoofing". Earlier text-only extraction missed it (the numbers live in
image descriptions, not body text); the body states intra-block variance runs
**5–7×** higher than inter-block, consistent with the figure. Cite as 0x,
*PropAMM Shenanigans* (second propAMM measured on Base).

## A-04. LVR paper numbers — VERIFIED (upgrade vs Master Plan §17.5)
The 99.991% variance-share figure appears in the **original** LVR paper v6
(abstract, §1, §7.2) — no "secondary report" needed. σ²/8 for constant product is
Example 3; narrow-liquidity LVR/V → ∞ (Master Plan R3) is Example 4.

## A-05. Solana update-cost economics — VERIFIED (measured 2026-10-07)
propAMM paper §7.1: median updates 485–676 CU (Solana) vs ≥16,938 CU for a swap;
HumidiFi reported ~300 → 47 CU per update. The <1,000 CU target in Build Plan
§2.5 is conservative. **Measured on the built program (LiteSVM, 2026-10-07):**
`update_quote` 48,209 CU, `swap` 59,327 CU (ladder-dependent), `trip_breaker`
10,054 CU. All fit the 200,000 CU transaction
default. The update is still ~19–26× the paper's propAMM median, so the "low-cost
update" claim is *not* supported for `update_quote`; it is dominated by Anchor
account validation, not the ladder math (ASSUMPTIONS A-17).

## A-06. New prior art to read before demo — SKIMMED, deep read still OPEN
**arXiv:2609.33799** — *Oracle-Parametrized Constant Function Market Makers*
(Amini & Feinstein, 27 Sep 2026, 45 pp). Same design space as ArbSwap.
Verified from the skim:
- Quoted price is a **convex combination of oracle and inventory price**:
  `p = λ·π + (1−λ)·π*(r)` under an oracle-contraction condition (Thm 2.8);
  price-tracking / inventory-tracking / geometric-average constructions.
- LVR split (Cor 3.4): market-lag term `(1−p_π)²σ²`, oracle-error term
  `p_π²(σ^η)²`, and a covariance term — i.e. an oracle-anchored curve converts
  LVR into lag + oracle error rather than eliminating it.
- **Oracle-update sandwich attacks** (§3.2.1): front-run the stale curve,
  back-run the refreshed one; attacker profit can equal the full pool value if
  boundary divergence fails (Prop 3.11); proportional fees can kill the
  incremental front-run value (Lemma 3.14). Bot #7 in `attackers/` targets this.
Still owed before demo: full read + row in the comparison table.

## A-07. Pyth product choice (Build Plan decision D-09) — OPEN, mechanics VERIFIED
- **Pyth Core:** pull-based price feeds with confidence intervals; the lower-risk,
  trust-minimized default. Verified: `PriceUpdateV2` account exposes
  `Price { price: i64, conf: u64, exponent: i32, publish_time: i64 }` in **one
  account read**; account owner is the Pyth Solana Receiver program (enforced by
  Anchor `Account<PriceUpdateV2>`). Verified update mechanics: updates are
  **in-band** — the keeper fetches Hermes data and includes
  `update_price_feeds` (CPI, caller pays) in the *same transaction* as
  `update_quote` (alternative: sponsored push price-feed accounts updated by a
  separate crank).
  **Consequence for §6.3/CU accounting:** one keeper tx = ComputeBudget +
  Pyth verification + our update. Report CU for our instruction *separately*
  from total-tx CU; the Build Plan's "one low-cost tx" claim is about our part.
- **Pyth Lazer:** 1 ms / 50 ms / 200 ms channels, richer data (bid-ask, depth),
  **15K CU for 20 feeds on Solana**, permissioned/custom integration (no public
  pricing tiers found), designed to be cross-checked against Core with circuit
  breakers.
Still open: historical-data availability for backtests (T0.4).
Decision: start Core (P0), evaluate Lazer at P3.

## A-08. On-chain priority-fee introspection (decision D-08) — CLOSED-BY-DECISION
**Feasibility VERIFIED (2026-10-09).** The Solana **Instructions sysvar**
(`Sysvar1nstructions1111111111111111111111111`) + `load_instruction_at_checked`
lets a program read the top-level ComputeBudget instruction; `SetComputeUnitPrice`
(discriminator `3`, `u64` micro-lamports) is therefore readable on-chain
(solana.com/docs/core/instructions/instruction-introspection;
solana.com/docs/core/fees/compute-budget).

**Decision: not implemented.** Reason: the per-window cumulative one-sided flow
cap (F-04) and the 2 bps spread floor already bound pick-off loss
(`window_flow_cap_stops_one_sided_flow`, `test_anchor_loss_bound.py`), while a
priority-fee-dependent penalty adds swap CU and UX complexity with no measured
benefit. The Build Plan fallback (no priority penalty; rely on spread/throttle/
expiry) stands. Limits: a high-priority-fee arbitrageur is not additionally
penalized; bounded by the flow cap.

## A-09. Jupiter aggregator interface — VERIFIED (shape), integration OPEN
`jup-ag/jupiter-amm-interface` is a Cargo workspace: DEXs implement the `Amm`
trait (`interface/` crate) and must pass `jupiter-amm-test-kit` (snapshot pool →
SDK quote → execute native swap in LiteSVM → assert parity). License field empty
on GitHub — check before shipping an adapter (P5/T5.4).

## A-10. Master Plan study notes — VERIFIED sources behind the design
- Spread linear in inventory tracking the external price: Baggiani et al.
  (arXiv:2506.02869) — linear approximation of optimal fees ≈ fully optimal in
  their Monte Carlo; constant fees lose ~19–20% revenue. Two fee regimes (deter
  arbitrageurs / attract noise). Cite the two-regime nuance, not just linearity.
  **Nuance (2026-10-06):** their linear term is **signed** (an antisymmetric
  skew: sell-fee up / buy-fee down when long), and what tracks the CEX price is
  the **fee-adjusted spread midpoint**, not the marginal price. Our symmetric
  `a2·|q|` widening term is therefore a heuristic on top of the signed skew that
  `P_res` already provides — keep it labeled as such (MATH.md).
- Directional fees vs toxic flow: Alexander & Fritz (arXiv:2406.12417) — with
  drift, revenue rises with fee on the exposed side; f_opt ≈ √α−1; best case the
  venue retains 2/3 of the arbitrage surplus.
- Zero-profit quoting: ZeroSwap (arXiv:2310.09413) ask/bid = conditional
  expectations; steady-state spread Θ(σ/λ). Adaptive Curves (arXiv:2406.13794)
  derive the optimal-curve ODE + Kalman update; robust to ≤50% adversarial flow.
- Reservation price: Avellaneda–Stoikov (2008), r = s − q·γσ²(T−t) — ArbSwap's
  `P_res = P(1 − g·q)` is the inventory-linear skew in bps form (state the
  adaptation). Note: the A–S *total spread* is q-independent; only the quote
  mid/skew moves linearly in q, which is exactly what `P_res` models.
- propAMM edge sources (Solmaz et al., arXiv:2609.38056): low-cost updates,
  counterparty pricing, winning arb leg, spoofing — ArbSwap keeps the first three
  by design and removes spoofing via versioned quotes + the gap metric.
- Spoofing evidence (39% identical / 1.08 bps worse) is **Base/Flashblocks**;
  whether a comparable gap exists on Solana is unverified (Build Plan §17.1; E8).
  Nuance: the propAMM paper notes affected traders *sometimes* receive a better
  price than quoted; 0x's framing ("always in operator's favor") is the stronger
  claim. Present both.
- Uniswap v2 min-liquidity: whitepaper §3.4 states first mint `√(x·y)` then
  *burn* the first 1e-15 of shares (1000× the minimum 1e-18) to the zero
  address. The `shares = floor(√(dB·dQ)) − MIN_LIQUIDITY` form is the contract
  code's equivalent — cite the whitepaper for the mechanism, the code for the
  formula.

## A-11. Structural keeper risk — documented, mitigated by design
ethresear.ch (Jul 2026): a profit-maximizing proposer could censor oracle updates
and auction the resulting stale-price arb; on Ethereum PBS this is the default
(hence trusted-builder propAMM services). On Solana it is detectable but not
protocol-preventable. Mitigation in ArbSwap: quote expiry stops fills, breakers,
multiple bonded keepers. Record in THREAT_MODEL.md.

## A-12. Lifinity comparison nuance (prior art, re-check before demo) — VERIFIED
Lifinity docs: the oracle is the *key* pricing mechanism (not pool balances);
trades are only allowed when the oracle was **updated in the current slot** and
the confidence interval is narrow (their anti-front-running rule); concentration
is `x·y = c·k` (a multiplier on k, not tick ranges); custom in-house oracle
(vendor not named). **Consequence:** Lifinity's freshness/confidence rules are
closer to ArbSwap's §5.11/§5.12 checks than the Build Plan's comparison table
implies. Differentiators that still hold: versioned honest quotes + measured
quote-versus-fill gap, LVR-derived depth throttle, open bonded keepers, published
methodology. Add a Lifinity row with the freshness rule to the table.

## A-13. "propAMMs handle >50% of SOL/USDC volume" — NOT VERIFIED (deck claim)
This figure appears in both spec documents (§1.2 / R14 context) but was not
located in the sources skimmed on 2026-10-06. Re-check the propAMM paper's exact
wording (or its underlying data) before citing it in the deck or README.

## A-14. P2/P3 delivery boundary — P2 ORACLE VERIFIED, PRODUCTION OPEN
P2 `update_quote` now requires a Pyth Receiver `PriceUpdateV2` account with Full
verification, the configured feed ID, freshness, decoded Q64 price equality,
and confidence equality. The public breaker uses stored quote expiry only. P3
still has a deterministic dry-run sender rather than live RPC/private-key
transport; local lifecycle tests and devnet deployment remain pre-production
gates.

## A-15. Simulation clock and cost model (Task 1) — CLOCK DECIDED, COST MIX VERIFIED/HEURISTIC
- **Headline clock:** `step_seconds = 0.4` (Solana slot-native) with
  `source_step_seconds = 1.0` (the reference series is observed on a 1 s
  staircase; the vault reacts on a 400 ms grid). 1 s and 0.1 s runs are reported
  as **clock sensitivity only**, never as headline numbers.
  *Direction of the bias:* a coarser clock hands the arbitrageur fewer reaction
  opportunities, so a 1 s clock **understates** adverse selection on a lagging
  oracle. Measured (synthetic crash, 20 min, seed 4): vault hedged PnL 12.78 at
  1 s vs 9.64 at 400 ms vs 8.66 at 100 ms — 400 ms and 100 ms have converged,
  1 s has not. Asserted in `test_simulation_clock_is_a_sensitivity_not_a_free_parameter`.
- **Slot and landing:** `slot_seconds = 0.4`; keeper decisions sit on a
  wall-clock grid (multiples of `keeper_update_interval_seconds`) and are taken
  at the first slot boundary at or after the target, so decision times, decision
  counts and the order of the landing-delay draws are identical on any
  simulation clock (`test_keeper_decision_grid_does_not_depend_on_the_simulation_clock`).
  Landing = `ceil((t + delay) / slot) · slot`.
  `LANDING_DELAY_SECONDS = ((0.4,0.55),(0.8,0.25),(1.2,0.12),(2.0,0.05),(3.2,0.03))`
  (mean 0.76 s) is a **HEURISTIC** — not measured on Solana. Replace with a
  live-mempool measurement before any P4 claim.
- **Costs:** compute units are *measured* in LiteSVM (update 48,209 CU; swap
  59,327 CU) → VERIFIED; `base_fee_lamports = 5000` is the protocol parameter;
  `priority_micro_lamports_per_cu = 1000` is a **HEURISTIC** (priority fees are
  set by a leader auction). Gas and priority are converted to quote at the
  current reference SOL price.
- **Cost attribution:** update gas + priority are debited from the vault's quote
  on every refresh (the vault pays for its own crank); swap costs are recorded
  on `SimResult` but **not** debited, because the swapper signs that transaction.
- **Volatility clock:** the EWMA variance advances on *reference samples*, not on
  loop iterations, so the spread does not silently change with the simulation
  clock (bit-identical at `step_seconds = 1.0`).

## A-16. Three simulator defects found and fixed during Task 1 (2026-10-07)
1. **Displayed-ladder double-spend (high).** `VaultVenue.fill` consumed reserves
   but left `quote_state` intact, so every fill inside one `update_quote` window
   re-walked the original ladder and a fast arbitrageur could drain the vault many
   times between two keeper updates (gross turnover 120,850 on a 100 ms clock vs
   43,378 on a 400 ms clock). Fixed by `_consume()`, which removes the filled span
   from the displayed levels. Regression: `test_ladder_capacity_is_spent_once_per_quote_window`.
2. **Insolvency.** `_preview_fill` raises instead of driving a reserve negative
   (a negative base reserve previously broke `inventory_imbalance`).
3. **Zero-profit arbitrage sizing (high).** `_informed_trade` sized to the
   *average-price* breakeven, producing self-sustaining round trips that donated
   fees to the passive benchmark (B1 gross turnover ≈ 5.3M/h before the fix,
   ≈ 237k/h after). Replaced with golden-section maximisation of the *marginal*
   profit (`reference·out − in` for a buy, `in·(out′ − reference)` for a sell).
4. **Shared stateful oracle in `run_venues` (high, 2026-10-07).**
   `run_venues` built one `OracleModel` and passed the same instance to all five
   venues, so each venue consumed a different stretch of the noise stream and the
   "same path, same draws" pairing was silently broken: `ArbSwap` in `run_venues`
   did not match a standalone `simulate()` with the same seed (W2 PnL 15,411 vs
   17,881). Fixed by cloning the oracle per venue (`dataclasses.replace`
   re-runs `__post_init__`, reseeding it). Regression:
   `test_run_venues_gives_every_venue_its_own_fresh_oracle`. The evaluate and S2
   phases were re-run; the headline E1 moved from ≈+290% to ≈+375%.

## A-17. Task 2 compute-unit reduction — VERIFIED (measured 2026-10-07)
The `swap` instruction cost ≈201k CU, above Solana's 200,000 CU transaction
default, so every swap needed a `ComputeBudgetProgram` bump (audit F-05).
Root cause: `arb_math::wide::U256::div_rem` was a restoring shift-subtract that
always ran **256** single-bit rounds, and `U256::isqrt` ran ~96 rounds; both sit
under every Q64.64 operation the ladder walk uses.
- `div_rem` is now **Knuth Algorithm D** over 64-bit limbs (normalise, one
  quotient limb per `u64`, estimate and correct `q_hat`, multiply-subtract).
- `isqrt` is now **Newton's method** seeded from the bit length
  (`x = 1 << ceil(bits/2)`), stopped at the first non-decreasing step — the
  integer algorithm documented in the Python `math.isqrt` notes.
Both return **bit-identical** results to the old routines, which is asserted by
a differential fuzz test (`tests/properties.rs`: 20,000 random 1–4-limb
dividends, 5,000 u128-range cases, and hand-picked edges); the Python↔Rust
golden vectors are unchanged.

Measured effect (LiteSVM, rebuilt SBF program): **`swap` ≈201k → ≈34k CU**
(6.0×), now inside the 200,000 default. `update_quote` is **unchanged at
12,802 CU** because it does not walk the ladder — it is dominated by Anchor
account validation and Pyth verification, which live in the program, not
`arb-math`. `trip_breaker` measures **7,051 CU** when its test binary runs
alone; it occasionally reports **10,051 CU** (+3,000) when the breaker and
lifecycle test binaries are invoked in the same `cargo test` command. That
spread is a measurement artifact of the harness, not a code path, and it
explains the audit's F-06 "7,051 vs 10,051" disagreement — the two numbers are
the same instruction measured two ways. Consequence: no caller needs a
compute-budget bump. (Later re-measured after F-04/D-07: `update_quote` 48,209,
`swap` 59,327 — see A-21 and `SECURITY_CHECKLIST.md`;
`research/sim/costs.py` now records those.) The "low-cost update" claim is still
**not** supported for `update_quote`.

## A-18. Task 5/6 keeper parity and security tests — VERIFIED (2026-10-07)
Keeper (`keeper/src/lib.rs`) parity fixes:
- **F-03 (decimals):** the inventory value is now `base * price_q64 / 2^64 /
  base_atom_scale`. The old `base * price_q64` omitted the Q64 shift and any
  token-decimals conversion, so the imbalance saturated at its bound for every
  realistic reserve. `base_atom_scale = 10^(base_decimals - quote_decimals)`
  (`1000` for SOL 9 / USDC 6). Regression: a balanced 1000 SOL / 150,000 USDC
  vault now quotes at the anchor (`keeper` unit test + Python parity test).
- **F-09 (spread):** the volatility term keeps sub-basis-point resolution
  (`coeff * sigma_fraction * 10^4`); the previous form floored sigma to whole
  bps and divided by 10^4 again, so it was always zero. Spread now clamps to
  `[spread_min_bps, spread_max_bps]`; the depth throttle includes the confidence
  factor, jump cool-down and depth budget (F-08); the directional add-on is
  computed and encoded into the `update_quote` payload (previously hard-coded 0).
- `research/sim/test_keeper_parity.py` now covers non-zero inventory skew, the
  mixed SOL/USDC decimals case, and the directional add-on, mirroring the
  integer formulas (including Rust's truncate-toward-zero signed division).
Remaining divergence (documented in FORMULA.md and the keeper docstring): the
EWMA is not time-normalised and the keeper emits ask-side levels only; the F-04
binding of executed levels to the anchor is a separate programme task.

Security tests added (`vault/program/tests/litesvm_lifecycle.rs`):
- `pyth_account_owner_must_be_the_receiver_program` (Anchor owner check),
- `oracle_confidence_must_match_the_payload` (decoded > 1 bps but within
  `max_conf_bps`, so only the equality check fires),
- `wind_down_is_admin_only_and_pauses_quotes` (F-18 + authority),
- `future_update_slot_is_rejected` (F-15 rule as implemented).

## A-19. Blockers closed 2026-10-07 (audit F-04, F-08, F-10, F-11, F-14, F-16, F-17)
- **F-04 (devnet blocker) CLOSED.** `update_quote` binds every level's implied
  price to `anchor * (1 ± (half_spread + extra + outer offset))`, caps the outer
  offset at `MAX_LEVEL_OFFSET_BPS = 500`, and bounds the reservation to
  `config.max_inventory_bps` (previously set and never read). A forged keeper's
  worst quote is now anchor ± (max spread + 500 bps). Negative tests:
  `level_far_from_the_anchor_is_rejected`, `reservation_outside_the_inventory_band_is_rejected`.
- **F-10 CLOSED.** Deposit pulls `ceil(shares*reserve_net/total_shares)` per leg
  (capped at the request) instead of both full amounts; tickets are
  `init_if_needed`; claim zeroes the ticket. While testing, a real accounting
  bug was found and fixed: `vault.total_shares` was only updated on the first
  deposit, so later mints never grew the supply.
- **F-11 CLOSED (mitigated).** Deposit requires `shares > 0`, so a
  donation-inflation attacker cannot make a later deposit mint zero shares; the
  `MIN_LIQUIDITY` burn is retained. No ERC-4626 virtual shares — recorded as a
  mitigation, not a proof.
- **F-14 CLOSED.** Trader and claim token accounts constrain their mint to the
  vault mints.
- **F-16 CLOSED.** `flow_n` uses consistent units (`+= net base out` on a sell,
  `-= net base in` on a buy) and is documented as recorded-but-not-yet-priced.
- **F-17 CLOSED.** Admin-only timelocked `set_params`/`apply_params` with a
  `PendingConfig` PDA (`TIMELOCK_SLOTS = 216_000`, ~1 day).
- **F-08 CLOSED (scoped out).** The LVR *budget* is not applied because `R` and
  `g_gas` are undefined business inputs; the σ-target × confidence throttle is
  what the simulator and keeper implement. The budget language is removed from
  claims (FORMULA §9).
- **Live transport: code present, devnet run open.** `keeper/src/lib.rs` now
  builds the `ComputeBudget` (limit + price) and `update_quote` instructions,
  signs the transaction and exposes `LiveSender` (the caller injects the RPC
  submit closure). The signed bytes and account order are unit-tested offline;
  a funded devnet submission has not been performed (no keys/RPC here).

## A-20. Phase 2 completion — attack vectors closed (2026-10-07)
Additional vectors found in a full instruction/account review and closed:
- **Initialize front-run:** `initialize_vault` derives the vault PDA from the
  mint pair alone, so anyone could have squatted it. A one-time
  `initialize_program` now claims a program admin, and `initialize_vault`
  requires `program_config.admin == admin`. Tests:
  `litesvm_security.rs::only_the_program_admin_can_initialize_a_vault`,
  `a_non_admin_cannot_initialize_a_vault`, `initialize_program_is_one_time`.
- **Account substitution on withdrawal:** `RequestBody.user_shares` now also
  constrains `mint == vault.share_mint` (was owner-only).
  Test: `request_withdraw_rejects_a_foreign_share_account`.
- **Admin-only controls:** `reset_breaker`, `wind_down`, `set_params` reject
  non-admins (`admin_only_controls_reject_non_admins`); `crank_epoch` is
  time-gated and permissionless by design; `swap` enforces slippage, version,
  size, expiry and pause (`swap_enforces_slippage_version_and_size`,
  `swap_rejects_expired_quote`, `swap_stops_after_wind_down`).
Every account in every instruction is now constrained by PDA seed, address,
owner and mint. Arithmetic is checked (`arb-math`/`checked_*`); there are no
`remaining_accounts` and no arbitrary CPI. The only remaining P2 gate item is
the funded **devnet deploy + initialize_program**, scripted in
`scripts/devnet_deploy.sh`.

## A-21. Phase 3 keeper completion (2026-10-07)
- **Price source (T3.1):** `parse_hermes` decodes a Pyth Hermes
  `/v2/updates/price/latest` body into an `OracleTick` (Q64 price, confidence
  bps), matching the program's `pyth_price_q64`/`decoded_conf_bps`. A
  `PriceSource` trait returns `Ok(None)` for a stale/wide/unparseable tick so
  the loop skips it. `HermesSource` injects the HTTP transport; unit-tested
  against a fixture with no network.
- **Sender (T3.2):** `LiveSender` refreshes the blockhash and re-signs on each
  attempt (bounded `max_attempts`); a re-sent transaction is de-duplicated by
  the cluster so retries cannot double-spend an update. `adaptive_priority_fee`
  scales with volatility urgency, doubles on a jump, and is clipped to
  `[floor, cap]`. `MAX_UPDATE_COMPUTE_UNITS = 60_000` is set tightly above the
  measured 48,209 CU update cost (see `SECURITY_CHECKLIST.md`).
- **Live loop (T3.1/T3.2):** `keeper live <hermes_url> <rpc_url> ...` fetches
  Hermes, reads reserves over JSON-RPC (`getTokenAccountBalance`), and submits
  `update_quote` via `sendTransaction`. It is not run in this environment (no
  devnet keeper key), but the transaction bytes and account order are unit-tested
  offline.
- **Replay parity (T3.3):** `test_keeper_parity.py` checks the keeper's anchor,
  reservation, **spread** and depth against `quote_math.compute_quote`. The
  spread formula now matches the reference exactly: each keeper coefficient is
  the reference coefficient × 10^4, so a bps term is
  `coefficient_bps * signal_fraction` (the earlier form multiplied by 10^4
  again, making the volatility term zero — audit **F-09 fixed**). Defaults are
  aligned (`volatility_coeff_bps`/`confidence_coeff_bps` = 10_000 = 1.0, an
  inventory term is included).
- **Keeper-outage safe expiry (T3.3 gate):** `keeper_outage_lets_the_quote_expire`
  shows that with no updates the quote expires, swaps revert, and the public
  breaker pauses the vault.
- **Bond + reward (T3.4):** `KeeperBond` PDA `[b"keeper", vault, keeper]`;
  `bond_keeper` locks quote tokens in a vault-owned PDA (`[b"bond", vault]`);
  `slash_keeper` is admin-only, bounded by the bond, and sends slashed tokens to
  the quote reserve booked to insurance; `claim_keeper_reward` is keeper-only
  and pays exactly the accrued `keeper_base`/`keeper_quote` buckets then zeroes
  them. No path moves vault principal.
- **D-07 resolved (bonded keepers required when configured):** `Config.min_bond`
  (init + timelocked `set_params`) gates `update_quote`; when `min_bond > 0` the
  keeper must own a `KeeperBond` with `bond >= min_bond`, else `NotBonded`.
  `min_bond = 0` keeps the allowlist MVP. Test:
  `update_quote_requires_a_keeper_bond` (unbonded rejected, bonded accepted).

## A-22. Anchor 1.x account-constraint syntax — VERIFIED (2026-10-08)
Checked against the official Anchor docs, *Account Constraints*
(https://www.anchor-lang.com/docs/references/account-constraints), before use in
the p2 pass (no invented APIs):
- `#[account(seeds = <seeds>, bump)]` and `#[account(seeds = <seeds>, bump = <expr>)]`
  are valid. The p2-T1 fix binds `ClaimWithdraw.withdraw_ticket` and the existing
  `deposit_ticket`/`keeper_bond`/`bond_vault` use `bump = <account>.bump`.
- `#[account(address = <expr>)]` is valid (token-account / mint / reserve address binding).
- `#[account(constraint = <expr>)]` is valid (owner==user and similar predicates).
- `#[account(init_if_needed, payer = ..., space = ...)]` is valid (tickets, pending config).
- Anchor prevents **duplicate mutable accounts by default** (`dup` re-enables);
  this is the `ConstraintDuplicateMutableAccount` observed in testing.
- `token::mint`/`token::authority`/`mint::authority`/`mint::decimals` are valid.
- Anchor `declare_id!` is only used for the crate `ID` constant and the SPL
  Token `Program`/owner checks; the SBF `.so` is loaded at the test address.
Recorded because the p2 audit relies on these bindings to reject substitutions.
Pyth receiver: `PriceUpdateV2::get_price_no_older_than(&clock, max_age, &feed_id)`
returning `Price { price, conf, exponent, publish_time }` — VERIFIED by compile
and the LiteSVM Pyth tests (see A-07).

## A-23. Jupiter AMM interface (T5.4) — VERIFIED (2026-10-09)
`jup-ag/jupiter-amm-interface` exposes the `Amm` trait
(`from_keyed_account`, `label`, `program_id`, `key`, `get_reserve_mints`,
`get_accounts_to_update`, `update`, `quote`, `get_swap_and_account_metas`, …)
and a `test-kit` whose pattern is "snapshot the pool, run the SDK quote, execute
the native swap in LiteSVM, assert parity". Latest on crates.io is
`jupiter-amm-interface 1.0.0-beta.0`; `0.6.1` resolves with Rust 1.98.
**Consequence:** our `arb-aggregator` implements the pricing half
(`out_given_in`/`in_given_out`) and a LiteSVM parity test mirrors the test-kit
pattern (`aggregator_quote_matches_onchain_swap`). A full Jupiter listing needs
a matching variant in the interface's **closed `Swap` enum**, which is a
Jupiter-side change we cannot supply; documented, not worked around.

## A-24. Admin rotation / multisig (C4.3) — CLOSED-BY-DECISION (gap documented)
**Keeper rotation IS supported** via the timelocked `ParamsUpdate.keeper`
(`apply_params`; test `keeper_can_be_rotated_via_the_timelock`). **Admin rotation
is NOT supported**: `ParamsUpdate` has no `admin` field, so `vault.admin` cannot
be changed after `initialize_vault`. Required change (specified, not
implemented): add `admin: Option<Pubkey>` to `ParamsUpdate`, apply it in
`apply_params` when `Some`, grow the `PendingConfig` space accordingly
(same-commit sync of account space + `account_spaces_match_serialized_sizes`),
and test `admin_can_be_rotated_via_the_timelock`. Until then, a compromised
deployer key cannot be replaced (DoS risk). Pause-only kill switch semantics are
unchanged (`wind_down`/`reset_breaker`). Handoff: rotate the deployer keypair to
a Squads multisig at the wallet level (external, no program change needed).

## A-25. Squads multisig (B4/C4.3) — VERIFIED (2026-10-09)
Squads Protocol v4 program id **`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`**,
deployed to Solana mainnet-beta **and** devnet (Squads docs / `Squads-Protocol/v4`
README). A multisig can hold the program admin key at the wallet level; ArbSwap's
`propose_admin`/`accept_admin` are the program-side rotation. No on-chain CPI to
Squads is implemented (wallet-level custody is sufficient and avoids a cross-program
dependency).
