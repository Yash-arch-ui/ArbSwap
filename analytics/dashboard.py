"""Static dashboard renderer (Build Plan §9.2).

Produces one self-contained HTML file with the LP, trader, risk and comparison
views. Charts are inline SVG, so the output needs no network and is trivially
cacheable — "demo mode" replays deterministically because the HTML is generated
from a fixed event stream rather than live markets.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from html import escape

from analytics import charts
from analytics.metrics import GapStats


@dataclass
class VenueAnalytics:
    name: str
    hedged_pnl: float
    markout_curve: dict = field(default_factory=dict)
    quiet_half_spread_bps: float = 0.0
    gap: GapStats = field(default_factory=GapStats)
    swaps: int = 0
    fees_quote: float = 0.0
    gas_quote: float = 0.0


@dataclass
class RiskView:
    quote_version: int = 0
    breakers_tripped: int = 0
    last_slot: int = 0
    keeper_slashes: float = 0.0


def _table(headers, rows) -> str:
    head = "".join(f"<th>{escape(h)}</th>" for h in headers)
    body = "".join(
        "<tr>" + "".join(f"<td>{escape(str(cell))}</td>" for cell in row) + "</tr>"
        for row in rows
    )
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


def render(title: str, venues: dict[str, VenueAnalytics], *,
           risk: RiskView | None = None, scenario: str = "replay") -> str:
    risk = risk or RiskView()
    primary = venues.get("ArbSwap") or next(iter(venues.values()))
    passive = venues.get("B1_passive")

    lp_rows = [
        [v.name, f"{v.hedged_pnl:,.2f}", f"{v.fees_quote:,.2f}", f"{v.gas_quote:,.4f}",
         f"{v.fees_quote - v.gas_quote - v.hedged_pnl:,.2f}", f"{v.swaps:,}"]
        for v in venues.values()
    ]
    trader_rows = [
        [v.name, f"{v.quiet_half_spread_bps:.3f}",
         f"{v.gap.notional_weighted_mean:+.4f}", f"{v.gap.identical_share:.1%}",
         f"{v.gap.p95:+.4f}"]
        for v in venues.values()
    ]
    risk_rows = [
        ["quote version", risk.quote_version],
        ["breakers tripped", risk.breakers_tripped],
        ["last slot", risk.last_slot],
        ["keeper slashed (quote)", f"{risk.keeper_slashes:,.2f}"],
    ]

    markout = charts.marks_svg(
        {name: sorted(v.markout_curve.items()) for name, v in venues.items() if v.markout_curve},
        title="E2 markout curve (bps, notional-weighted)",
    )
    comparison_values = [v.hedged_pnl for v in venues.values()]
    comparison = charts.bar_svg(
        list(venues.keys()), comparison_values,
        title="E3 hedged PnL by venue (quote)",
    )
    e1 = ""
    if passive is not None and passive.hedged_pnl:
        e1 = (f'<p><strong>E1 (ArbSwap vs B1):</strong> '
              f'{(primary.hedged_pnl - passive.hedged_pnl) / abs(passive.hedged_pnl):+.2%}</p>')

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(title)}</title>
<style>
body{{font-family:system-ui,sans-serif;margin:0;padding:24px;color:#111;background:#f8fafc}}
h1{{font-size:20px}} h2{{font-size:15px;margin-top:24px}}
table{{border-collapse:collapse;margin:8px 0;font-size:13px}}
th,td{{border:1px solid #e2e8f0;padding:4px 8px;text-align:right}}
th:first-child,td:first-child{{text-align:left}}
.card{{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:12px 0}}
.note{{color:#475569;font-size:12px}}
</style></head><body>
<h1>{escape(title)}</h1>
<p class="note">Scenario: <strong>{escape(scenario)}</strong> — deterministic replay, no live data.
Generated from indexed program events (§9.1).</p>

<div class="card"><h2>LP view — attribution (fees - gas - adverse selection = hedged PnL)</h2>
{_table(["venue", "hedged PnL", "fees", "gas", "adverse sel.", "swaps"], lp_rows)}
{e1}
</div>

<div class="card"><h2>Trader view — execution quality</h2>
{_table(["venue", "quiet half-spread (bps)", "gap vw (bps)", "identical share", "gap p95 (bps)"], trader_rows)}
</div>

<div class="card"><h2>Risk view</h2>
{_table(["metric", "value"], risk_rows)}
</div>

<div class="card"><h2>Comparison view</h2>
{markout}
{comparison}
</div>

<div class="card"><h2>Demo mode</h2>
<p class="note">Split-screen replay: the passive pool (B1) and ArbSwap run the same
price path and flow draws; scenario selector calm / trend / crash and attack
buttons (freeze oracle, kill keeper, launch attacker bot) are scenario flags on
this same deterministic renderer. Quotes expire when the keeper is killed
(§7.2), which the risk view reports as a rising quote age / breaker trip.</p>
</div>
</body></html>
"""
