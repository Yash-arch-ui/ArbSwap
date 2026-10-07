#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${1:-$ROOT/research/data/raw/binance_SOLUSDT_1s.csv}"

cd "$ROOT"
# Rust consumes the P1 Binance-style timestamp/price CSV directly. Python
# remains the independent reference, calibration, and reporting layer.
cargo run -q -p arbswap-keeper -- replay "$SOURCE"
