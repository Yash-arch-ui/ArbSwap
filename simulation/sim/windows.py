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


# --- Execution protocol (amendment; see pre_registration_amendment_markdown) ---

HOURS_PER_WINDOW = 168
CALIBRATION_BLOCK_COUNT = 12
CALIBRATION_BLOCK_SECONDS = 3_600
# One-hour slice used by the slot and latency studies: 12:00-13:00 UTC on day
# index 3 of each window (day 4 of the week).
SLICE_HOUR_OF_WINDOW = 3 * 24 + 12
CALIBRATION_SEED = 20261006
HEADLINE_STEP_SECONDS = 0.4
SOURCE_STEP_SECONDS = 1.0
SLOT_SECONDS = 0.4
KEEPER_INTERVAL_SECONDS = 1.0
SENSITIVITY_STEP_SECONDS: tuple[float, ...] = (1.0, 0.1)
SLOT_STUDY_SECONDS: tuple[float, ...] = (0.4, 0.6, 1.0)
LATENCY_STUDY_SECONDS: tuple[float, ...] = (0.05, 0.2, 0.4, 1.0)
SENSITIVITY_SEEDS: tuple[int, ...] = (20261006, 20261007, 20261008, 20261009, 20261010)


def calibration_block_hours(count: int = CALIBRATION_BLOCK_COUNT) -> tuple[int, ...]:
    """Hour-of-week index of each calibration block.

    ``floor(k * 168 / count)`` spreads the blocks evenly over the whole week, so
    night and day, weekday and weekend, are all represented without reading a
    single price.
    """
    if count < 1 or count > HOURS_PER_WINDOW:
        raise ValueError("block count must be in [1, 168]")
    return tuple((k * HOURS_PER_WINDOW) // count for k in range(count))


def window_hour_slice(window: Window) -> tuple[int, int]:
    """Half-open hour range of the pre-registered study slice inside ``window``."""
    start = SLICE_HOUR_OF_WINDOW
    return start, start + 1


def pre_registration_amendment_markdown() -> str:
    """The execution protocol, fixed before any W1-W6 simulation is run.

    The window rule above was already registered; this amendment fixes the
    *how*: clock, calibration subsample, grid, objective, metrics and studies.
    It is rendered into ``docs/P1_RESULTS.md`` ahead of every result table.
    """
    block_hours = calibration_block_hours()
    lines = [
        "## Pre-registration amendment (execution protocol)",
        "",
        "Committed before any W1-W6 simulation was run. The window rule above is "
        "unchanged; this fixes the execution choices the original registration "
        "left open. Everything not listed here follows the defaults in "
        "`simulation/sim/engine.py` and `docs/ASSUMPTIONS.md` A-15.",
        "",
        "### 1. Clock",
        "",
        "| Parameter | Value |",
        "|---|---|",
        f"| headline simulation step | {HEADLINE_STEP_SECONDS} s (one slot) |",
        f"| reference (source) sample | {SOURCE_STEP_SECONDS} s causal staircase |",
        f"| slot length | {SLOT_SECONDS} s |",
        f"| keeper update interval | {KEEPER_INTERVAL_SECONDS} s |",
        f"| clock sensitivity runs | {', '.join(f'{s} s' for s in SENSITIVITY_STEP_SECONDS)} "
        "(reported, never headline) |",
        "",
        "A coarser clock gives the arbitrageur fewer reaction opportunities, so a "
        "1 s clock **understates** adverse selection (direction of the bias, "
        "documented in ASSUMPTIONS A-15).",
        "",
        "### 2. Calibration (W1 only)",
        "",
        f"- **Blocks:** {CALIBRATION_BLOCK_COUNT} one-hour blocks of W1 at hour "
        f"{', '.join(str(h) for h in block_hours)} of the week "
        "(`floor(k*168/12)`, evenly spaced, chosen without reading a price).",
        "- **Grid:** 81 candidates = 3 `spread_floor` x 3 `inventory_coeff` x "
        "3 `volatility_coeff` x 3 `sigma_target`.",
        "- **Score:** mean over the 12 blocks of "
        "`hedged PnL - 1.0 x quiet-flow half-spread (bps)`, at the headline "
        "clock, with measured CU costs debited from the vault.",
        f"- **Seed:** {CALIBRATION_SEED} for every candidate, so candidates are "
        "compared on identical flow draws.",
        "- **Tie-break:** higher score, then smaller `inventory_coeff`, then "
        "smaller `volatility_coeff`, then smaller `spread_floor`.",
        "- The winner is frozen and used unchanged for W2-W6. W1 is never a "
        "headline row.",
        "",
        "### 3. Held-out evaluation (W2-W6)",
        "",
        f"All five windows, all five venues, headline clock, seed "
        f"{CALIBRATION_SEED}. Per window: hedged PnL, E1 vs B1, 2 s markout, "
        "quiet half-spread, quote-versus-fill gap, trades, rejections / fill "
        "rate, quote turnover, keeper update gas + priority per update and per "
        "hour, and theory LVR of the passive pool's liquidity.",
        "",
        "Across windows the summary reports the equal-weighted mean, median, "
        "best, worst and the **count of windows where ArbSwap >= B1** — never a "
        "single pooled number, so the answer cannot depend on a hidden regime mix.",
        "",
        "### 4. Studies",
        "",
        "| ID | Study | Design |",
        "|---|---|---|",
        f"| S1 | clock sensitivity | W2-W6 at "
        f"{', '.join(f'{s} s' for s in SENSITIVITY_STEP_SECONDS)}, ArbSwap and B1 |",
        f"| S2 | slot length | `slot_seconds` in "
        f"{', '.join(f'{s} s' for s in SLOT_STUDY_SECONDS)} on the study slice of "
        "each labelled window |",
        f"| S3 | oracle latency | {', '.join(f'{s} s' for s in LATENCY_STUDY_SECONDS)} "
        "on a 100 ms aggTrades reference, same slices |",
        f"| S4 | seed sensitivity | seeds {', '.join(str(s) for s in SENSITIVITY_SEEDS)} "
        "on W2, ArbSwap and B1 |",
        "| S5 | regime mix | per-window E1 plus mean / median / best / worst / win count |",
        "",
        "The study slice is **12:00-13:00 UTC on day 4 of each window** (hour "
        f"{SLICE_HOUR_OF_WINDOW} of the week), fixed here without reading a price.",
        "",
        "### 5. What is *not* claimed",
        "",
        "- Flow (noise and informed) is synthetic; only the price path is real. "
        "Markout, spread and PnL are therefore model outputs, not measurements of "
        "live order flow.",
        "- The priority-fee rate and the landing-delay distribution are heuristics "
        "(ASSUMPTIONS A-15), so absolute PnL carries that uncertainty; "
        "venue-vs-venue comparisons share it.",
        "- A window in which ArbSwap loses is reported as a loss.",
        "",
    ]
    return "\n".join(lines)
