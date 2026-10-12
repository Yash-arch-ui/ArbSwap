# ArbSwap Backend Pipeline — End-to-End

This document describes the **working** backend pipeline: how a quote is
produced, how a swap executes on-chain, and what happens before and after a
swap. It reflects the code in `vault/program`, `vault/math`, `vault/keeper`, and
the B1 price-scaling fix.

Scope: one vault = one base/quote mint pair (e.g. tSOL/tUSDC 9/6 or WSOL/USDC
9/6). Program id `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` (devnet).

---

## 0. Components

| Component | Path | Role |
|---|---|---|
| Anchor program | `vault/program/src/lib.rs` | Custody, shares, quote state, swap, guards, breakers |
| Shared integer math | `vault/math/src/` | Fixed-point ladder / constant-product swap math |
| Keeper | `vault/keeper/src/` | Reads Pyth, computes the quote, submits `update_quote` |
| App | `app/` | Reads on-chain state, builds deposits/swaps/withdrawals |
| Analytics | `app/public/artifacts/` + `simulation/` | Replay/model metrics |

Accounts (PDAs): `vault = [b"vault", base_mint, quote_mint]`,
`config = [b"config", vault]`, `quote_state = [b"quote", vault]`,
`bond_vault = [b"bond", vault]`, `deposit_ticket = [b"dep", vault, user]`,
`withdraw_ticket = [b"wd", vault, user]`, `keeper_bond = [b"keeper", vault, keeper]`.

---

## 1. Price semantics (the B1 fix — this is what makes the pipeline work)

There are two different prices, and mixing them was the B1 bug:

1. **Human oracle price** — `quote per base`, e.g. USDC per SOL (`$150`). This
   is what Pyth publishes (`price`, `exponent`).
2. **Executable token-unit price** — `quote-atoms per base-atom`. Token amounts
   are raw atoms (`u64`), so the ladder, the stored `oracle_price`, and the swap
   math must all use this unit.

The conversion is deterministic and derived from the vault's **own mint
decimals**:

```
P_token = P_human * 10^(quote_decimals - base_decimals)      # e.g. 9/6 -> /1000
```

- Keeper: `normalize_price_q64` (`vault/keeper/src/lib.rs`).
- Program: `normalize_pyth_price_q64` in `vault/program/src/lib.rs`, applied to
  the **verified** Pyth value during `update_quote`.
- `update_quote` also requires the submitted `oracle_price` to equal this
  on-chain-computed value, so a keeper **cannot** submit an arbitrary scaled
  number. The `base_mint`/`quote_mint` accounts are passed to `update_quote` and
  bound by address to `vault.base_mint`/`vault.quote_mint` (`#[account(address=…)]`),
  so incorrect mint accounts / decimals cannot bypass the check.

For a 9-decimal base and 6-decimal quote, `P_token = P_human / 1000`. For 9/9 it
is the identity. Regression tests: `vault/program/tests/litesvm_oracle_scaling.rs`.

---

## 2. Quoting (keeper → on-chain), before any swap

1. **Read oracle** (`vault/keeper/src/main.rs` live loop): read the Pyth
   `PriceUpdateV2` account over RPC; verify feed id; reject if `price <= 0`,
   stale (`now - publish_time > max_staleness`), or confidence too wide.
2. **Compute the quote** (`vault/keeper/src/lib.rs::compute_quote`):
   - volatility EWMA + jump flag,
   - inventory skew `q` from reserves,
   - reservation price `P_res = P_token * (1 - g*q)`,
   - half-spread `s = clamp(s_floor + a1σ + a2|q| + a3(c/P) + age + jump, s_min, s_max)`,
   - directional add-on (ask/bid extra),
   - depth throttle (LVR budget),
   - 6-level ask/bid ladder (constant-product segments) with per-level liquidity.
3. **Submit `update_quote(QuoteUpdate)`**.
4. **Program validation** (`vault/program/src/lib.rs::update_quote`), in order:
   - `status == Active`;
   - keeper authorized (`config.keeper`; if `min_bond > 0`, the bond PDA and amount);
   - `update_slot` strictly greater than stored and `<= clock.slot`, and
     `clock.slot - update_slot <= max_update_slot_age`;
   - Pyth verified via `get_price_no_older_than` (feed + staleness);
   - `price.publish_time == update.oracle_publish_time`;
   - **`normalize_pyth_price_q64(pyth_q64, base_dec, quote_dec) == update.oracle_price`**;
   - `oracle_conf_bps` matches the decoded confidence;
   - `half_spread_bps` within `[min_spread_bps, max_spread_bps]`; ladder offsets
     strictly increasing; weights sum to 10 000;
   - anchor within the oracle deviation band and within `max_anchor_step` of the
     previous anchor;
   - ladder capacity within `utilization_max × available reserves`;
   - per-window cumulative flow cap.
