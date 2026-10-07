"""Pre-registered window rule tests (Task 1.2)."""

from __future__ import annotations

from datetime import timedelta

from research.sim.windows import (
    CALIBRATION_WINDOW,
    REGIMES,
    TEST_WINDOWS,
    WINDOWS,
    WindowStats,
    assign_regimes,
    pre_registration_markdown,
)


def test_windows_are_six_contiguous_monday_to_sunday_weeks():
    assert len(WINDOWS) == 6
    for window in WINDOWS:
        assert window.seconds == 604_800
        assert window.start_date.weekday() == 0, "must start on Monday"
        assert window.end_date.weekday() == 6, "must end on Sunday"
    for earlier, later in zip(WINDOWS, WINDOWS[1:]):
        assert later.start_date == earlier.end_date + timedelta(days=1)


def test_first_window_is_calibration_and_the_rest_are_test():
    assert CALIBRATION_WINDOW.label == "W1"
    assert [w.label for w in TEST_WINDOWS] == ["W2", "W3", "W4", "W5", "W6"]
    assert CALIBRATION_WINDOW.is_calibration
    assert not any(w.is_calibration for w in TEST_WINDOWS)


def _stats(label: str, log_return: float, sigma: float) -> WindowStats:
    return WindowStats(label=label, log_return=log_return, sigma=sigma,
                       start_price=100.0, end_price=100.0)


def test_regime_rule_picks_crash_trend_calm_by_the_stated_arithmetic():
    stats = [
        _stats("W2", -0.02, 0.00010),   # small loss, tiny vol
        _stats("W3", -0.20, 0.00030),   # biggest loss -> crash
        _stats("W4", +0.15, 0.00040),   # biggest remaining |return| -> trend
        _stats("W5", +0.01, 0.00005),   # quietest remaining -> calm
        _stats("W6", +0.03, 0.00020),
    ]
    labels = assign_regimes(stats)
    assert labels == {"crash": "W3", "trend": "W4", "calm": "W5"}


def test_regime_rule_is_deterministic_and_disjoint():
    stats = [
        _stats("W2", -0.10, 0.00010),
        _stats("W3", -0.10, 0.00010),
        _stats("W4", +0.10, 0.00010),
        _stats("W5", +0.10, 0.00010),
        _stats("W6", +0.10, 0.00010),
    ]
    first = assign_regimes(stats)
    second = assign_regimes(list(reversed(stats)))
    assert first == second, "ties must resolve to the earliest window"
    assert len(set(first.values())) == 3, "one week per label"


def test_regime_labels_cover_the_documented_set():
    assert set(REGIMES) == {"calm", "trend", "crash"}


def test_pre_registration_lists_every_window_date():
    text = pre_registration_markdown()
    for window in WINDOWS:
        assert window.start_date.isoformat() in text
        assert window.end_date.isoformat() in text
    assert "calibration (not headline)" in text
    test_rows = [line for line in text.splitlines()
                 if line.startswith("| W") and "held-out test" in line]
    assert len(test_rows) == 5
