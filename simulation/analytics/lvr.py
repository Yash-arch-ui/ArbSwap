#!/usr/bin/env python3
"""Public LVR transparency — generate ``lvr_history.json`` (modeled first release).

This module turns the existing **modeled** weekly replay
(``simulation/data/results/window_results.json``) into a versioned, public LVR
artifact. It does not measure real-world LVR and it does not fabricate data.

What is genuinely supported by the existing evidence:

- ``passive_lvr_usd`` — the passive-AMM baseline LVR for each window, computed by
  the simulator as ``(sigma**2 / 8) * V * T`` (``simulation/sim/study.py``,
  Milionis et al. Example 3). Status: **modeled**.
- ``fees_usd`` — the gross modeled vault fee, ``turnover_quote * vault_fee_bps /
  10_000``. Status: **modeled**. The insurance/keeper/protocol split and the
  LP-retained net are NOT modeled.
- ``arbswap_markout_2s_bps`` — the modeled 2 s markout for the ArbSwap venue. This
  is an **adverse-selection proxy**, not LVR.

What is deliberately **unavailable** (never silently zero):

- ``arbswap_lvr_usd`` — no measured ArbSwap LVR exists; renaming markout to LVR
  would be dishonest (see ``docs/PUBLIC_LVR_TRANSPARENCY_PLAN.md`` §Methodology).
- ``net_lp_impact_usd`` — cannot be computed without compatible ArbSwap LVR.

The artifact is validated before it is written: malformed dates, non-finite or
negative numbers, missing benchmark metadata, unsupported schema versions and
inconsistent units are rejected.

Run: ``.venv/bin/python -m simulation.analytics.lvr``
"""

from __future__ import annotations

import json
import math
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
WINDOW_RESULTS = ROOT / "simulation" / "data" / "results" / "window_results.json"
CANONICAL = ROOT / "simulation" / "data" / "results" / "lvr_history.json"
SERVED = ROOT / "app" / "public" / "analytics" / "lvr_history.json"

SCHEMA_VERSION = 1
METHODOLOGY_VERSION = "lvr_history_v1"
BENCHMARK = "pyth_mid_plus_venue_mid"
MARKOUT_SECONDS = 2
COVERAGE_FULL_BPS = 10_000

# Fields a row may carry; unavailable metrics are ``None`` with a reason at the
# artifact level (never a substituted zero).
ROW_FIELDS = (
    "date", "label", "period_start", "period_end", "seconds",
    "swaps", "volume_usd", "passive_lvr_usd", "arbswap_lvr_usd",
    "arbswap_markout_2s_bps", "lvr_reduction_pct", "fees_usd", "net_lp_impact_usd",
    "coverage_bps", "status",
)

UNAVAILABLE: dict[str, str] = {
    "arbswap_lvr_usd": (
        "ArbSwap realized LVR is not separately measured in the available "
        "evidence. The modeled 2s markout (arbswap_markout_2s_bps) is an "
        "adverse-selection proxy, not LVR; it is not renamed to LVR."
    ),
    "net_lp_impact_usd": (
        "Requires compatible fees and ArbSwap LVR components with matching units "
        "and windows; ArbSwap LVR is unavailable, so net LP impact is not computed."
    ),
}

LIMITATIONS = [
    "Modeled, not measured: all values come from the weekly synthetic replay "
    "(real price path, synthetic flow), not from live LP experience.",
    "The passive baseline is the standard (sigma**2/8)*V*T LVR formula applied to "
    "the passive venue's initial value; it is a benchmark, not a competitor's "
    "realized result.",
    "ArbSwap LVR is unavailable; a 2s markout proxy is shown separately and is "
    "never labeled as LVR.",
    "Fees are the gross modeled vault fee; the fee-bucket split and the "
    "LP-retained net are not modeled.",
    "Coverage is the fraction of the modeled window period covered by the replay "
    "(10000 = full window). It is NOT uptime, quote availability, or real "
    "observation completeness.",
    "Windows are 7-day replay periods, not calendar days; 'date' is the period "
    "start and rows are NOT daily observations.",
]


def _git_short() -> str | None:
    try:
        out = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT,
                             capture_output=True, text=True, check=True)
        return out.stdout.strip() or None
    except Exception:
        return None


