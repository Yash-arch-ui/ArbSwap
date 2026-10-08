"""Window loader tests (Task 1.2)."""

from __future__ import annotations

import pytest

from simulation.sim.price_source import load_price_window


def _csv(tmp_path, name: str, rows: list[tuple[int, float]]):
    path = tmp_path / name
    body = "\n".join(["timestamp_ms,price"] +
                     [f"{stamp},{price:.6f}" for stamp, price in rows])
    path.write_text(body + "\n")
    return path


def test_window_is_contiguous_and_reindexed_from_zero(tmp_path):
    path = _csv(tmp_path, "a.csv", [(1_000, 10.0), (2_000, 11.0), (3_000, 12.0)])
    out = load_price_window(path, start_ms=1_000, end_ms=4_000)
    assert [p.second for p in out] == [0, 1, 2]
    assert [p.price for p in out] == [10.0, 11.0, 12.0]


def test_window_forward_fills_gaps_inside_the_range(tmp_path):
    path = _csv(tmp_path, "b.csv", [(1_000, 10.0), (4_000, 13.0)])
    out = load_price_window(path, start_ms=1_000, end_ms=5_000)
    assert [p.price for p in out] == [10.0, 10.0, 10.0, 13.0]
    assert [p.second for p in out] == [0, 1, 2, 3]


def test_window_uses_rows_before_the_start_only_for_forward_fill(tmp_path):
    path = _csv(tmp_path, "c.csv", [(0, 7.0), (2_000, 8.0)])
    out = load_price_window(path, start_ms=1_000, end_ms=3_000)
    # The row at 0 seeds the fill; nothing is emitted before start_ms.
    assert [p.second for p in out] == [0, 1]
    assert [p.price for p in out] == [7.0, 8.0]


def test_window_stops_at_end_ms_exclusive(tmp_path):
    path = _csv(tmp_path, "d.csv", [(1_000, 1.0), (2_000, 2.0), (3_000, 3.0)])
    out = load_price_window(path, start_ms=1_000, end_ms=3_000)
    assert [p.price for p in out] == [1.0, 2.0]


def test_window_trailing_fill_reaches_the_end(tmp_path):
    path = _csv(tmp_path, "e.csv", [(1_000, 5.0)])
    out = load_price_window(path, start_ms=1_000, end_ms=4_000)
    assert [p.price for p in out] == [5.0, 5.0, 5.0]


def test_window_rejects_bad_bounds(tmp_path):
    path = _csv(tmp_path, "f.csv", [(1_000, 1.0)])
    with pytest.raises(ValueError):
        load_price_window(path, start_ms=1_500, end_ms=4_000)
    with pytest.raises(ValueError):
        load_price_window(path, start_ms=4_000, end_ms=1_000)
