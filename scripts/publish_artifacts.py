#!/usr/bin/env python3
"""B9 - publish the machine-readable data contract for the frontend.

Reads the C1 bundle (`simulation/data/results/artifacts.json`) plus the thesis,
envelope, CU, mutation and E8 artifacts, and writes:

- ``artifacts/public/*.json`` - the files the UI reads (no prose, no secrets).
- ``artifacts/schema/*.json`` - a JSON Schema per file.
- ``artifacts/public/manifest.json`` - schema version, commit, data hashes,
  generation date, flow type, frozen-parameter hash, and a sha256 per file.

The UI must read only from ``artifacts/public`` (see ``docs/INTEGRATION.md``).
Run: ``.venv/bin/python scripts/publish_artifacts.py``
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "simulation" / "data" / "results"
PUBLIC = ROOT / "artifacts" / "public"
SCHEMA = ROOT / "artifacts" / "schema"
SCHEMA_VERSION = "1.0.0"

_NUM = {"type": "number"}
_STR = {"type": "string"}
_NULLABLE_NUM = {"type": ["number", "null"]}

SCHEMAS: dict[str, dict] = {
    "headline.json": {
        "type": "object",
        "required": ["meta", "calibration", "routed_world", "e1_e4", "cost"],
        "properties": {
            "meta": {"type": "object", "required": ["commit", "date", "flow_type"]},
            "calibration": {"type": "object"},
            "routed_world": {"type": "object", "required": ["rows"]},
            "e1_e4": {"type": "object"},
            "cost": {"type": "object"},
        },
    },
    "held_out.json": {
        "type": "object",
        "additionalProperties": {
            "type": "object",
            "required": ["regime", "venues"],
            "properties": {
                "regime": _STR,
                "sigma_per_sqrt_s": _NULLABLE_NUM,
                "log_return_7d": _NULLABLE_NUM,
                "venues": {"type": "object"},
            },
        },
    },
    "routed_world.json": {
        "type": "object",
        "required": ["source", "rows"],
        "properties": {
            "source": {"type": ["string", "null"]},
            "rows": {"type": "array", "items": {
                "type": "object",
                "required": ["venue", "volume_share", "fill_share", "markout_2s_bps"],
                "properties": {
                    "venue": _STR, "volume_share": _NUM,
                    "fill_share": _NUM, "markout_2s_bps": _NUM,
                },
            }},
        },
    },
    "envelope.json": {"type": "array", "items": {"type": "object"}},
    "cu.json": {
        "type": "object",
        "required": ["instructions"],
        "properties": {"instructions": {"type": "object"}},
    },
    "mutation.json": {
        "type": "object",
        "required": ["total", "caught", "source"],
        "properties": {"total": {"type": "integer"}, "caught": {"type": "integer"}, "source": _STR},
    },
    "test_counts.json": {
        "type": "object",
        "required": ["rust", "python"],
        "properties": {"rust": {"type": "integer"}, "python": {"type": "integer"}},
    },
    "thesis.json": {
        "type": "object",
        "required": ["T_A", "T_B", "T_C", "decision"],
        "properties": {"T_A": {"type": "object"}, "T_B": {"type": "object"},
                       "T_C": {"type": "object"}, "decision": _STR},
    },
    "e8_proxy.json": {
        "type": "object",
        "required": ["kind", "samples", "ok"],
        "properties": {"kind": _STR, "samples": {"type": "integer"},
                       "ok": {"type": "integer"}, "change_rate": _NULLABLE_NUM},
    },
}


def _load(name: str, default):
    path = RESULTS / name
    return json.loads(path.read_text()) if path.exists() else default


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True,
                          check=True).stdout.strip()


def build() -> dict:
    bundle = _load("artifacts.json", {})
    meta = bundle.get("meta", {})
    files = {
        "headline.json": {
            "meta": meta,
            "calibration": bundle.get("calibration", {}),
            "routed_world": bundle.get("routed_world", {}),
            "e1_e4": bundle.get("e1_e4", {}),
            "cost": bundle.get("cost", {}),
        },
        "held_out.json": bundle.get("held_out", {}),
        "routed_world.json": bundle.get("routed_world", {"source": None, "rows": []}),
        "envelope.json": _load("envelope.json", []),
        "cu.json": _load("cu.json", {"instructions": {}}),
        "mutation.json": bundle.get("mutation", {}),
        "test_counts.json": bundle.get("test_counts", {}),
        "thesis.json": _load("thesis.json", {}),
        "e8_proxy.json": _load("e8_proxy.json", {}),
    }
    return files


def main() -> None:
    files = build()
    PUBLIC.mkdir(parents=True, exist_ok=True)
    SCHEMA.mkdir(parents=True, exist_ok=True)
    manifest_files = {}
    for name, data in files.items():
        (PUBLIC / name).write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
        (SCHEMA / name).write_text(json.dumps(SCHEMAS[name], indent=2, sort_keys=True) + "\n")
        manifest_files[name] = {"sha256": _sha256(PUBLIC / name), "schema": f"../schema/{name}"}
    bundle = _load("artifacts.json", {})
    meta = bundle.get("meta", {})
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "commit": meta.get("commit"),
        "short": meta.get("short"),
        "generated": date.today().isoformat(),
        "flow_type": meta.get("flow_type"),
        "parameter_hash": meta.get("frozen_params_sha256"),
        "data_sha256": meta.get("data_sha256", {}),
        "files": manifest_files,
    }
    (PUBLIC / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(f"published {len(files)} files + manifest to artifacts/public")


if __name__ == "__main__":
    main()