def _parse_period(dates: str) -> tuple[str, str]:
    """Parse the window's ``"YYYY-MM-DD .. YYYY-MM-DD"`` label."""
    parts = [p.strip() for p in dates.split("..")]
    if len(parts) != 2:
        raise ValueError(f"malformed window dates: {dates!r}")
    start, end = parts
    # Validate ISO dates.
    datetime.strptime(start, "%Y-%m-%d")
    datetime.strptime(end, "%Y-%m-%d")
    return start, end


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def build_lvr_history(
    window_results: dict[str, Any],
    *,
    generated_at: str | None = None,
    commit: str | None = None,
) -> dict[str, Any]:
    """Build the LVR history artifact from the modeled weekly replay.

    Deterministic given ``generated_at`` (defaults to the source file's mtime so
    a rebuild of unchanged inputs is byte-identical)."""
    windows = window_results.get("windows")
    if not isinstance(windows, dict) or not windows:
        raise ValueError("window_results.json has no 'windows'")

    vault_fee_bps = window_results.get("vault_fee_bps")
    if not _finite(vault_fee_bps):
        raise ValueError("window_results.json missing numeric 'vault_fee_bps'")

    if generated_at is None:
        mtime = WINDOW_RESULTS.stat().st_mtime if WINDOW_RESULTS.exists() else 0.0
        generated_at = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z")

    rows: list[dict[str, Any]] = []
    for label in sorted(windows):
        w = windows[label]
        start, end = _parse_period(str(w["dates"]))
        reports = w.get("reports") or {}
        arb = reports.get("ArbSwap") or {}

        passive_lvr = w.get("theory_lvr_quote")
        turnover = arb.get("turnover_quote")
        markout = arb.get("markout_2s_bps")
        trades = arb.get("trades")

        if not _finite(passive_lvr) or float(passive_lvr) < 0:
            raise ValueError(f"{label}: invalid theory_lvr_quote")
        if not _finite(turnover) or float(turnover) < 0:
            raise ValueError(f"{label}: invalid ArbSwap turnover_quote")
        if not _finite(markout):
            raise ValueError(f"{label}: invalid ArbSwap markout_2s_bps")
        if not isinstance(trades, int) or trades < 0:
            raise ValueError(f"{label}: invalid ArbSwap trades")

        # E1 (modeled): fractional hedged-PnL improvement of ArbSwap over the
        # passive pool on the same path — the repository's existing LVR-reduction
        # metric (`simulation/sim/experiments.py::e1_lvr_reduction`). Modeled, not
        # measured; it is NOT an LVR amount and can be large when ArbSwap fills
        # more volume. It is `None` if the passive baseline is zero/absent.
        passive_hedged = (reports.get("B1_passive") or {}).get("hedged_pnl")
        arb_hedged = arb.get("hedged_pnl")
        lvr_reduction_pct: float | None = None
        if _finite(passive_hedged) and float(passive_hedged) != 0.0 and _finite(arb_hedged):
            lvr_reduction_pct = round((float(arb_hedged) - float(passive_hedged)) / abs(float(passive_hedged)) * 100.0, 6)

        fees = float(turnover) * float(vault_fee_bps) / 10_000.0
        rows.append({
            "date": start,
            "label": label,
            "period_start": start,
            "period_end": end,
            "seconds": int(w.get("seconds", 0)),
            "swaps": int(trades),
            "volume_usd": round(float(turnover), 6),
            "passive_lvr_usd": round(float(passive_lvr), 6),
            "arbswap_lvr_usd": None,
            "arbswap_markout_2s_bps": round(float(markout), 6),
            "lvr_reduction_pct": lvr_reduction_pct,
            "fees_usd": round(fees, 6),
            "net_lp_impact_usd": None,
            "coverage_bps": COVERAGE_FULL_BPS,
            "status": "modeled",
        })

    passive_total = round(sum(r["passive_lvr_usd"] for r in rows), 6)
    fees_total = round(sum(r["fees_usd"] for r in rows), 6)
    reductions = [r["lvr_reduction_pct"] for r in rows if r["lvr_reduction_pct"] is not None]
    reduction_mean = round(sum(reductions) / len(reductions), 6) if reductions else None

    artifact = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "benchmark": BENCHMARK,
        "benchmark_description": (
            "Reference mid = the configured Pyth SOL/USD mid; markout horizon = "
            f"{MARKOUT_SECONDS}s. The passive baseline is (sigma**2/8)*V*T on the "
            "passive venue's initial value."
        ),
        "methodology_version": METHODOLOGY_VERSION,
        "markout_seconds": MARKOUT_SECONDS,
        "aggregation_period": "window",
        "units": {"lvr": "quote_usd", "fees": "quote_usd", "markout": "bps", "coverage": "bps"},
        "source": "modeled weekly replay (simulation/data/results/window_results.json)",
        "provenance": {
            "kind": "modeled",
            "generator": "simulation/analytics/lvr.py",
            "methodology_version": METHODOLOGY_VERSION,
            "inputs": ["simulation/data/results/window_results.json"],
            "flow_type": "synthetic (real price path)",
            "commit": commit if commit is not None else _git_short(),
        },
        "coverage_definition": (
            "Fraction of the modeled window period covered by the replay, in bps "
            "(10000 = full window). Not uptime or real observation completeness."
        ),
        "rows": rows,
        "totals": {
            "passive_lvr_usd": passive_total,
            "fees_usd": fees_total,
            "arbswap_lvr_usd": None,
            "net_lp_impact_usd": None,
            "lvr_reduction_pct_mean": reduction_mean,
            "swaps": sum(r["swaps"] for r in rows),
            "volume_usd": round(sum(r["volume_usd"] for r in rows), 6),
        },
        "unavailable": dict(UNAVAILABLE),
        "limitations": list(LIMITATIONS),
    }
    validate(artifact)
    return artifact


