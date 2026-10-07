# Analytics (indexer + metrics + dashboard)

Phase 4 implementation of Build Plan §9. Dependency-free (Python standard
library only), so it installs alongside the research requirements and the tests
run in CI.

| Module | Role |
|---|---|
| `events.py` | Program-event model (Build Plan §6.5), Anchor-log Borsh parser, JSONL I/O |
| `indexer.py` | `EventStore` (slot-ordered) + reconciliation of the fields the chain omits (`mid_at_fill`, `quoted_out`) |
| `metrics.py` | Independent §8.3 metrics + attribution (markout curve, quiet half-spread, gap stats, hedged PnL, LVR, E1) |
| `charts.py` | Inline-SVG line/bar/multi-series charts (no plotting library) |
| `dashboard.py` | Static HTML with the LP / trader / risk / comparison views (§9.2) |
| `bridge.py` | Simulator (`TradeRecord`) → `SwapEvent` bridge so tests check the two implementations against each other |

## Run

```bash
python -m analytics build --scenario crash --length 900 --out analytics/out
# writes analytics/out/{events.jsonl, metrics.json, dashboard.html}
```

The dashboard is deterministic: it replays a fixed scenario, so "demo mode"
never depends on live markets (§9.2).

## Metrics

`analytics/metrics.py` implements §8.3 from the specification (not imported from
the simulator), including the markout sign convention (positive = the venue
gained), the quiet-flow split, the quote-versus-fill gap distribution, hedged
PnL, the constant-product LVR identity `sigma^2/8 * V * T`, and an attribution
that decomposes hedged PnL into fees − gas − adverse selection. The integration
tests assert these equal the simulator's independently computed values on the
same run, and that E1 computed from the event pipeline equals the simulator's
E1. Citations and formulas are in `docs/ANALYTICS.md`.
