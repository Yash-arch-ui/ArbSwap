"""Held-out evaluation for Task 1 (pre-registered protocol).

Runs exactly what ``pre_registration_amendment_markdown`` registers, in four
phases so a crash never costs a finished one::

    python -m research.sim.study calibrate   # W1 blocks -> frozen params
    python -m research.sim.study evaluate    # W2-W6 at the headline clock
    python -m research.sim.study studies     # S1-S5
    python -m research.sim.study render      # docs/P1_RESULTS.md
    python -m research.sim.study all

Artifacts (all committed as evidence):

    research/data/results/frozen_params.json
    research/data/results/window_results.json
    research/data/results/study_results.json
    docs/P1_RESULTS.md

Every phase is deterministic given the artifacts before it: one seed, one
grid, one clock, one cost model.
"""

from __future__ import annotations

import argparse
import json
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from research.reference.quote_math import QuoteParams
from research.sim.calibrate import CalibrationResult, calibrate_blocks
from research.sim.costs import CU_SWAP, CU_UPDATE_QUOTE
from research.sim.engine import simulate
from research.sim.experiments import RunConfig, VenueReport, run_venues
from research.sim.flow import InformedFlow, NoiseFlow
from research.sim.metrics import hedged_pnl, lvr_discrete
from research.sim.oracle import OracleModel
from research.sim.price_source import PricePoint, load_price_window
from research.sim.usdt_usdc import convert_legs
from research.sim.venues import PassivePool, VaultVenue
from research.sim.windows import (
    CALIBRATION_SEED,
    HEADLINE_STEP_SECONDS,
    LATENCY_STUDY_SECONDS,
    SENSITIVITY_SEEDS,
    SENSITIVITY_STEP_SECONDS,
    SLOT_STUDY_SECONDS,
    WINDOWS,
    Window,
    WindowStats,
    assign_regimes,
    calibration_block_hours,
    pre_registration_amendment_markdown,
    pre_registration_markdown,
    window_hour_slice,
    window_stats,
)

RAW = Path("research/data/raw")
SOL_USDT_CSV = RAW / "binance_SOLUSDT_1s_6w.csv"
USDC_USDT_CSV = RAW / "binance_USDCUSDT_1s_6w.csv"
RESULTS = Path("research/data/results")
FROZEN_PARAMS_JSON = RESULTS / "frozen_params.json"
WINDOW_RESULTS_JSON = RESULTS / "window_results.json"
STUDY_RESULTS_JSON = RESULTS / "study_results.json"
REPORT_PATH = Path("docs/P1_RESULTS.md")

# B1's fee: the run_venues default, fixed long before the pre-registration.
PASSIVE_FEE = 0.0001
VAULT_FEE_BPS = 1.0
# The regime rule is applied to the whole test set; these are its outputs.
EXPECTED_REGIMES = {"crash": "W3", "trend": "W4", "calm": "W6"}
# S3 uses a 100 ms aggTrades reference (SOL/USDT), one hour per labelled window.
AGGTRADES_DATES = {"W3": "2026-09-10", "W4": "2026-09-17", "W6": "2026-10-01"}
SLICE_START_HOUR_UTC = 12

WINDOWS_BY_LABEL = {window.label: window for window in WINDOWS}


def aggtrades_csv(day: str) -> Path:
    return RAW / f"binance_SOLUSDT_aggtrades_100ms_{day}.csv"


def _load_window(window: Window) -> list[PricePoint]:
    """USDC-converted 1-second reference for one registered window."""
    sol = load_price_window(SOL_USDT_CSV, start_ms=window.start_ms,
                            end_ms=window.end_ms)
    usdc = load_price_window(USDC_USDT_CSV, start_ms=window.start_ms,
                             end_ms=window.end_ms)
    return convert_legs(sol, usdc)


def _load_slice(window: Window) -> list[PricePoint]:
    """The pre-registered one-hour study slice of a window."""
    start_hour, end_hour = window_hour_slice(window)
    start = window.start_ms + start_hour * 3_600_000
    end = window.start_ms + end_hour * 3_600_000
    sol = load_price_window(SOL_USDT_CSV, start_ms=start, end_ms=end)
    usdc = load_price_window(USDC_USDT_CSV, start_ms=start, end_ms=end)
    return convert_legs(sol, usdc)


