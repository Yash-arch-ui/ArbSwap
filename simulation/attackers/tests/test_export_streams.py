"""S2-38 Phase 3.1: the demo/attack stream export is deterministic and matches
the committed bundle. No network, no funds."""
from __future__ import annotations

import json
import pathlib

from simulation.attackers.export_streams import build

ROOT = pathlib.Path(__file__).resolve().parents[3]
EXPECTED = {"calm", "trend", "crash", "jump", "freeze", "kill", "bot", "malicious"}


def _canon(d: dict) -> str:
    return json.dumps(d, sort_keys=True)


def test_scenarios_present_and_equal_length() -> None:
    data = build()
    assert set(data["streams"]) == EXPECTED
    steps = data["meta"]["steps"]
    for name, s in data["streams"].items():
        assert len(s["mid"]) == steps, name
        assert len(s["arbSwap"]) == steps and len(s["passive"]) == steps, name


def test_deterministic_and_matches_committed() -> None:
    a = build()
    b = build()
    assert _canon(a) == _canon(b), "generator must be deterministic"
    committed = json.loads((ROOT / "artifacts" / "public" / "demo_streams.json").read_text())
    assert _canon(a) == _canon(committed), "committed stream is stale; regenerate export_streams"


def test_attack_events_are_labelled() -> None:
    data = build()
    assert data["streams"]["kill"]["events"], "kill must record an event"
    assert data["streams"]["freeze"]["events"], "freeze must record an event"