def validate(artifact: dict[str, Any]) -> None:
    """Reject malformed artifacts. Raises ``ValueError`` on any violation."""
    if not isinstance(artifact, dict):
        raise ValueError("artifact is not an object")
    if artifact.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"unsupported schema_version: {artifact.get('schema_version')!r}")
    gen = artifact.get("generated_at")
    if not isinstance(gen, str) or not gen:
        raise ValueError("missing generated_at")
    if artifact.get("benchmark") != BENCHMARK:
        raise ValueError("missing/unsupported benchmark metadata")
    if artifact.get("markout_seconds") != MARKOUT_SECONDS:
        raise ValueError("unsupported markout_seconds")
    units = artifact.get("units")
    if not isinstance(units, dict) or units.get("lvr") != "quote_usd":
        raise ValueError("inconsistent units")

    rows = artifact.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("rows must be a non-empty list")

    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f"row {i} is not an object")
        for field in ROW_FIELDS:
            if field not in row:
                raise ValueError(f"row {i} missing field {field!r}")
        for dfield in ("date", "period_start", "period_end"):
            try:
                datetime.strptime(str(row[dfield]), "%Y-%m-%d")
            except ValueError as exc:
                raise ValueError(f"row {i} malformed {dfield}: {row[dfield]!r}") from exc
        cov = row["coverage_bps"]
        if not isinstance(cov, int) or isinstance(cov, bool) or not (0 <= cov <= COVERAGE_FULL_BPS):
            raise ValueError(f"row {i} invalid coverage_bps: {cov!r}")
        if row.get("status") not in ("modeled", "indexed", "on-chain-verified"):
            raise ValueError(f"row {i} invalid status: {row.get('status')!r}")
        for nfield in ("volume_usd", "passive_lvr_usd", "arbswap_markout_2s_bps", "fees_usd"):
            v = row[nfield]
            if not _finite(v) or float(v) < 0:
                raise ValueError(f"row {i} invalid {nfield}: {v!r}")
        # The modeled LVR-reduction % may be negative; it must be finite when present.
        lr = row["lvr_reduction_pct"]
        if lr is not None and not _finite(lr):
            raise ValueError(f"row {i} invalid lvr_reduction_pct: {lr!r}")
        # Unavailable metrics must be null, never a substituted zero.
        for nfield in ("arbswap_lvr_usd", "net_lp_impact_usd"):
            if row[nfield] is not None:
                raise ValueError(f"row {i} {nfield} must be null (unavailable), got {row[nfield]!r}")
        if not isinstance(row["swaps"], int) or row["swaps"] < 0:
            raise ValueError(f"row {i} invalid swaps")


def dumps(artifact: dict[str, Any]) -> str:
    return json.dumps(artifact, indent=2, sort_keys=True) + "\n"


def write_artifacts(artifact: dict[str, Any]) -> list[Path]:
    """Write the canonical and served copies (byte-identical)."""
    text = dumps(artifact)
    written: list[Path] = []
    for path in (CANONICAL, SERVED):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        written.append(path)
    return written


def main() -> None:
    window_results = json.loads(WINDOW_RESULTS.read_text())
    generated_at = os.environ.get("LVR_GENERATED_AT") or None
    artifact = build_lvr_history(window_results, generated_at=generated_at)
    paths = write_artifacts(artifact)
    print(f"lvr_history: {len(artifact['rows'])} modeled rows, schema v{SCHEMA_VERSION}")
    for p in paths:
        print(f"  wrote {p.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
