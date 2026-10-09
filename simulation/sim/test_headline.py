"""T6.1 — the one-command headline chart is self-contained and deterministic."""

from __future__ import annotations

from simulation.sim import headline


def test_render_contains_every_venue_and_is_valid_svg():
    rows = [
        {"venue": v, "volume_share": 0.1, "fill_share": 0.2, "markout_2s_bps": 1.0}
        for v in ("ArbSwap", "B1_passive", "PropAMM")
    ]
    svg = headline.render(rows, "synthetic")
    assert svg.startswith("<?xml")
    assert svg.count("<svg") == svg.count("</svg>") == 4  # outer + three panels
    for name in ("ArbSwap", "B1_passive", "PropAMM"):
        assert name in svg
    assert "synthetic" in svg


def test_synthetic_slice_is_deterministic_and_full_length():
    a = headline.synthetic_slice(7)
    b = headline.synthetic_slice(7)
    assert a == b
    assert len(a) == headline.SECONDS
    assert all(p.price > 0 for p in a)


def test_aggregate_always_returns_the_three_venues():
    rows, source = headline.aggregate()
    assert {r["venue"] for r in rows} == {"ArbSwap", "B1_passive", "PropAMM"}
    assert source in ("real", "synthetic")
    assert abs(sum(r["volume_share"] for r in rows) - 1.0) < 1e-6