def _load_agg_slice(day: str) -> list[PricePoint]:
    """100 ms aggTrades reference for 12:00-13:00 UTC on ``day``."""
    stamp = datetime(int(day[0:4]), int(day[5:7]), int(day[8:10]),
                     SLICE_START_HOUR_UTC, tzinfo=timezone.utc)
    start = int(stamp.timestamp() * 1000)
    return load_price_window(aggtrades_csv(day), start_ms=start,
                             end_ms=start + 3_600_000, step_ms=100)


def extract_blocks(points: list[PricePoint],
                   hours: tuple[int, ...] = calibration_block_hours(),
                   block_seconds: int = 3_600) -> list[list[PricePoint]]:
    """Slice a window into the registered calibration blocks."""
    blocks = []
    for hour in hours:
        start = hour * 3_600
        end = start + block_seconds
        if end > len(points):
            raise ValueError(f"window is too short for block at hour {hour}")
        blocks.append(points[start:end])
    return blocks


def _report_dict(report: VenueReport) -> dict:
    payload = asdict(report)
    payload["fill_rate"] = report.fill_rate
    payload["cost_per_update_quote"] = report.cost_per_update_quote
    return payload


def _pnl_only(points: list[PricePoint], venue, config: RunConfig) -> dict:
    """Hedged PnL and throughput without the (large) metric look-up tables."""
    result = simulate(
        venue_name="study",
        venue=venue,
        prices=points,
        oracle=OracleModel(),
        noise=NoiseFlow(seed=config.seed),
        informed=InformedFlow(),
        **config.simulate_kwargs(),
    )
    return {
        "hedged_pnl": hedged_pnl(result.value_path, result.base_path, result.price_path),
        "turnover_quote": sum(trade.quote_amount for trade in result.trades),
        "trades": len(result.trades),
        "rejects": result.rejects,
        "updates": result.quote_updates,
        "update_cost_quote": result.update_cost_quote,
        "step_seconds": result.step_seconds,
    }


def _pair(points: list[PricePoint], params: QuoteParams, config: RunConfig) -> dict:
    """ArbSwap and B1 side by side on the same path (the recurring comparison)."""
    return {
        "ArbSwap": _pnl_only(points, VaultVenue(params=params, fee_bps=VAULT_FEE_BPS),
                             config),
        "B1_passive": _pnl_only(points, PassivePool(fee=PASSIVE_FEE), config),
    }


def _e1(reports: dict[str, dict]) -> float:
    passive = reports["B1_passive"]["hedged_pnl"]
    arbs = reports["ArbSwap"]["hedged_pnl"]
    return (arbs - passive) / abs(passive) if passive else 0.0


# --------------------------------------------------------------------------
# Phase 1: calibrate on W1
# --------------------------------------------------------------------------

def phase_calibrate(workers: int) -> dict:
    hours = calibration_block_hours()
    print(f"[calibrate] loading W1 and slicing {len(hours)} blocks", flush=True)
    window = WINDOWS_BY_LABEL["W1"]
    points = _load_window(window)
    blocks = extract_blocks(points, hours)
    del points
    print(f"[calibrate] {len(blocks)} blocks x 3,600 s, grid of 81 candidates",
          flush=True)
    started = time.time()
    result: CalibrationResult = calibrate_blocks(blocks, block_hours=hours)
    payload = {
        "protocol": "pre-registration amendment, section 2",
        "seed": CALIBRATION_SEED,
        "step_seconds": HEADLINE_STEP_SECONDS,
        "block_hours": list(hours),
        "block_seconds": 3_600,
        "candidates": len(result.per_candidate_scores),
        "score": result.score,
        "runner_up_score": result.runner_up_score,
        "per_block_scores": list(result.per_block_scores),
        "per_candidate_scores": list(result.per_candidate_scores),
        "params": asdict(result.params),
        "elapsed_seconds": round(time.time() - started, 1),
    }
    _write(FROZEN_PARAMS_JSON, payload)
    print(f"[calibrate] score={result.score:.4f} "
          f"(runner-up {result.runner_up_score:.4f}) in "
          f"{payload['elapsed_seconds']} s", flush=True)
    print(f"[calibrate] frozen params: {result.params}", flush=True)
    return payload


def load_frozen_params() -> QuoteParams:
    if not FROZEN_PARAMS_JSON.exists():
        raise SystemExit(f"missing {FROZEN_PARAMS_JSON}; run the calibrate phase first")
    return parse_params(json.loads(FROZEN_PARAMS_JSON.read_text())["params"])


