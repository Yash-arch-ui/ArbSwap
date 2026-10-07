"""Archive parser tests (Task 1.1/1.2). No network: zips are built in memory."""

from __future__ import annotations

import io
import zipfile
from datetime import date

import pytest

from research.data.download_vision import (
    archive_url,
    parse_aggtrades,
    parse_klines_1s,
    _GridWriter,
)


def _zip(rows: list[str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("data.csv", "\n".join(rows) + "\n")
    return buffer.getvalue()


def test_archive_urls_are_the_documented_public_paths():
    day = date(2026, 9, 15)
    assert archive_url("klines", "SOLUSDT", day) == (
        "https://data.binance.vision/data/spot/daily/klines/SOLUSDT/1s/"
        "SOLUSDT-1s-2026-09-15.zip"
    )
    assert archive_url("aggTrades", "SOLUSDT", day) == (
        "https://data.binance.vision/data/spot/daily/aggTrades/SOLUSDT/"
        "SOLUSDT-aggTrades-2026-09-15.zip"
    )
    with pytest.raises(ValueError):
        archive_url("nope", "SOLUSDT", day)


def test_klines_open_time_is_microseconds_and_close_is_the_price():
    # openTime is in microseconds on the vision archives (REST uses ms).
    rows = [
        "1789430400000000,100,101,99,100.5,10,1789430400999999,0,1,0,0,0",
        "1789430401000000,100.5,101,100,101.5,5,1789430401999999,0,1,0,0,0",
    ]
    assert parse_klines_1s(_zip(rows)) == [
        (1_789_430_400_000, 100.5),
        (1_789_430_401_000, 101.5),
    ]


def test_klines_zero_close_is_forward_filled():
    rows = [
        "1000000,1,1,1,5,1,1999999,0,1,0,0,0",
        "2000000,1,1,1,0,1,2999999,0,1,0,0,0",
        "3000000,1,1,1,6,1,3999999,0,1,0,0,0",
    ]
    assert parse_klines_1s(_zip(rows)) == [
        (1_000, 5.0), (2_000, 5.0), (3_000, 6.0),
    ]


def test_aggtrades_bins_take_the_last_trade_per_bin():
    rows = [
        "1,100.0,1,1,1,1789430400000000,False,True",   # bin 0
        "2,101.0,1,2,2,1789430400049999,False,True",   # still bin 0 (49 ms)
        "3,102.0,1,3,3,1789430400150000,False,True",   # bin 100
        "4,103.0,1,4,4,1789430400249999,False,True",   # bin 200
        "5,104.0,1,5,5,1789430400349999,False,True",   # bin 300
    ]
    out = parse_aggtrades(_zip(rows), bin_ms=100)
    assert out == [
        (1_789_430_400_000, 101.0),
        (1_789_430_400_100, 102.0),
        (1_789_430_400_200, 103.0),
        (1_789_430_400_300, 104.0),
    ]


def test_grid_writer_forward_fills_missing_seconds(tmp_path):
    out = tmp_path / "grid.csv"
    grid = _GridWriter(out, step_ms=1_000)
    grid.add([(0, 10.0), (3_000, 13.0)])
    grid.add([(5_000, 15.0)])
    grid.close()
    lines = out.read_text().strip().splitlines()
    assert lines[0] == "timestamp_ms,price"
    assert lines[1:] == [
        "0,10.0000000000",
        "1000,10.0000000000",
        "2000,10.0000000000",
        "3000,13.0000000000",
        "4000,13.0000000000",
        "5000,15.0000000000",
    ]


def test_grid_writer_ignores_non_positive_prices(tmp_path):
    out = tmp_path / "grid2.csv"
    grid = _GridWriter(out, step_ms=1_000)
    grid.add([(0, 10.0), (1_000, 0.0), (2_000, 11.0)])
    assert grid.close() == 3
    assert out.read_text().strip().splitlines()[1:] == [
        "0,10.0000000000",
        "1000,10.0000000000",
        "2000,11.0000000000",
    ]
