"""Dependency-free SVG charts for the dashboard (Build Plan §9.2).

No plotting library is used so the analytics package stays installable with the
standard library and the tests can assert on generated markup.
"""

from __future__ import annotations

from html import escape

_PALETTE = ("#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed")


def _scale(values, lo, hi, size):
    span = hi - lo or 1.0
    return [int((v - lo) / span * size) for v in values]


def line_svg(points: list[tuple[float, float]], *, width: int = 560, height: int = 200,
             title: str = "", color: str = _PALETTE[0]) -> str:
    """Line chart of ``(x, y)`` points, x ascending."""
    if not points:
        return f'<svg viewBox="0 0 {width} {height}"><text x="8" y="20">{escape(title)} (no data)</text></svg>'
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    pad = 28
    px = _scale(xs, min(xs), max(xs), width - 2 * pad)
    lo, hi = min(ys), max(ys)
    py = _scale(ys, lo, hi, height - 2 * pad)
    path = " ".join(
        f"{'M' if i == 0 else 'L'}{x + pad},{height - (y + pad)}"
        for i, (x, y) in enumerate(zip(px, py))
    )
    zero = ""
    if lo < 0 < hi:
        zy = _scale([0.0], lo, hi, height - 2 * pad)[0] + pad
        zero = f'<line x1="{pad}" y1="{height - zy}" x2="{width - pad}" y2="{height - zy}" stroke="#9ca3af" stroke-dasharray="4 4"/>'
    return (
        f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="{escape(title)}">'
        f'<text x="{pad}" y="16" font-size="13" fill="#111">{escape(title)}</text>'
        f'{zero}<path d="{path}" fill="none" stroke="{color}" stroke-width="2"/>'
        f'<text x="{pad}" y="{height - 6}" font-size="10" fill="#6b7280">{xs[0]:.0f} .. {xs[-1]:.0f}</text>'
        f'<text x="{pad}" y="{height - 6 - (height - 2 * pad)}" font-size="10" fill="#6b7280"></text>'
        f'</svg>'
    )


def bar_svg(labels: list[str], values: list[float], *, width: int = 560, height: int = 200,
            title: str = "") -> str:
    """Horizontal bar chart (works for negative values too)."""
    if not labels:
        return f'<svg viewBox="0 0 {width} {height}"><text x="8" y="20">{escape(title)}</text></svg>'
    lo = min(0.0, min(values))
    hi = max(0.0, max(values))
    rows = len(labels)
    bar_h = max(14, (height - 30) // rows - 6)
    zero_x = 30 + int((0 - lo) / ((hi - lo) or 1) * (width - 140))
    bars = []
    for i, (label, value) in enumerate(zip(labels, values)):
        y = 20 + i * (bar_h + 6)
        end = 30 + int((value - lo) / ((hi - lo) or 1) * (width - 140))
        x = min(zero_x, end)
        w = abs(end - zero_x)
        color = _PALETTE[2] if value >= 0 else _PALETTE[1]
        bars.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{bar_h}" fill="{color}"/>'
            f'<text x="4" y="{y + bar_h - 2}" font-size="11" fill="#111">{escape(label)}</text>'
            f'<text x="{end + 4}" y="{y + bar_h - 2}" font-size="10" fill="#374151">{value:+.1f}</text>'
        )
    return (
        f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="{escape(title)}">'
        f'<text x="8" y="12" font-size="13" fill="#111">{escape(title)}</text>'
        + "".join(bars)
        + "</svg>"
    )


def marks_svg(series: dict[str, list[tuple[float, float]]], *, width: int = 560,
              height: int = 200, title: str = "") -> str:
    """Multi-series line chart (e.g. markout curves for two venues)."""
    if not series:
        return line_svg([], width=width, height=height, title=title)
    parts = [f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="{escape(title)}">',
             f'<text x="28" y="16" font-size="13" fill="#111">{escape(title)}</text>']
    pad = 28
    xs = [p[0] for pts in series.values() for p in pts]
    ys = [p[1] for pts in series.values() for p in pts]
    lo, hi = min(ys), max(ys)
    for i, (name, pts) in enumerate(series.items()):
        px = _scale([p[0] for p in pts], min(xs), max(xs), width - 2 * pad)
        py = _scale([p[1] for p in pts], lo, hi, height - 2 * pad)
        path = " ".join(
            f"{'M' if j == 0 else 'L'}{x + pad},{height - (y + pad)}"
            for j, (x, y) in enumerate(zip(px, py))
        )
        parts.append(f'<path d="{path}" fill="none" stroke="{_PALETTE[i % len(_PALETTE)]}" stroke-width="2"/>')
        parts.append(f'<text x="{width - 150}" y="{16 + i * 14}" font-size="11" fill="{_PALETTE[i % len(_PALETTE)]}">{escape(name)}</text>')
    parts.append("</svg>")
    return "".join(parts)