def parse_params(payload: dict) -> QuoteParams:
    """Rebuild ``QuoteParams`` from JSON (JSON has no tuple type)."""
    data = dict(payload)
    for key in ("offsets_bps", "weights_bps"):
        if data.get(key) is not None:
            data[key] = tuple(data[key])
    return QuoteParams(**data)


# --------------------------------------------------------------------------
# Phase 2: W2-W6 at the headline clock
# --------------------------------------------------------------------------

def _evaluate_window(job: tuple[str, str]) -> dict:
    label, params_json = job
    params = parse_params(json.loads(params_json))
    window = WINDOWS_BY_LABEL[label]
    points = _load_window(window)
    started = time.time()
    reports = run_venues(points, params=params, passive_fee=PASSIVE_FEE,
                         vault_fee_bps=VAULT_FEE_BPS)
    prices = [point.price for point in points]
    stats = window_stats(label, prices)
    pool = PassivePool(fee=PASSIVE_FEE)
    initial_value = pool.quote + pool.base * prices[0]
    return {
        "label": label,
        "dates": window.dates,
        "seconds": window.seconds,
        "start_price": stats.start_price,
        "end_price": stats.end_price,
        "log_return": stats.log_return,
        "sigma": stats.sigma,
        "theory_lvr_quote": lvr_discrete(stats.sigma, initial_value, window.seconds),
        "passive_initial_value_quote": initial_value,
        "reports": {name: _report_dict(report) for name, report in reports.items()},
        "elapsed_seconds": round(time.time() - started, 1),
    }


def phase_evaluate(workers: int) -> dict:
    params = load_frozen_params()
    params_json = json.dumps(asdict(params))
    labels = [window.label for window in WINDOWS if not window.is_calibration]
    print(f"[evaluate] {len(labels)} held-out windows, {workers} workers", flush=True)
    started = time.time()
    with ProcessPoolExecutor(max_workers=workers) as pool:
        rows = list(pool.map(_evaluate_window, [(label, params_json) for label in labels]))
    rows.sort(key=lambda row: row["label"])

    stats = [WindowStats(label=row["label"], log_return=row["log_return"],
                         sigma=row["sigma"], start_price=row["start_price"],
                         end_price=row["end_price"]) for row in rows]
    regimes = assign_regimes(stats)
    payload = {
        "frozen_params": asdict(params),
        "passive_fee": PASSIVE_FEE,
        "vault_fee_bps": VAULT_FEE_BPS,
        "step_seconds": HEADLINE_STEP_SECONDS,
        "seed": CALIBRATION_SEED,
        "regimes": regimes,
        "expected_regimes": EXPECTED_REGIMES,
        "regimes_match_pre_registration": regimes == EXPECTED_REGIMES,
        "windows": {row["label"]: row for row in rows},
        "elapsed_seconds": round(time.time() - started, 1),
    }
    _write(WINDOW_RESULTS_JSON, payload)
    print(f"[evaluate] regimes {regimes} "
          f"(pre-registered {EXPECTED_REGIMES}, match="
          f"{payload['regimes_match_pre_registration']})", flush=True)
    for row in rows:
        e1 = _e1(row["reports"])
        print(f"  {row['label']}: E1 {e1:+.1%}  ArbSwap "
              f"{row['reports']['ArbSwap']['hedged_pnl']:,.1f} vs B1 "
              f"{row['reports']['B1_passive']['hedged_pnl']:,.1f} "
              f"({row['elapsed_seconds']} s)", flush=True)
    print(f"[evaluate] {payload['elapsed_seconds']} s wall", flush=True)
    return payload


# --------------------------------------------------------------------------
# Phase 3: studies S1-S5
# --------------------------------------------------------------------------

def _s1_job(job: tuple[str, float, str]) -> dict:
    label, step, params_json = job
    params = parse_params(json.loads(params_json))
    window = WINDOWS_BY_LABEL[label]
    points = _load_window(window)
    config = RunConfig(step_seconds=step)
    return {"window": label, "step_seconds": step, "venues": _pair(points, params, config)}


def _s2_job(job: tuple[str, float, str]) -> dict:
    label, slot, params_json = job
    params = parse_params(json.loads(params_json))
    window = WINDOWS_BY_LABEL[label]
    points = _load_slice(window)
    # 0.2 s steps so every studied slot (0.4/0.6/1.0) lands on the grid.
    config = RunConfig(step_seconds=0.2, slot_seconds=slot)
    reports = run_venues(points, params=params, passive_fee=PASSIVE_FEE,
                         vault_fee_bps=VAULT_FEE_BPS, config=config)
    return {"window": label, "slot_seconds": slot, "step_seconds": 0.2,
            "reports": {name: _report_dict(report) for name, report in reports.items()}}


