"""Interactive demo mode (Build Plan §9.2).

Generates ONE self-contained HTML file: a **split-screen** replay of the passive
pool (B1, left) versus ArbSwap (right), with a **scenario selector**
(calm / trend / crash) and **attack buttons** (freeze oracle, kill keeper,
launch attacker bot). Every scenario/attack dataset is produced by the verified
simulator with a fixed seed, embedded as JSON, and rendered client-side by
vanilla JS — so the demo is deterministic, cached, and works offline with no
network, no CDN, and no funds.

    python -m simulation.analytics demo --out simulation/analytics/out/demo.html
"""

from __future__ import annotations

import json
from pathlib import Path

SCENARIOS = ("calm", "trend", "crash")
ATTACKS = ("none", "freeze_oracle", "kill_keeper", "attacker_bot")


def _run(scenario: str, attack: str, *, length: int, seed: int) -> dict:
    from simulation.analytics.bridge import analytics_for
    from simulation.sim.engine import simulate
    from simulation.sim.flow import InformedFlow, NoiseFlow
    from simulation.sim.oracle import OracleModel
    from simulation.sim.price_source import synthetic_series
    from simulation.sim.venues import PassivePool, VaultVenue

    points = synthetic_series(regime=scenario, length=length, seed=seed)
    price_path = [p.price for p in points]

    def price_at(second: int):
        return price_path[second] if 0 <= second < len(price_path) else None

    latency, keeper_interval = 1.0, 1.0
    informed = InformedFlow()
    noise = NoiseFlow(seed=seed)
    if attack == "freeze_oracle":
        latency = 60.0
        informed = InformedFlow(fee_bps=1.0, max_size=5_000.0)
    elif attack == "kill_keeper":
        keeper_interval = 1e9
    elif attack == "attacker_bot":
        noise = NoiseFlow(arrival_rate=0.8, mean_size=150.0, seed=seed)
        informed = InformedFlow(fee_bps=0.25, max_size=15_000.0)

    out: dict = {"price_path": _downsample(price_path)}
    for name, venue in (("ArbSwap", VaultVenue()), ("B1_passive", PassivePool(fee=0.0001))):
        result = simulate(
            venue_name=name,
            venue=venue,
            prices=points,
            oracle=OracleModel(latency_seconds=latency, seed=seed),
            noise=noise,
            informed=informed,
            step_seconds=1.0,
            keeper_update_interval_seconds=keeper_interval,
        )
        analytics = analytics_for(result, name, price_at)
        out[name] = {
            "value_path": _downsample(result.value_path),
            "hedged_pnl": analytics.hedged_pnl,
            "markout_2s_bps": analytics.markout_curve.get(2, 0.0),
            "quiet_half_spread_bps": analytics.quiet_half_spread_bps,
            "gap_bps": analytics.gap.notional_weighted_mean,
            "swaps": analytics.swaps,
        }
    return out


def _downsample(values: list, target: int = 160) -> list:
    if len(values) <= target:
        return list(values)
    step = len(values) / target
    return [values[min(len(values) - 1, int(i * step))] for i in range(target)]


def build_data(*, length: int = 1_800, seed: int = 20261006) -> dict:
    data = {}
    for scenario in SCENARIOS:
        for attack in ATTACKS:
            data[f"{scenario}:{attack}"] = _run(scenario, attack, length=length, seed=seed)
    return data


