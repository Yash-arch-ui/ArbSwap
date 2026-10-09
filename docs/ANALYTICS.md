# ANALYTICS.md — indexer, metrics and dashboard

The analytics layer (`simulation/analytics/`) parses program events and computes
the evaluation metrics defined in `docs/FORMULA.md`. It is dependency-free
(Python standard library) and its tests reproduce the simulator's E1 and metric
values on the same run.

| Module | Role |
|---|---|
| `events.py` | Program-event model (Build Plan §6.5) and Anchor-log parser |
| `indexer.py` | `EventStore` (slot-ordered) + reconciliation of fields the chain omits |
| `metrics.py` | §8.3 metrics + attribution (markout, quiet half-spread, gap, hedged PnL, LVR, E1) |
| `charts.py` | Inline-SVG charts (no plotting library) |
| `dashboard.py` | Static HTML with the LP / trader / risk / comparison views |
| `bridge.py` | Simulator `TradeRecord` → `SwapEvent` bridge for cross-checks |
| `store.py` | SQLite-backed persistent event store (§9.1 "indexer and database") |
| `live.py` | Live indexer: polls a cluster, parses Anchor events, persists to SQLite |
| `demo.py` | Interactive demo mode: self-contained split-screen replay (scenario selector + attack buttons), deterministic and offline |

## Metric definitions (see `docs/FORMULA.md` §13)

- **Markout (bps) at τ:** `1e4 · d · (m(t+τ) − p_exec)/p_exec`, `d = +1` if the
  venue bought base, `−1` if it sold; positive = the venue gained. Report τ from
  −5 to +15 s and the 2 s value.
- **Quiet flow:** a fill where `|m(t+1s) − m(t−5s)|/m < 1 bps`.
- **Retail half-spread:** notional-weighted `1e4·|p_exec − m(t)|/m(t)` on quiet fills.
- **Hedged PnL:** `Σ [V_{t+1} − V_t − B_t·(P_{t+1} − P_t)]` (value change minus the
  delta-hedge gain on actual base holdings).
- **LVR (passive benchmark):** the constant-product identity `σ²/8 · V · T`.
- **Quote-versus-fill gap:** `1e4·(out_quoted − out_executed)/out_quoted`; positive
  = the trader got less than the quote they could have read.
- **CU per update / per swap:** measured in LiteSVM (see `docs/SECURITY_CHECKLIST.md`).

## Run

```bash
python -m simulation.analytics build --scenario crash --length 900 --out simulation/analytics/out
# writes simulation/analytics/out/{events.jsonl, metrics.json, dashboard.html}

python -m simulation.analytics demo --out simulation/analytics/out/demo.html
# interactive split-screen replay: scenario selector + attack buttons, offline

python -m simulation.analytics.live --rpc <url> --program <id> --db <path> [--once]
# poll the cluster, parse Anchor events, persist to SQLite
```

The dashboard is deterministic (fixed seeded replay), so "demo mode" never
depends on live markets. The frontend (Stage 6) will consume versioned JSON
artifacts exported here.

**Limits:** markout, quiet half-spread and the informed/noise mix are **model
outputs**, not measurements of live order flow. The 0x "39% identical / 1.08 bps
worse" observation is Base/Flashblocks and must not be presented as a Solana result.