def _s3_job(job: tuple[str, float, str]) -> dict:
    label, latency, params_json = job
    params = parse_params(json.loads(params_json))
    points = _load_agg_slice(AGGTRADES_DATES[label])
    config = RunConfig(step_seconds=0.05, source_step_seconds=0.1)
    return {
        "window": label,
        "day": AGGTRADES_DATES[label],
        "latency_seconds": latency,
        "reference": "Binance SOLUSDT aggTrades, 100 ms last-trade bin",
        "venues": _pair_at(points, params, config, latency),
    }


def _pair_at(points: list[PricePoint], params: QuoteParams, config: RunConfig,
             latency: float) -> dict:
    """Like :func:`_pair` but with an explicit oracle latency."""
    out = {}
    for name, venue in (("ArbSwap", VaultVenue(params=params, fee_bps=VAULT_FEE_BPS)),
                        ("B1_passive", PassivePool(fee=PASSIVE_FEE))):
        result = simulate(
            venue_name=name,
            venue=venue,
            prices=points,
            oracle=OracleModel(latency_seconds=latency),
            noise=NoiseFlow(seed=config.seed),
            informed=InformedFlow(),
            **config.simulate_kwargs(),
        )
        out[name] = {
            "hedged_pnl": hedged_pnl(result.value_path, result.base_path,
                                     result.price_path),
            "turnover_quote": sum(t.quote_amount for t in result.trades),
            "trades": len(result.trades),
            "rejects": result.rejects,
            "updates": result.quote_updates,
        }
    return out


def _s4_job(job: tuple[int, str]) -> dict:
    seed, params_json = job
    params = parse_params(json.loads(params_json))
    window = WINDOWS_BY_LABEL["W2"]
    points = _load_window(window)
    config = RunConfig(seed=seed)
    return {"seed": seed, "window": "W2", "venues": _pair(points, params, config)}


def phase_studies(workers: int) -> dict:
    params = load_frozen_params()
    params_json = json.dumps(asdict(params))
    payload: dict = {
        "note": "S1-S5 as registered in the pre-registration amendment, section 4.",
        "frozen_params": asdict(params),
    }
    started = time.time()
    test_labels = [window.label for window in WINDOWS if not window.is_calibration]
    labelled = [label for label in test_labels if label in EXPECTED_REGIMES.values()]

    print("[S1] clock sensitivity on W2-W6 (ArbSwap + B1)", flush=True)
    s1_jobs = [(label, step, params_json)
               for step in SENSITIVITY_STEP_SECONDS
               for label in test_labels]
    with ProcessPoolExecutor(max_workers=min(workers, 3)) as pool:
        s1_rows = list(pool.map(_s1_job, s1_jobs))
    payload["S1"] = {f"{row['window']}@{row['step_seconds']}": row for row in s1_rows}
    print(f"  {len(s1_rows)} runs in {round(time.time() - started, 1)} s", flush=True)

    print("[S2] slot length on the study slice of each labelled window", flush=True)
    mark = time.time()
    s2_jobs = [(label, slot, params_json)
               for slot in SLOT_STUDY_SECONDS
               for label in labelled]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        s2_rows = list(pool.map(_s2_job, s2_jobs))
    payload["S2"] = {f"{row['window']}@{row['slot_seconds']}": row for row in s2_rows}
    print(f"  {len(s2_rows)} runs in {round(time.time() - mark, 1)} s", flush=True)

    print("[S3] oracle latency on the 100 ms aggTrades reference", flush=True)
    missing = [day for day in AGGTRADES_DATES.values() if not aggtrades_csv(day).exists()]
    if missing:
        raise SystemExit(
            "missing aggTrades slices: "
            + ", ".join(missing)
            + "\n  python -m research.data.download_vision --kind aggtrades "
              "--symbol SOLUSDT --dates " + " ".join(AGGTRADES_DATES.values())
              + " --bin-ms 100 --out research/data/raw/binance_SOLUSDT_aggtrades_100ms_DAY.csv"
              + "  (one file per date)"
        )
    mark = time.time()
    s3_jobs = [(label, latency, params_json)
               for latency in LATENCY_STUDY_SECONDS
               for label in sorted(AGGTRADES_DATES)]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        s3_rows = list(pool.map(_s3_job, s3_jobs))
    payload["S3"] = {f"{row['window']}@{row['latency_seconds']}": row for row in s3_rows}
    print(f"  {len(s3_rows)} runs in {round(time.time() - mark, 1)} s", flush=True)

    print("[S4] seed sensitivity on W2 (ArbSwap + B1)", flush=True)
    mark = time.time()
    s4_jobs = [(seed, params_json) for seed in SENSITIVITY_SEEDS]
    with ProcessPoolExecutor(max_workers=min(workers, len(s4_jobs))) as pool:
        s4_rows = list(pool.map(_s4_job, s4_jobs))
    payload["S4"] = {str(row["seed"]): row for row in s4_rows}
    print(f"  {len(s4_rows)} runs in {round(time.time() - mark, 1)} s", flush=True)

    payload["S5"] = "rendered from window_results.json (per-window E1 summary)"
    payload["elapsed_seconds"] = round(time.time() - started, 1)
    _write(STUDY_RESULTS_JSON, payload)
    print(f"[studies] {payload['elapsed_seconds']} s wall", flush=True)
    return payload


