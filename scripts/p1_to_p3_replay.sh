#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${1:-$ROOT/research/data/raw/binance_SOLUSDT_1s.csv}"
OUTPUT="${2:-$ROOT/research/data/raw/keeper_replay.csv}"

cd "$ROOT"
source .venv/bin/activate
python -m research.data.export_keeper_replay "$SOURCE" "$OUTPUT"