5. **Store** `QuoteState`: `anchor_sqrt_price`, `p_res_sqrt`, spreads, depth,
   levels, `oracle_price` (token units), `version += 1`, `flow_n = 0`,
   `expiry_slot = slot + expiry_slots`.

Result: `QuoteState` is a self-contained, token-unit, expiring quote.

---

## 3. Before a swap (trader / aggregator)

1. Read `QuoteState` (anchor, levels, spread, `version`, `expiry_slot`).
2. Compute the expected output and a `min_out`; choose `min_version`.
3. Build `swap(side, amount_in, min_out, min_version)` with accounts
   `trader, vault, config, quote_state, base_reserve, quote_reserve, trader_base,
   trader_quote, token_program`; wallet signs; send.

## 4. During a swap (on-chain) — `vault/program/src/lib.rs::swap`

1. `vault.status == Active` (`Paused`), `quote_state.version >= min_version`
   (`VersionTooOld`), `clock.slot < expiry_slot` (`QuoteExpired`),
   `0 < amount_in <= max_quote_size` (`CapacityExceeded`).
2. `fee = ceil(amount_in * fee_bps / 10_000)`; `net = amount_in - fee`.
3. Choose the ladder: `BuyBase` lifts the **ask** levels; `SellBase` hits the
   **bid** levels.
4. `walk_ladder` (`arb_math`) fills constant-product segments across levels;
   partial remainder is carried down the ladder. If it cannot fill fully:
   `CapacityExceeded`.
5. `out >= min_out` (`SlippageExceeded`) — the honesty guarantee.
6. Window flow cap (`FlowCapExceeded`); update `flow_n` and window counters.
7. Token movements (vault PDA signs): `BuyBase` pulls quote in and pays base
   out; `SellBase` pulls base in and pays quote out.
8. Split `fee` into insurance / keeper / protocol buckets (liabilities held in
   the reserves).
9. Emit `Swap { side, amount_in, out, version, slot }`.
10. Any failed `require!` reverts the whole transaction; the trader loses only
    the network fee.

## 5. After a swap

1. Indexer/analytics parse `Swap`; compute markouts, quote-vs-fill gap, LVR.
2. Keeper sees the new reserves on its next tick; inventory skew moves `P_res`
   and it republishes (`flow_n` resets on update).
3. Fees accrue to insurance/keeper/protocol buckets; LP share value moves with
   fees − LVR.
4. App re-reads balances, `Vault`, and `QuoteState`.

---

## 6. Deposit (LP capital)

`vault/program/src/lib.rs::deposit(base_amount, quote_amount, min_shares)`:

1. `status == Active`; both amounts `> 0`.
2. LP-available reserves exclude the fee buckets.
3. First deposit: `shares = floor(sqrt(base_amount*quote_amount)) - min_liquidity`
   (the minimum-liquidity shares are minted to `share_lock` permanently). Later
   deposits: `shares = min(base_amount*S/B, quote_amount*S/Q)`.
4. `shares >= min_shares` and `shares > 0`; only the proportional amount is
   pulled.
5. Mint shares; write `deposit_ticket` with `activate_slot = slot + warmup_slots`.

## 7. Withdraw (epoch queue)

1. `request_withdraw(shares)` after warm-up; queues a `withdraw_ticket` for the
   current epoch.
2. `crank_epoch` advances `epoch` when `epoch_start + epoch_slots` elapses.
3. `claim_withdraw` pays `out_base = shares*B/S`, `out_quote = shares*Q/S`,
   pro-rata, honoring available liquidity.

## 8. Breakers / safety failure

- `trip_breaker` (permissionless, state-only) pauses quoting on stale oracle,
  wide confidence, or a volatility/edge condition; `reset_breaker` is admin-only.
- If the keeper stops, `expiry_slot` passes and `swap` returns `QuoteExpired` —
  the vault stops filling rather than filling a stale price.

---

## 9. Verify the pipeline

```bash
cargo fmt --all -- --check
cargo test --workspace            # incl. LiteSVM oracle/lifecycle/breaker
cargo build-sbf --manifest-path vault/program/Cargo.toml
python3 -m pytest simulation -q
```

Key tests: `litesvm_oracle_scaling.rs` (B1 price semantics),
`litesvm_lifecycle.rs` (deposit→update→swap→withdraw), `litesvm_breaker.rs`,
`litesvm_security.rs`, plus the keeper's `compute_quote` / `prevalidate_quote`.

## 10. Status / limitations

- **B1 is fixed in source and tests**: the program derives the token-unit price
  on-chain from the verified oracle and bound mints, and the keeper submits the
  same normalized value. This changed the `update_quote` account list
  (adds `base_mint`, `quote_mint`) and therefore requires a **program redeploy**
  to take effect on devnet; local tests pass against the rebuilt SBF artifact.
- No live keeper has been re-run since the fix; live confirmation is a separate
  step (and requires funded reserves).
- A trapped oracle/keeper causes safe quote expiry, not a bad fill.
