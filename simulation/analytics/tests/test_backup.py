"""T6.3 — the backup recording HTML is self-contained and scripted."""

from __future__ import annotations

from simulation.analytics import backup


def test_scene_sequence_is_six_captioned_scenes():
    assert len(backup.SCENE_SEQUENCE) == 6
    assert all(len(step) == 3 for step in backup.SCENE_SEQUENCE)
    scenarios = {s for s, _, _ in backup.SCENE_SEQUENCE}
    attacks = {a for _, a, _ in backup.SCENE_SEQUENCE}
    assert scenarios <= {"calm", "trend", "crash"}
    assert {"freeze_oracle", "kill_keeper", "attacker_bot"} <= attacks


def test_autoplay_html_is_offline_and_auto_advances():
    data = {"calm:none": {"B1_passive": {}, "ArbSwap": {}, "price_path": []}}
    html = backup.autoplay_html(data)
    assert "setInterval" in html          # auto-advances without clicks
    assert 'id="cap"' in html             # caption overlay
    assert "REC" in html
    assert "http://" not in html and "https://" not in html  # no network/CDN
    assert backup.SCENE_SEQUENCE[0][2] in html


def test_scene_html_freezes_the_requested_scene():
    data = {"crash:attacker_bot": {"B1_passive": {}, "ArbSwap": {}, "price_path": []}}
    html = backup.scene_html(data, "crash", "attacker_bot", "cap-here")
    assert 'let scenario = "crash", attack = "attacker_bot";' in html
    assert "cap-here" in html
