# PRIOR_ART.md (C4.6)

Comparison with documented prior art on Solana, from **official/public sources
only**. We make no claim about the internals of any competitor that is not
publicly documented. Sources are listed; anything not verified is marked.

## Lifinity (the closest prior art)

Documented facts (Lifinity docs + Solana Compass review):

- Uses an **oracle as the main pricing mechanism** rather than pool balances;
  trades only when the oracle updated in the current slot and confidence is
  narrow (`docs.lifinity.io/dex/oracle`).
- **Concentrated liquidity** with automatic, **delayed rebalancing**; profit is
  described as coming from rebalancing trades (`docs.lifinity.io/`).
- **Protocol-owned liquidity only**: "External users could not add liquidity to
  Lifinity pools" (`solanacompass.com/projects/lifinity`). Fee revenue accrues to
  the protocol / LFNTY holders.
- Wound down December 2025 (`lifinity.io`, `solanacompass.com/projects/lifinity`).

## propAMMs (HumidiFi, SolFi, Tessera, BisonFi, …)

- Closed, operator-run pools; the operator's own capital; pricing not public
  (Build Plan §1.5; Solmaz et al. §2). **Internals not verified here.**

## How ArbSwap differs (documented, testable)

| Dimension | Lifinity | propAMMs | **ArbSwap** |
|---|---|---|---|
| Capital | protocol-owned only | operator-owned | **open pooled (anyone deposits, pro-rata shares)** — `vault/program` |
| Pricing input | custom/Pyth oracle | private | Pyth-verified oracle, **on-chain bounded** ladder |
| Execution honesty | not documented publicly | not documented publicly | **versioned quotes + `min_out`/`min_version` + expiry**, quote-vs-fill gap measured (`docs/CLAIMS.md`) |
| Keeper | n/a (protocol) | operator | **bonded keepers, on-chain bounds, timelocked rotation, unbond** |
| Depth throttle | not documented | not documented | LVR-derived throttle, **keeper-side policy bounded by on-chain caps** |
| Measurement | not published | not published | markouts, LVR, hedged PnL, gap, **published methodology + losing regimes** |
| Status | wound down 2025 | live | devnet only |

## Risks / honesty

- We cannot compare **execution quality** to live competitors: E8 is a **proxy
  only** (quote persistence), not a fill gap (needs funded mainnet trades).
- "Open + honest + bounded" is a **design** claim; its economic value is **not
  demonstrated** (`docs/THESIS.md`: T-A not shown).
- The propAMM-like venue in our simulator is a **model**, not a measured
  competitor (`docs/RESULTS.md`).