# --------------------------------------------------------------------------
# Phase 4: render docs/P1_RESULTS.md
# --------------------------------------------------------------------------

def _fmt(value: float, digits: int = 1) -> str:
    return f"{value:,.{digits}f}"


def _window_section(label: str, row: dict, regime_by_window: dict[str, str]) -> list[str]:
    regime = regime_by_window.get(label, "")
    title = f"{label} ({regime}, {row['dates']})" if regime else f"{label} ({row['dates']})"
    lines = [f"## {title}", ""]
    lines.append(f"7-day log return {row['log_return']:+.2%}; realised sigma "
                 f"{row['sigma']:.3e} per sqrt-second; theory LVR of B1's liquidity "
                 f"{_fmt(row['theory_lvr_quote'])} quote.")
    lines.append("")
    lines.append("| Venue | Hedged PnL | Markout 2s (bps) | Quiet half-spread (bps) "
                 "| Quote-fill gap (bps) | Trades | Rejected | Fill rate |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for name in ("B1_passive", "B2_fixed_spread", "B3_no_throttle",
                 "B4_no_honesty", "ArbSwap"):
        report = row["reports"][name]
        lines.append(
            f"| {name} | {_fmt(report['hedged_pnl'])} | {report['markout_2s_bps']:+.3f} | "
            f"{report['quiet_half_spread_bps']:.3f} | {report['gap_bps']:+.4f} | "
            f"{report['trades']:,} | {report['rejects']:,} | "
            f"{report['fill_rate']:.1%} |"
        )
    lines.append("")
    lines.append("| Venue | Turnover (quote) | Keeper updates | Update gas | "
                 "Update priority | Cost per update | Swap cost (recorded) |")
    lines.append("|---|---|---|---|---|---|---|")
    for name in ("B1_passive", "B2_fixed_spread", "B3_no_throttle",
                 "B4_no_honesty", "ArbSwap"):
        report = row["reports"][name]
        lines.append(
            f"| {name} | {_fmt(report['turnover_quote'], 0)} | "
            f"{report['update_count']:,} | {_fmt(report['update_gas_quote'], 2)} | "
            f"{_fmt(report['update_priority_quote'], 2)} | "
            f"{report['cost_per_update_quote']:.4f} | "
            f"{_fmt(report['swap_cost_quote'], 2)} |"
        )
    lines.append("")
    reports = row["reports"]
    lines.append(f"- **E1 (hedged PnL, ArbSwap vs B1):** {_e1(reports):+.2%}")
    lines.append(f"- **E2 (2s markout):** ArbSwap "
                 f"{reports['ArbSwap']['markout_2s_bps']:+.3f} bps vs B1 "
                 f"{reports['B1_passive']['markout_2s_bps']:+.3f} bps")
    lines.append(f"- **E3 (hedged PnL):** ArbSwap {_fmt(reports['ArbSwap']['hedged_pnl'])} "
                 f"vs B2 {_fmt(reports['B2_fixed_spread']['hedged_pnl'])}")
    lines.append(f"- **E4 (quiet half-spread):** ArbSwap "
                 f"{reports['ArbSwap']['quiet_half_spread_bps']:.3f} bps vs B1 "
                 f"{reports['B1_passive']['quiet_half_spread_bps']:.3f} bps")
    lines.append(f"- **E5 (throttle ablation, ArbSwap - B3):** "
                 f"{reports['ArbSwap']['hedged_pnl'] - reports['B3_no_throttle']['hedged_pnl']:+,.2f}")
    lines.append(f"- **E6 (honesty):** ArbSwap fills {reports['ArbSwap']['trades']:,} "
                 f"(rejected {reports['ArbSwap']['rejects']:,}, gap "
                 f"{reports['ArbSwap']['gap_bps']:+.4f} bps); B4 fills "
                 f"{reports['B4_no_honesty']['trades']:,} with gap "
                 f"{reports['B4_no_honesty']['gap_bps']:+.4f} bps")
    lines.append("")
    return lines


