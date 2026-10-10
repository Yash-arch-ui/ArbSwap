"""Helpers to materialise the cached Binance 1s archives as CSV paths (F5).

The public archives live under ``simulation/data/raw/archive/`` as daily zips.
``load_price_window`` reads CSVs, so this module extracts the cached zip (or
downloads it on demand) and writes
``simulation/data/raw/binance_<SYMBOL>_1s_<day>.csv``.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

from simulation.data.download_vision import (
    archive_url,
    fetch_archive,
    parse_klines_1s,
    write_csv,
)

RAW = Path(__file__).resolve().parents[1] / "data" / "raw"
ARCHIVE = RAW / "archive"


def _ensure(symbol: str, day: str) -> Path:
    out = RAW / f"binance_{symbol}_1s_{day}.csv"
    if out.exists():
        return out
    cached = ARCHIVE / f"{symbol}-1s-{day}.zip"
    if cached.exists():
        payload = cached.read_bytes()
    else:
        payload = fetch_archive(
            archive_url("klines", symbol, date.fromisoformat(day)), cache_dir=ARCHIVE
        )
    write_csv(parse_klines_1s(payload), out)
    return out


def ensure_sol_csv(day: str) -> Path:
    return _ensure("SOLUSDT", day)


def ensure_usdc_csv(day: str) -> Path:
    return _ensure("USDCUSDT", day)
