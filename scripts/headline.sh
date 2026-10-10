#!/usr/bin/env bash
# T6.1 - one-command headline chart reproduction (Build Plan §12 P6).
# Writes docs/headline_chart.svg (+ simulation/data/results/headline.json).
# Uses the gitignored raw W1-W6 archives when present; otherwise a deterministic
# synthetic price path, so the command always works with no data.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PY="${PYTHON:-python3}"
if [ -x .venv/bin/python ]; then PY=.venv/bin/python; fi
"$PY" -m simulation.sim.headline
echo "open docs/headline_chart.svg in a browser"
