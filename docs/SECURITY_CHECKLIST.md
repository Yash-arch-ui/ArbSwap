# P1-P3 Security Checklist

| Check | Evidence | Status |
|---|---|---|
| Signer checks | `Signer` on admin, user, keeper, trader paths | Pass |
| PDA seeds/canonical bumps | Anchor `seeds` constraints on vault/config/quote/tickets | Pass |
| Pyth owner | `Account<PriceUpdateV2>` enforces Pyth Receiver owner | Pass |
| Pyth feed ID | `Config.pyth_feed_id` compared to `PriceUpdateV2` | Pass |
| Pyth verification | `get_price_no_older_than` requires `Full` verification | Pass |
| Pyth freshness | Pyth publish time checked against configured maximum age | Pass |
| Pyth price/confidence | Decoded Q64 price and confidence must equal instruction fields | Pass |
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
| CU measurements | LiteSVM `compute_units_consumed`: `update_quote` 12,802, `trip_breaker` 7,051, `swap` 201,119 | Pass |
| Foreign program rejection | Token-2022 owned accounts rejected by `Program<Token>` before the instruction body | Pass |

## Compute budget

LiteSVM reports the exact units each instruction consumes. Its transaction
default is 200,000 CU, so the lifecycle fixture raises the limit to 1,400,000
CU to *measure* true consumption rather than hitting the ceiling.

| Instruction | CU |
|---|---|
| `update_quote` | 12,802 |
| `trip_breaker` | 7,051 |
| `swap` | 201,119 |

`swap` exceeds the 200,000 CU transaction default, so a caller must attach a
`ComputeBudgetProgram` instruction requesting at least ~250,000 CU (mainnet
maximum per transaction is 1,400,000). Every other instruction fits the
default. The dominant cost is the 256-iteration restoring division in
`arb_math::wide::U256::div_rem`, used by the Q64.64 ladder walk.

No mainnet or funded deployment is approved while the Live RPC/private-key
keeper row remains Open.
