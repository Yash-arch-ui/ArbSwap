"""Backup recording for the demo (Build Plan §12 P6, T6.3).

Turns the deterministic demo datasets (`demo.build_data`) into:

- ``demo_backup.html`` — a **self-contained auto-playing** replay (no clicks, no
  network) that cycles the scripted scene sequence with captions, so the story
  can be shown even if the live demo fails.
- ``scene_*.html`` — one static page per scripted scene, used by
  ``scripts/record_demo.sh`` to render ``docs/demo_backup.mp4`` with a headless
  browser + ffmpeg.

Everything here is a model output from the fixed-seed simulator; it is not live
market data.

    python -m simulation.analytics backup --out simulation/analytics/out
"""

from __future__ import annotations

import json
from pathlib import Path

from simulation.analytics import demo

# (scenario, attack, caption) — the 3-minute script, one caption per scene.
SCENE_SEQUENCE: tuple[tuple[str, str, str], ...] = (
    ("calm", "none", "1/6  Baseline: calm market, keeper live, vault quotes both sides"),
    ("calm", "freeze_oracle", "2/6  Attack: oracle frozen 60s -> vault widens, stale quotes expire"),
    ("trend", "kill_keeper", "3/6  Attack: keeper killed -> no new quotes, fills stop (safe failure)"),
    ("crash", "none", "4/6  Crash: vault reprices, bounded by the on-chain anchor band"),
    ("crash", "attacker_bot", "5/6  Attack: attacker bot -> spread floor + flow cap hold"),
    ("crash", "freeze_oracle", "6/6  Summary: bounded and honest by construction; model output only"),
)

_CAPTION_DIV = (
    '<div id="cap" style="position:fixed;left:0;right:0;bottom:0;z-index:9;'
    'background:#0f172a;color:#fff;padding:10px 16px;font:14px/1.4 system-ui,sans-serif">'
    "{caption}</div>"
    '<div style="position:fixed;top:10px;right:14px;z-index:9;background:#dc2626;'
    'color:#fff;padding:3px 9px;border-radius:4px;font:12px system-ui">REC &#9679;</div>'
)


def _with_caption(html: str, caption: str) -> str:
    return html.replace("</body>", _CAPTION_DIV.format(caption=caption) + "</body>")


def _force_scene(html: str, scenario: str, attack: str) -> str:
    return html.replace(
        'let scenario = SCENARIOS[0], attack = "none";',
        f'let scenario = {json.dumps(scenario)}, attack = {json.dumps(attack)};',
    )


def scene_html(data: dict, scenario: str, attack: str, caption: str) -> str:
    """A static page frozen on one scripted scene (for a screenshot frame)."""
    return _with_caption(_force_scene(demo.render(data), scenario, attack), caption)


_AUTOPLAY_JS = """
<script>
(function () {
  const SEQ = __SEQ__;
  let i = 0;
  function step() {
    const [s, a, cap] = SEQ[i % SEQ.length];
    scenario = s; attack = a;
    document.getElementById("scenario").value = s;
    draw();
    document.getElementById("cap").textContent = cap;
    i++;
  }
  step();
  setInterval(step, 5000);
})();
</script>
"""


def autoplay_html(data: dict) -> str:
    """The self-contained auto-playing backup recording."""
    seq = [[s, a, cap] for s, a, cap in SCENE_SEQUENCE]
    html = demo.render(data)
    html = html.replace("</body>", _AUTOPLAY_JS.replace("__SEQ__", json.dumps(seq)) + "</body>")
    return _with_caption(html, SCENE_SEQUENCE[0][2])


def build(out_dir: Path, *, length: int = 1_800, seed: int = 20261006) -> dict:
    """Write the auto-play HTML and one static scene page per scripted step."""
    data = demo.build_data(length=length, seed=seed)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "demo_backup.html").write_text(autoplay_html(data))
    scenes = []
    for index, (scenario, attack, caption) in enumerate(SCENE_SEQUENCE):
        path = out_dir / f"scene_{index:02d}.html"
        path.write_text(scene_html(data, scenario, attack, caption))
        scenes.append({"index": index, "scenario": scenario, "attack": attack,
                       "caption": caption, "file": path.name})
    (out_dir / "scenes.json").write_text(json.dumps(scenes, indent=2) + "\n")
    return {"out_dir": str(out_dir), "scenes": scenes}