_TEMPLATE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ArbSwap demo mode</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#f8fafc;color:#0f172a}
h1{font-size:20px} h2{font-size:15px;margin:0 0 8px}
.note{color:#475569;font-size:12px}
.controls{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:12px 0}
button{padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer}
button.active{background:#0f172a;color:#fff}
.split{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.pane{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-top:12px}
.metrics{font-size:12px;color:#334155;margin-top:6px;white-space:pre-line}
</style></head><body>
<h1>ArbSwap demo mode — split-screen deterministic replay</h1>
<p class="note">Simulation only, no funds involved. Deterministic cached replay;
no live markets and no network. Each dataset is a fixed-seed simulator run.</p>
<div class="controls">
  <label>Scenario <select id="scenario"></select></label>
  <span>Attack:</span>
  <button data-attack="none">none</button>
  <button data-attack="freeze_oracle">freeze oracle</button>
  <button data-attack="kill_keeper">kill keeper</button>
  <button data-attack="attacker_bot">attacker bot</button>
</div>
<div id="status" class="note"></div>
<div class="split">
  <div class="pane"><h2>Passive pool (B1)</h2><div id="chart-b1"></div><div id="m-b1" class="metrics"></div></div>
  <div class="pane"><h2>ArbSwap</h2><div id="chart-arb"></div><div id="m-arb" class="metrics"></div></div>
</div>
<div class="card"><h2>Reference price</h2><div id="chart-price"></div></div>
<script>
const DATA = __DATA__;
const SCENARIOS = __SCENARIOS__;
let scenario = SCENARIOS[0], attack = "none";

function svgLine(values, w, h, color) {
  if (!values || !values.length) return "";
  const lo = Math.min.apply(null, values), hi = Math.max.apply(null, values);
  const span = (hi - lo) || 1;
  const pts = values.map(function (v, i) {
    const x = (i / Math.max(1, values.length - 1)) * w;
    const y = h - ((v - lo) / span) * h;
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  return '<svg width="100%" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
    '<polyline fill="none" stroke="' + color + '" stroke-width="2" points="' + pts + '"/></svg>';
}

function fmt(v) { return (v >= 0 ? "+" : "") + Number(v).toFixed(2); }

function draw() {
  const d = DATA[scenario + ":" + attack];
  const b1 = d["B1_passive"], arb = d["ArbSwap"];
  document.getElementById("chart-b1").innerHTML = svgLine(b1.value_path, 560, 180, "#2563eb");
  document.getElementById("chart-arb").innerHTML = svgLine(arb.value_path, 560, 180, "#16a34a");
  document.getElementById("chart-price").innerHTML = svgLine(d.price_path, 1140, 120, "#64748b");
  document.getElementById("m-b1").textContent =
    "hedged PnL " + fmt(b1.hedged_pnl) + " | markout2s " + b1.markout_2s_bps.toFixed(3) +
    " bps | quiet half-spread " + b1.quiet_half_spread_bps.toFixed(3) + " bps | swaps " + b1.swaps;
  document.getElementById("m-arb").textContent =
    "hedged PnL " + fmt(arb.hedged_pnl) + " | markout2s " + arb.markout_2s_bps.toFixed(3) +
    " bps | quiet half-spread " + arb.quiet_half_spread_bps.toFixed(3) + " bps | swaps " + arb.swaps;
  document.getElementById("status").textContent =
    "scenario=" + scenario + "  attack=" + attack + "  (deterministic, offline, cached)";
  document.querySelectorAll("button[data-attack]").forEach(function (b) {
    b.classList.toggle("active", b.dataset.attack === attack);
  });
}

const sel = document.getElementById("scenario");
SCENARIOS.forEach(function (s) { const o = document.createElement("option"); o.value = s; o.textContent = s; sel.appendChild(o); });
sel.addEventListener("change", function (e) { scenario = e.target.value; draw(); });
document.querySelectorAll("button[data-attack]").forEach(function (b) {
  b.addEventListener("click", function () { attack = b.dataset.attack; draw(); });
});
draw();
</script>
</body></html>
"""


def render(data: dict) -> str:
    return (
        _TEMPLATE.replace("__DATA__", json.dumps(data, sort_keys=True))
        .replace("__SCENARIOS__", json.dumps(list(SCENARIOS)))
    )


def build_demo(out: Path, *, length: int = 1_800, seed: int = 20261006) -> str:
    data = build_data(length=length, seed=seed)
    html = render(data)
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(html)
    return html
