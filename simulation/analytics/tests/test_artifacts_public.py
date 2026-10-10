"""B9 - every published artifact validates against its schema and the manifest
hashes match."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import jsonschema

ROOT = Path(__file__).resolve().parents[3]
PUBLIC = ROOT / "artifacts" / "public"
SCHEMA = ROOT / "artifacts" / "schema"


def _manifest() -> dict:
    return json.loads((PUBLIC / "manifest.json").read_text())


def test_manifest_has_required_fields():
    m = _manifest()
    for key in ("schema_version", "commit", "generated", "flow_type", "files"):
        assert key in m, f"manifest missing {key}"


def test_every_public_file_validates_against_its_schema():
    m = _manifest()
    assert m["files"], "manifest lists no files"
    for name in m["files"]:
        schema = json.loads((SCHEMA / name).read_text())
        data = json.loads((PUBLIC / name).read_text())
        jsonschema.validate(data, schema)


def test_manifest_hashes_match_the_files():
    m = _manifest()
    for name, info in m["files"].items():
        digest = hashlib.sha256((PUBLIC / name).read_bytes()).hexdigest()
        assert digest == info["sha256"], f"{name} hash mismatch"
