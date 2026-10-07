"""Pre-registered evaluation windows (Task 1.2).

The window *rule* and the resulting dates are fixed here, before any
simulation is run, and rendered into ``docs/P1_RESULTS.md`` by the report
generator. Nothing in this module reads a price.

Selection rule (fixed 2026-10-07, the download date):

1. The span is the last six complete Monday-anchored UTC weeks ending on
   2026-10-04, the last complete Sunday before the download date.
2. Week 1 is the **calibration week**: parameter grid search runs there and
   the winners are frozen. It is never a headline row.
3. Weeks 2-6 are the **held-out test period** and *all five* are reported, so
   no test week can be quietly dropped.
4. Regime labels are assigned by a fixed rule on the converted USDC 1-second
   series, not by hand:

   - **crash** - the test week with the smallest 7-day log return;
   - **trend** - among the remaining weeks, the largest absolute 7-day log
     return;
   - **calm** - among the remaining weeks, the smallest realised volatility
     per square-root second;
   - ties resolve to the earliest week.

The labels are therefore *descriptive*: the rule is fixed in advance, the
calendar dates are fixed in advance, and only the arithmetic determines which
week carries which label.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone

# Rule parameters: six complete Monday-Sunday UTC weeks ending 2026-10-04.
SPAN_FIRST = date(2026, 8, 24)
NUMBER_OF_WEEKS = 6
CALIBRATION_LABEL = "W1"
REGIMES: tuple[str, ...] = ("calm", "trend", "crash")


def _ms(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp() * 1_000)


@dataclass(frozen=True)
class Window:
    """One evaluation week, half-open in UTC milliseconds."""

    label: str
    start_date: date
    end_date: date  # inclusive; the window stops at end_date+1 00:00 UTC

    @property
    def start_ms(self) -> int:
        return _ms(self.start_date)

    @property
    def end_ms(self) -> int:
        return _ms(self.end_date) + 86_400_000

    @property
    def seconds(self) -> int:
        return (self.end_ms - self.start_ms) // 1_000

    @property
    def dates(self) -> str:
        return f"{self.start_date.isoformat()} .. {self.end_date.isoformat()}"

    @property
    def is_calibration(self) -> bool:
        return self.label == CALIBRATION_LABEL


def build_windows() -> list[Window]:
    from datetime import timedelta

    windows: list[Window] = []
    start = SPAN_FIRST
    for index in range(NUMBER_OF_WEEKS):
        end = start + timedelta(days=6)
        windows.append(Window(label=f"W{index + 1}", start_date=start, end_date=end))
        start = end + timedelta(days=1)
    return windows


WINDOWS: list[Window] = build_windows()
CALIBRATION_WINDOW: Window = WINDOWS[0]
TEST_WINDOWS: list[Window] = WINDOWS[1:]


@dataclass(frozen=True)
class WindowStats:
    """Post-hoc arithmetic on a window's converted prices (no simulation)."""

    label: str
    log_return: float
    sigma: float
    start_price: float
    end_price: float


def window_stats(label: str, prices: list[float]) -> WindowStats:
    """7-day log return and realised per-sqrt-second volatility."""
    if len(prices) < 2:
        raise ValueError("need at least two prices")
    import math

    total = 0.0
    count = 0
    for previous, current in zip(prices, prices[1:]):
        if previous <= 0 or current <= 0:
            continue
        total += math.log(current / previous) ** 2
        count += 1
    sigma = math.sqrt(total / count) if count else 0.0
    start_price, end_price = prices[0], prices[-1]
    log_return = math.log(end_price / start_price) if start_price > 0 else 0.0
    return WindowStats(label=label, log_return=log_return, sigma=sigma,
                       start_price=start_price, end_price=end_price)


def assign_regimes(test_stats: list[WindowStats]) -> dict[str, str]:
    """Apply the pre-registered regime rule. Returns ``{regime: window label}``."""
    ordered = sorted(test_stats, key=lambda s: s.label)
    if not ordered:
        raise ValueError("no test windows")
    crash = min(ordered, key=lambda s: (s.log_return, s.label))
    rest = [s for s in ordered if s.label != crash.label]
    trend = max(rest, key=lambda s: abs(s.log_return))
    rest = [s for s in rest if s.label != trend.label]
    calm = min(rest, key=lambda s: (s.sigma, s.label))
    return {"crash": crash.label, "trend": trend.label, "calm": calm.label}


def pre_registration_markdown() -> str:
    """The section ``docs/P1_RESULTS.md`` carries *before* any result exists."""
    lines = [
        "## Pre-registration",
        "",
        "Fixed on 2026-10-07 (the download date), before any simulation was run. "
        "The rule reads no price; only the arithmetic below assigns labels.",
        "",
        "1. Span: the last six complete Monday-Sunday UTC weeks ending "
        "2026-10-04 (the last complete Sunday before the download).",
        "2. **W1 is calibration only**: the coefficient grid search runs there and "
        "the winners are frozen. W1 is never a headline row.",
        "3. **W2-W6 are the held-out test period and all five are reported**, so "
        "no test week can be dropped after the fact.",
        "4. Regime labels are assigned mechanically on the USDC-converted 1s series:",
        "",
        "| Label | Rule |",
        "|---|---|",
        "| crash | smallest 7-day log return among W2-W6 |",
        "| trend | among the rest, largest absolute 7-day log return |",
        "| calm | among the rest, smallest realised volatility per sqrt-second |",
        "| ties | earliest week |",
        "",
        "| Window | Dates (UTC) | Seconds | Role |",
        "|---|---|---|---|",
    ]
    for window in WINDOWS:
        role = "calibration (not headline)" if window.is_calibration else "held-out test"
        lines.append(f"| {window.label} | {window.dates} | {window.seconds:,} | {role} |")
    lines.append("")
    lines.append(
        "The labels are descriptive, not chosen: the calendar and the rule were "
        "fixed first, the realised regime follows."
    )
    lines.append("")
    return "\n".join(lines)
