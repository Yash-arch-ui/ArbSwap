# INTEGRATION.md (B9d)

How the frontend reads ArbSwap data. **Read only from `artifacts/public/`.** Each
file validates against `artifacts/schema/<name>.json`; the manifest gives the
commit, flow type and sha256 of every file. Do not parse `docs/*.md`.

## Files and example payloads

### `manifest.json`
```json
{
  "schema_version": "1.0.0",
  "commit": "<git sha>", "short": "<sha7>", "generated": "2026-10-09",
  "flow_type": "synthetic (real price path)",
  "parameter_hash": "<sha256 of frozen_params.json>",
  "data_sha256": {"binance_SOLUSDT_1s_6w.csv": "..."},
  "files": {"headline.json": {"sha256": "...", "schema": "../schema/headline.json"}}
}
```

### `headline.json` — the headline numbers
```json
{
  "meta": {"commit": "...", "flow_type": "synthetic (real price path)"},
  "calibration": {"target_markout_bps": -0.2, "best_markout_bps": -0.02,
                  "target_half_spread_bps": 2.6, "best_half_spread_bps": 2.409},
  "routed_world": {"source": "real", "rows": [
    {"venue": "ArbSwap", "volume_share": 0.0, "fill_share": 0.016, "markout_2s_bps": 1.99}]},
  "e1_e4": {"W2": {"E1_pct": 686.9, "E4_arb_quiet_half_spread_bps": 8.26, ...}},
  "cost": {"cu_update_quote": 48158, "cu_swap": 59258, "sol_price": 150.0}
}
```

### `held_out.json` — per-window tables
`{"W2": {"regime": "unlabelled", "venues": {"ArbSwap": {"hedged_pnl": ..., "markout_2s_bps": ..., "quiet_half_spread_bps": ..., "gap_bps": ..., "fill_rate": ...}}}}`

### `routed_world.json` / `envelope.json` / `thesis.json`
As in `docs/DATA_SCHEMA.md`. `thesis.json.decision` is the headline decision
string ("Option 1 not shown").

### `cu.json`, `mutation.json`, `test_counts.json`
Flat tables (see `DATA_SCHEMA.md`).

### `e8_proxy.json`
`{"kind": "proxy (quote persistence), NOT a fill gap", "samples": 60, "ok": 60, "change_rate": 0.98}`

## Rules for the UI

- Show `manifest.commit` and `flow_type` on the claims/security page.
- Label every model number "model output". Never show a banned word
  (`docs/CLAIMS.md`).
- Report the losing regime (ArbSwap ~0% routed volume share) as prominently as
  any win.
- Validate on load with the schema; fail closed if `manifest.schema_version`
  is unknown.

## Not provided (by decision)

- A live HTTP API / indexer server: **CLOSED-BY-DECISION** (static files suffice;
  the frontend is a read-only demo). If added later, it must be read-only, with a
  CORS allowlist, rate limit and input validation.
- Live replay streams are generated deterministically by
  `simulation/analytics/demo.py` (fixed seed); the frontend may embed the same
  fixed-seed JSON rather than call a server.
