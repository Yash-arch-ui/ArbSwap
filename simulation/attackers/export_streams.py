"""S2-38 Phase 3.1: export reproducible demo/attack scenario streams.

Deterministic, offline. Uses the verified price-path simulator
(`simulation.sim.price_source.synthetic_series`) for the mid series and a simple,
explicit PnL model (`half-spread` minus `adverse selection`) for the two venues.
It writes:

- ``artifacts/public/demo_streams.json`` — the published bundle stream;
- ``app/src/data/demoStreams.json`` — the same bytes bundled into the frontend so
  the demo makes **no runtime network calls**;
- ``artifacts/schema/demo_streams.schema.json`` — the schema.

Same seed => identical bytes. No profitable scenario is invented; attack rows are
containment illustrations, not economic proof.

Run: ``.venv/bin/python simulation/attackers/export_streams.py``
"""
from __future__ import annotations

import json
from pathlib import Path

from simulation.sim.price_source import synthetic_series

ROOT = Path(__file__).resolve().parents[2]
SEED = 20261014
STEPS = 240
START_PRICE = 107.0

# scenario -> (regime, spread, adverse, freeze_at, kill_at, bot_at)
SCENARIOS: dict[str, dict] = {
    "calm": {"regime": "calm", "spread": 0.0009, "adverse": 0.0006},
    "trend": {"regime": "trend", "spread": 0.0009, "adverse": 0.0008},
    "crash": {"regime": "crash", "spread": 0.0009, "adverse": 0.0011},
    "jump": {"regime": "jump", "spread": 0.0009, "adverse": 0.0009},
    "freeze": {"regime": "calm", "spread": 0.0009, "adverse": 0.0009, "freeze_at": 0.3},
    "kill": {"regime": "calm", "spread": 0.0009, "adverse": 0.0007, "kill_at": 0.2},
    "bot": {"regime": "trend", "spread": 0.0009, "adverse": 0.0016, "bot_at": 0.3},
    "malicious": {"regime": "trend", "spread": 0.0009, "adverse": 0.0014},
}


def _mid_path(regime: str) -> list[float]:
    pts = synthetic_series(regime=regime, length=STEPS, start_price=START_PRICE, seed=SEED)
    return [round(float(p.price), 6) for p in pts]


def build() -> dict:
    streams: dict[str, dict] = {}
    for name, cfg in SCENARIOS.items():
        mid = _mid_path(cfg["regime"])
        arb = 0.0
        passive = 0.0
        arb_series: list[float] = []
        passive_series: list[float] = []
        events: dict[str, str] = {}
        for i in range(STEPS):
            if cfg.get("freeze_at") is not None and i >= STEPS * cfg["freeze_at"] and "frozen" not in events:
                events[str(i)] = "oracle frozen"
            if cfg.get("kill_at") is not None and i >= STEPS * cfg["kill_at"] and "killed" not in events:
                events[str(i)] = "keeper killed — quotes expire"
            if cfg.get("bot_at") is not None and i >= STEPS * cfg["bot_at"] and "bot" not in events:
                events[str(i)] = "flow cap binds"
            if name == "malicious" and i == int(STEPS * 0.6):
                events[str(i)] = "breaker trips"

            prev = mid[i - 1] if i > 0 else mid[0]
            active = True
            frozen = cfg.get("freeze_at") is not None and i >= STEPS * cfg["freeze_at"]
            killed = cfg.get("kill_at") is not None and i >= STEPS * cfg["kill_at"]
            if frozen:
                mid[i] = prev  # oracle frozen: reference stops moving
            if killed:
                active = False
            adverse = cfg["adverse"]
            arb += (cfg["spread"] - adverse) * mid[i] * 0.1 if active else 0.0
            passive += -adverse * 1.4 * mid[i] * 0.1
            arb_series.append(round(arb, 6))
            passive_series.append(round(passive, 6))
        streams[name] = {"mid": mid, "arbSwap": arb_series, "passive": passive_series, "events": events}
    return {
        "meta": {
            "generator": "simulation.attackers.export_streams",
            "version": "1.0.0",
            "seed": SEED,
            "steps": STEPS,
            "label": "simulation, no funds involved",
            "note": "Illustrative containment model; not economic proof and not on-chain data.",
        },
        "streams": streams,
    }


def main() -> None:
    data = build()
    text = json.dumps(data, indent=2, sort_keys=True) + "\n"
    pub = ROOT / "artifacts" / "public" / "demo_streams.json"
    app = ROOT / "app" / "src" / "data" / "demoStreams.json"
    schema = ROOT / "artifacts" / "schema" / "demo_streams.schema.json"
    pub.parent.mkdir(parents=True, exist_ok=True)
    app.parent.mkdir(parents=True, exist_ok=True)
    schema.parent.mkdir(parents=True, exist_ok=True)
    pub.write_text(text)
    app.write_text(text)
    schema.write_text(json.dumps({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "demo_streams",
        "type": "object",
        "required": ["meta", "streams"],
        "properties": {
            "meta": {"type": "object", "required": ["generator", "seed", "steps"]},
            "streams": {
                "type": "object",
                "additionalProperties": {
                    "type": "object",
                    "required": ["mid", "arbSwap", "passive", "events"],
                    "properties": {
                        "mid": {"type": "array", "items": {"type": "number"}},
                        "arbSwap": {"type": "array", "items": {"type": "number"}},
                        "passive": {"type": "array", "items": {"type": "number"}},
                        "events": {"type": "object"},
                    },
                },
            },
        },
    }, indent=2) + "\n")
    print(f"wrote {pub.name}, {app.name}, {schema.name} ({len(data['streams'])} streams, {STEPS} steps)")


if __name__ == "__main__":
    main()
