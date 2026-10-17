# Public LVR Transparency Plan

## Objective

Expose LVR history to LPs and traders in the frontend. The public view must show
how the active quoting model compares with a passive AMM baseline, while making
the benchmark, data source, and estimation limits explicit.

LVR should be a user-facing metric, not a company-only metric. Internal
telemetry can remain more detailed, but users need enough public history to
evaluate liquidity outcomes.

## Current State

- The Analytics page has an LVR section, but displays `N/A` when no replayed
  series is available.
- Live quote price, spread, depth, expiry, oracle state, and configured risk
  limits are already available to the frontend.
- The vault does not store an exact historical LVR series on-chain.
- Historical LVR therefore requires indexed quote, execution, and benchmark
  price data.

## Public Metrics

The first release should show:

1. Passive-AMM baseline LVR by day.
2. ArbSwap realized markout or modeled LVR by day.
3. Trading fees earned by the vault.
4. Estimated net LP impact: fees minus estimated LVR.
5. Number of swaps, quoted volume, and observation coverage.
6. A date range, last-updated timestamp, and data completeness indicator.

Each value must be labeled as one of:

- `On-chain verified`: read directly from deployed accounts or confirmed
  transactions.
- `Indexed`: reconstructed from confirmed on-chain events and transactions.
- `Modeled`: calculated against a documented benchmark and historical data.

## Methodology

Use a fixed benchmark definition for every period:

1. Capture the vault mid-price and executable ladder before each fill.
2. Capture a reference mid-price from the configured oracle and selected venue
   feed at the markout horizon.
3. Calculate adverse selection using the signed difference between execution
   price and reference price.
4. Aggregate adverse selection by time window and liquidity unit.
5. Compare the result with the passive-AMM baseline under the same price path,
   flow, and fee assumptions.
6. Report gross LVR, fees, and net impact separately. Do not combine them into
   one unlabeled performance number.

The initial release may use a modeled replay series. It must include the exact
formula, benchmark feeds, markout horizon, sample count, and exclusions beside
the chart.

## Data Contract

Add a versioned artifact such as `data/public/lvr_history.json` with:

```json
{
  "schema_version": 1,
  "generated_at": "2026-01-01T00:00:00Z",
  "benchmark": "pyth_mid_plus_venue_mid",
  "markout_seconds": 2,
  "rows": [
    {
      "date": "2026-01-01",
      "swaps": 0,
      "volume_usd": 0,
      "passive_lvr_usd": 0,
      "arbswap_lvr_usd": 0,
      "fees_usd": 0,
      "net_lp_impact_usd": 0,
      "coverage_bps": 10000,
      "status": "modeled"
    }
  ]
}
```

The pipeline must reject malformed rows, missing benchmark metadata, negative
coverage, and silently substituted zero values. Missing data should render as
`Unavailable`, not as zero.

## Frontend Surface

Add a public `LVR History` panel to Analytics and a compact summary card to the
Vault page:

- Daily chart: passive baseline, ArbSwap result, and fees.
- Net LP impact table with period totals.
- Coverage and methodology status beside every chart.
- Expandable methodology note with formula and benchmark details.
- Download link for the exact JSON artifact used by the chart.
- Empty state explaining why history is unavailable and what data is missing.

The UI must not use fabricated zeros, unsupported claims, or imply that LVR is
eliminated. A positive or negative result must remain traceable to the artifact
and its benchmark.

## Implementation Order

1. Define and test the LVR calculation and benchmark schema.
2. Build a replay/indexing job from confirmed quote and swap data.
3. Generate the versioned public artifact and validate coverage.
4. Add frontend parsing, charting, table, status labels, and download support.
5. Add tests for missing data, partial coverage, schema changes, and metric
   calculations.
6. Publish the first artifact and link its commit/data hash in the UI.

## Acceptance Criteria

- LPs can see daily LVR, fees, and net impact without a wallet connection.
- Every number has a benchmark, period, unit, and status label.
- The chart remains usable when data is missing or partially covered.
- The downloadable artifact exactly matches displayed values.
- Tests prove that missing data is not converted to zero.
- The page clearly separates on-chain facts from indexed and modeled metrics.

## Implementation status (2026-10-17, branch `LVR`)

Shipped end-to-end as a **frontend + Python analytics + published JSON** change.
No Solana program or on-chain configuration was touched.

- **Generator:** `simulation/analytics/lvr.py` builds a **modeled** artifact from
  the weekly replay (`simulation/data/results/window_results.json`). Wired into
  `scripts/export_artifacts.py` (regenerated + bundled as `lvr`) and
  `scripts/publish_artifacts.py` (published with a JSON Schema + manifest hash).
- **Artifact:** `artifacts/public/lvr_history.json` (published) and
  `app/public/analytics/lvr_history.json` (served; byte-identical).
- **Frontend:** strict parser `app/src/data/lvrHistory.ts`, panel
  `app/src/components/LvrHistoryPanel.tsx` (mounted in Analytics), and a compact
  `app/src/components/LvrSummaryCard.tsx` in the Vault page replacing the
  hardcoded `lvrAvoided7dUsd: 0`.
- **Tests:** `simulation/analytics/tests/test_lvr.py` (22),
  `simulation/sim/test_lvr_simulation.py` (5, runs actual simulated swaps), and
  `app/test/lvrHistory.test.ts` (23), including served == published and
  missing ≠ zero.

**Honest status of each metric (first release):**

| Metric | Status | Why |
|---|---|---|
| `passive_lvr_usd` | **Modeled** | `(σ²/8)·V·T` on the passive venue's initial value (existing simulator output). |
| `fees_usd` | **Modeled** | Gross fee = ArbSwap turnover × `vault_fee_bps`; bucket split / LP-retained net not modeled. |
| `arbswap_markout_2s_bps` | **Modeled (proxy)** | 2 s execution markout; an adverse-selection proxy, **not** LVR. |
| `lvr_reduction_pct` — **Modeled E1: Hedged-PnL Improvement vs Passive Baseline** | **Modeled (relative)** | `(ArbSwap hedged PnL − passive baseline hedged PnL) / abs(passive baseline hedged PnL) × 100`. Not an LVR amount and not a measured LVR reduction; **denominator-sensitive** (a small passive baseline inflates the %), and the two venues may execute different volumes — not an apples-to-apples profitability claim. |
| `arbswap_lvr_usd` | **Unavailable** | No measured ArbSwap LVR; markout is not renamed to LVR. |
| `net_lp_impact_usd` | **Unavailable** | Needs compatible fees + ArbSwap LVR. |
| Passive-AMM benchmark | **Supported (modeled)** | The passive counterfactual genuinely exists in the replay. |

Windows are 7-day replay periods, not calendar days; rows are **not** daily
observations. Real/`Indexed` daily LVR would need continuous indexing of quotes,
swaps and a reference feed (a data-availability task, not a code/deploy delay).