def _s5_summary(windows: dict[str, dict], regime_by_window: dict[str, str]) -> list[str]:
    rows = [(label, _e1(row["reports"])) for label, row in sorted(windows.items())]
    values = [value for _, value in rows]
    ordered = sorted(values)
    median = ordered[len(ordered) // 2] if len(ordered) % 2 else \
        (ordered[len(ordered) // 2 - 1] + ordered[len(ordered) // 2]) / 2
    wins = sum(1 for value in values if value >= 0)
    beats_b2 = sum(1 for label, _ in rows
                   if windows[label]["reports"]["ArbSwap"]["hedged_pnl"]
                   >= windows[label]["reports"]["B2_fixed_spread"]["hedged_pnl"])
    lines = ["## S5: regime mix", "",
             "E1 is reported per window and then summarised without pooling, so the "
             "answer cannot be hidden inside a regime mix.", "",
             "| Window | Regime | E1 (ArbSwap vs B1) | ArbSwap | B1 | B2 |",
             "|---|---|---|---|---|---|"]
    for label, value in rows:
        reports = windows[label]["reports"]
        lines.append(f"| {label} | {regime_by_window.get(label, 'unlabelled')} | "
                     f"{value:+.2%} | {_fmt(reports['ArbSwap']['hedged_pnl'])} | "
                     f"{_fmt(reports['B1_passive']['hedged_pnl'])} | "
                     f"{_fmt(reports['B2_fixed_spread']['hedged_pnl'])} |")
    lines += ["",
              f"- equal-weighted mean E1: **{sum(values) / len(values):+.2%}**",
              f"- median E1: **{median:+.2%}**",
              f"- best / worst: **{max(values):+.2%}** / **{min(values):+.2%}**",
              f"- windows where ArbSwap >= B1: **{wins} of {len(values)}**",
              f"- windows where ArbSwap >= B2: **{beats_b2} of {len(values)}**",
              ""]
    return lines


def _study_table(headers: list[str], rows: list[list[str]]) -> list[str]:
    lines = ["| " + " | ".join(headers) + " |",
             "|" + "|".join(["---"] * len(headers)) + "|"]
    lines += ["| " + " | ".join(row) + " |" for row in rows]
    return lines


def render(payload: dict, studies: dict) -> str:
    windows = payload["windows"]
    window_regime = {label: regime for regime, label in payload["regimes"].items()}
    frozen = parse_params(payload["frozen_params"])

    lines: list[str] = []
    lines.append(pre_registration_markdown().rstrip())
    lines.append("")
    lines.append(pre_registration_amendment_markdown().rstrip())
    lines.append("")
    lines.append("# P1 results: held-out replay of six registered weeks")
    lines.append("")
    lines.append(
        "Generated by `python -m research.sim.study render` from "
        f"`{WINDOW_RESULTS_JSON}` and `{STUDY_RESULTS_JSON}`. Reference: Binance "
        "SOL/USDT and USDC/USDT 1-second archives divided into a USDC reference "
        "(the same conversion the pre-registration describes). Flow (noise and "
        "informed) is synthetic; the price path is observed."
    )
    lines.append("")
    lines.append("### Protocol as executed")
    lines.append("")
    lines += _study_table(
        ["Item", "Value"],
        [
            ["headline clock", f"{HEADLINE_STEP_SECONDS} s step, 1.0 s source, "
                               "0.4 s slot, 1.0 s keeper interval"],
            ["seed", str(CALIBRATION_SEED)],
            ["frozen params", f"`spread_floor={frozen.spread_floor}`, "
                              f"`inventory_coeff={frozen.inventory_coeff}`, "
                              f"`volatility_coeff={frozen.volatility_coeff}`, "
                              f"`sigma_target={frozen.sigma_target}`"],
            ["calibration", "W1, 12 blocks x 1 h, 81 candidates (see the amendment)"],
            ["B1 fee", f"{PASSIVE_FEE * 10_000:.0f} bps (run_venues default, fixed "
                       "before registration)"],
            ["vault fee", f"{VAULT_FEE_BPS:.0f} bps"],
            ["measured CU", f"update {CU_UPDATE_QUOTE:,}; swap {CU_SWAP:,} "
                            "(LiteSVM, `programs/arbswap`)"],
            ["regimes", ", ".join(f"{label} = {regime}"
                                  for regime, label in
                                  sorted(payload["regimes"].items()))],
            ["regimes match pre-registration",
             "yes" if payload["regimes_match_pre_registration"] else "**NO - investigate**"],
        ])
    lines.append("")
    lines.append("Per-update cost is charged to the vault's quote; swap cost is "
                 "recorded but not debited (the swapper signs that transaction).")
    lines.append("")

    lines.append("# Held-out windows (W2-W6)")
    lines.append("")
    for label in sorted(windows):
        lines += _window_section(label, windows[label], window_regime)
    lines += _s5_summary(windows, window_regime)

    lines.append("# Studies")
    lines.append("")
    lines.append("## S1: clock sensitivity (ArbSwap vs B1, full windows)")
    lines.append("")
    lines.append("Headline is 0.4 s. A coarser clock hands the arbitrageur fewer "
                 "reactions, so 1.0 s understates adverse selection.")
    lines.append("")
    rows = []
    for label in sorted(windows):
        headline = windows[label]["reports"]
        cells = [label, window_regime.get(label, ""),
                 f"{_fmt(headline['ArbSwap']['hedged_pnl'])} / "
                 f"{_fmt(headline['B1_passive']['hedged_pnl'])}",
                 f"{_e1(headline):+.1%}"]
        for step in SENSITIVITY_STEP_SECONDS:
            row = studies["S1"].get(f"{label}@{step}")
            if row is None:
                cells += ["-", "-"]
                continue
            cells.append(f"{_fmt(row['venues']['ArbSwap']['hedged_pnl'])} / "
                         f"{_fmt(row['venues']['B1_passive']['hedged_pnl'])}")
            cells.append(f"{_e1(row['venues']):+.1%}")
        rows.append(cells)
    lines += _study_table(
        ["Window", "Regime", "PnL @0.4s (Arb/B1)", "E1 @0.4s"]
        + [f"PnL @{step}s (Arb/B1)" for step in SENSITIVITY_STEP_SECONDS]
        + [f"E1 @{step}s" for step in SENSITIVITY_STEP_SECONDS], rows)
    lines.append("")

    lines.append("## S2: slot length (study slice, all venues)")
    lines.append("")
    lines.append("Steps at 0.2 s so every studied slot lands on the simulation grid; "
                 "one hour from each labelled window (12:00-13:00 UTC, day 4).")
    lines.append("")
    rows = []
    for label in sorted(study_keys(studies["S2"])):
        for slot in SLOT_STUDY_SECONDS:
            row = studies["S2"].get(f"{label}@{slot}")
            if row is None:
                continue
            reports = row["reports"]
            rows.append([label, str(slot), _fmt(reports["ArbSwap"]["hedged_pnl"]),
                         _fmt(reports["B1_passive"]["hedged_pnl"]),
                         f"{_e1(reports):+.1%}",
                         f"{reports['ArbSwap']['update_count']:,}",
                         f"{reports['ArbSwap']['quiet_half_spread_bps']:.3f}"])
    lines += _study_table(
        ["Window", "Slot (s)", "ArbSwap PnL", "B1 PnL", "E1", "Keeper updates",
         "Quiet half-spread (bps)"], rows)
    lines.append("")

    lines.append("## S3: oracle latency (100 ms aggTrades reference)")
    lines.append("")
    lines.append("Reference is SOL/USDT aggregated trades binned to 100 ms, so the "
                 "USDC peg (typically <1 bp over an hour) is not removed here; the "
                 "comparison is across latencies on one identical path.")
    lines.append("")
    rows = []
    for label in sorted(AGGTRADES_DATES):
        for latency in LATENCY_STUDY_SECONDS:
            row = studies["S3"].get(f"{label}@{latency}")
            if row is None:
                continue
            venues = row["venues"]
            rows.append([label, row["day"], f"{latency:g}",
                         _fmt(venues["ArbSwap"]["hedged_pnl"]),
                         _fmt(venues["B1_passive"]["hedged_pnl"]),
                         f"{_e1(venues):+.1%}",
                         f"{venues['ArbSwap']['trades']:,}"])
    lines += _study_table(
        ["Window", "Date", "Latency (s)", "ArbSwap PnL", "B1 PnL", "E1",
         "ArbSwap trades"], rows)
    lines.append("")

    lines.append("## S4: seed sensitivity (W2, ArbSwap vs B1)")
    lines.append("")
    lines.append("The flow model is synthetic, so a single seed could flatter or "
                 "punish a venue. Five seeds, same path, same clock.")
    lines.append("")
    rows = []
    for seed in sorted(studies["S4"]):
        venues = studies["S4"][seed]["venues"]
        rows.append([seed, _fmt(venues["ArbSwap"]["hedged_pnl"]),
                     _fmt(venues["B1_passive"]["hedged_pnl"]),
                     f"{_e1(venues):+.1%}",
                     f"{venues['ArbSwap']['trades']:,}"])
    lines += _study_table(["Seed", "ArbSwap PnL", "B1 PnL", "E1", "ArbSwap trades"],
                          rows)
    lines.append("")

    lines += _limitations(windows, window_regime, studies)
    return "\n".join(lines)


def study_keys(mapping: dict) -> list[str]:
    return sorted({key.split("@")[0] for key in mapping})


def _limitations(windows: dict, window_regime: dict, studies: dict) -> list[str]:
    e1_values = [_e1(row["reports"]) for row in windows.values()]
    losses = [label for label, row in sorted(windows.items())
              if _e1(row["reports"]) < 0]
    s4 = studies.get("S4", {})
    s4_values = [_e1(row["venues"]) for row in s4.values()]
    lines = ["## Honest limitations", ""]
    lines.append(f"- **Losing windows are reported as losses.** E1 is negative on "
                 f"{len(losses)} of {len(e1_values)} held-out windows"
                 + (f" ({', '.join(losses)})" if losses else "") + ".")
    if s4_values:
        lines.append(f"- **Seed sensitivity:** on W2, E1 ranges from "
                     f"{min(s4_values):+.1%} to {max(s4_values):+.1%} across "
                     f"{len(s4_values)} seeds; a single seed is not evidence.")
    lines += [
        "- **Flow is synthetic.** Only the price path is observed; markout, quiet "
        "half-spread and the informed/noise mix are model outputs, not measurements "
        "of live order flow.",
        "- **Two costs are heuristics** (ASSUMPTIONS A-15): the priority-fee rate "
        "and the landing-delay distribution. Venue-vs-venue comparisons share them, "
        "so E1 is far more robust than any absolute PnL figure.",
        "- **S3's reference is SOL/USDT**, not USDC-converted: the peg typically "
        "moves less than a basis point within the one-hour slice, and every "
        "latency in the sweep sees the same path.",
        "- **S2 steps at 0.2 s**, not the headline 0.4 s, so that slots of 0.4 / "
        "0.6 / 1.0 s all land on the simulation grid. Slot-length numbers are "
        "therefore not directly comparable with the headline table.",
        "- **The keeper cadence changes slightly with the clock.** On the 1.0 s "
        "clock the grid lands on whole seconds; on 0.4 s and 0.1 s it lands on the "
        "next 0.4 s boundary (1.2 s, 2.0 s, ...). This is reported, not smoothed.",
        "- **No mainnet claim.** These are simulator results on archived prices. "
        "Live RPC, private keys and devnet deployment are P3 gates "
        "(SECURITY_CHECKLIST, one Open row).",
        "",
    ]
    return lines


def _write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(f"[write] {path}", flush=True)


def _load_json(path: Path) -> dict:
    if not path.exists():
        raise SystemExit(f"missing {path}; run that phase first")
    return json.loads(path.read_text())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", nargs="?", default="all",
                        choices=("calibrate", "evaluate", "studies", "render", "all"))
    parser.add_argument("--workers", type=int, default=5)
    args = parser.parse_args()

    if args.phase in ("calibrate", "all"):
        phase_calibrate(args.workers)
    if args.phase in ("evaluate", "all"):
        phase_evaluate(args.workers)
    if args.phase in ("studies", "all"):
        phase_studies(args.workers)
    if args.phase in ("render", "all"):
        text = render(_load_json(WINDOW_RESULTS_JSON), _load_json(STUDY_RESULTS_JSON))
        REPORT_PATH.write_text(text.rstrip() + "\n")
        print(f"[write] {REPORT_PATH} ({len(text.splitlines())} lines)")


if __name__ == "__main__":
    main()
