#!/usr/bin/env bash
# One-command P1 reproduction: calibrate -> evaluate -> studies -> render, then
# the synthetic/exploratory report. Raw data must be present (see
# docs/DATA_MANIFEST.md); raw data is gitignored.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
python -m simulation.sim.p1_calibrate          # B1 baseline calibration (W1)
python -m simulation.sim.study all --workers "${WORKERS:-5}"  # W1->W2-W6->S1-S5->render
python -m simulation.sim.report                # docs/P1_SYNTHETIC.md
echo "P1 reproduction complete: docs/P1_RESULTS.md, docs/P1_SYNTHETIC.md"
