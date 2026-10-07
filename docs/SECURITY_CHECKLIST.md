# P1-P3 Security Checklist

| Check | Evidence | Status |
|---|---|---|
| Signer checks | `Signer` on admin, user, keeper, trader paths | Pass |
| PDA seeds/canonical bumps | Anchor `seeds` constraints on vault/config/quote/tickets | Pass |
| Pyth owner | `Account<PriceUpdateV2>` enforces Pyth Receiver owner; `pyth_account_owner_must_be_the_receiver_program` forges the owner | Pass |
| Pyth feed ID | `Config.pyth_feed_id` compared to `PriceUpdateV2` | Pass |
| Pyth verification | `get_price_no_older_than` requires `Full` verification | Pass |
| Pyth freshness | Pyth publish time checked against configured maximum age | Pass |
| Pyth price/confidence | Decoded Q64 price and confidence must equal instruction fields; `oracle_confidence_must_match_the_payload` isolates the equality check | Pass |
| Token-2022 rejection | Instructions require the classic `Program<Token>`; Token-2022 is not accepted | Pass for unsupported extensions |
| Duplicate mutable accounts | Address/mint/owner constraints on reserve and user accounts | Pass in declared contexts |
| Reinitialization | `init`/PDA constraints prevent account reuse | Pass in declared contexts |
| Checked arithmetic | `checked_*`, `arb-math`, bounded conversions | Pass |
| Unchecked remaining accounts | No `remaining_accounts` use | Pass |
| Quote expiry | Stored `expiry_slot`; swap rejects expired quotes | Pass |
| Breaker authenticity | Public breaker only trips from stored quote expiry | Pass |
| Min output/version | `min_out` and `min_version` enforced in swap | Pass |
| Secrets | `.ENV`, API keys, raw data, and generated keys ignored | Pass |
| SBF execution | LiteSVM executes the built program | Pass |
| Token-funded full lifecycle | Deposit → update_quote → swap → expiry/breaker/reset → withdraw/crank/claim in one LiteSVM fixture with global value conservation (`tests/litesvm_lifecycle.rs`) | Pass |
| Live RPC/private-key keeper | Deployment transport and devnet run | Open |
| CU measurements | LiteSVM `compute_units_consumed`: `update_quote` 12,802, `trip_breaker` 7,051, `swap` 33,676 | Pass |
| Foreign program rejection | Token-2022 owned accounts rejected by `Program<Token>` before the instruction body | Pass |
| Wind-down control | Admin-only `wind_down`, then `update_quote` is `Paused` (`wind_down_is_admin_only_and_pauses_quotes`) | Pass |
| Update-slot monotonicity | `stored < update_slot <= clock.slot`; a future slot is rejected (`future_update_slot_is_rejected`) | Pass |
| Keeper quote parity | Inventory skew is decimal-aware (F-03) and the spread/depth/directional terms match the reference (F-09); `research/sim/test_keeper_parity.py` + keeper unit tests | Pass for the tested cases; EWMA time-normalisation still open |
| Executed-level binding | On-chain `swap` accepts keeper `levels` on shape alone, not bound to the anchor (F-04) | **Open — top devnet blocker** |

## Compute budget

LiteSVM reports the exact units each instruction consumes. Its transaction
default is 200,000 CU, so the lifecycle fixture raises the limit to 1,400,000
CU to *measure* true consumption rather than hitting the ceiling.

| Instruction | CU |
|---|---|
| `update_quote` | 12,802 |
| `trip_breaker` | 7,051 |
| `swap` | 33,676 |

Every instruction now fits the 200,000 CU transaction default, so no caller
needs a `ComputeBudgetProgram` bump. After the Task 2 division rewrite,
`swap` fell 201,119 → 33,676 CU: `arb_math::wide::U256::div_rem` was a 256-round
restoring shift-subtract and is now Knuth Algorithm D over 64-bit limbs, and
`U256::isqrt` is Newton's method seeded from the bit length. Both are
bit-identical to the old routines (differential fuzz test in
`crates/arb-math/tests/properties.rs`). `update_quote` is unchanged at 12,802 CU:
it does not walk the ladder and is dominated by Anchor account validation and
Pyth verification. `trip_breaker` measures 7,051 CU alone; it can read 10,051 CU
when the breaker and lifecycle binaries share one `cargo test` invocation — a
harness artifact that explains the earlier 7,051/10,051 mismatch (see
ASSUMPTIONS A-17).

No mainnet or funded deployment is approved while the Live RPC/private-key
keeper row remains Open.
