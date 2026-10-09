# DATA_SCHEMA.md (B9)

The machine-readable data contract for the UI. Every file lives under
`artifacts/public/`, has a JSON Schema at `artifacts/schema/<name>.json`, and is
listed (with a sha256) in `artifacts/public/manifest.json`. Regenerate with
`scripts/publish_artifacts.py`; validation tests:
`simulation/analytics/tests/test_artifacts_public.py`.

**Every number is a model output** (synthetic flow on a real price path) unless a
file says otherwise. Not a product result.

| File | Schema | Units / notes |
|---|---|---|
| `manifest.json` | — | `schema_version`, `commit`, `generated`, `flow_type`, `parameter_hash`, `data_sha256`, per-file `sha256` |
| `headline.json` | ✓ | `meta`, `calibration`, `routed_world`, `e1_e4`, `cost` |
| `held_out.json` | ✓ | W2–W6 per-venue: `hedged_pnl` (quote), `markout_2s_bps`, `quiet_half_spread_bps`, `gap_bps`, `fill_rate` (0–1) |
| `routed_world.json` | ✓ | per-venue `volume_share`, `fill_share` (0–1), `markout_2s_bps` |
| `envelope.json` | ✓ | array of `{regime, vault_fee_bps, prop_half_spread_bps, arb_volume_share, arb_markout_2s_bps, deploy_ok}` |
| `cu.json` | ✓ | `instructions`: `{name: compute_units}` + `so_sha256`, `build_method` |
| `mutation.json` | ✓ | `total`, `caught`, `source` |
| `test_counts.json` | ✓ | `rust`, `python` |
| `thesis.json` | ✓ | `T_A`, `T_B`, `T_C`, `calibration`, `envelope`, `decision` |
| `e8_proxy.json` | ✓ | quote-persistence proxy (`kind`, `samples`, `ok`, `change_rate`) — **not a fill gap** |

## Units

- Prices: quote (USDC) per base (SOL).
- `*_bps`: basis points (1 bps = 1/10,000).
- `hedged_pnl`: quote units.
- Shares (`volume_share`, `fill_share`, `fill_rate`): fraction in [0, 1].
- `cu`: compute units.

## Status

- B9a schemas + docs: **PASS**.
- B9b `artifacts/public` + manifest + validation tests: **PASS**.
- B9c read-only HTTP server: **CLOSED-BY-DECISION** (the static files suffice for
  the frontend; a server would add attack surface with no benefit for a static
  demo — documented, not built).
- B9d `docs/INTEGRATION.md`: **PASS**.
