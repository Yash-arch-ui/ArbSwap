#!/usr/bin/env bash
# T6.3 - render the demo backup recording (Build Plan §12 P6).
# 1. Generates the interactive demo (out/demo.html) and the auto-playing backup
#    HTML (docs/demo_backup.html) - both offline, deterministic, model output.
# 2. If a headless browser and ffmpeg are available, renders docs/demo_backup.mp4
#    from one screenshot per scripted scene. Set CHROME_PATH and FFMPEG (or put
#    them on PATH); otherwise the HTML backup is still produced.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PY="${PYTHON:-python3}"
if [ -x .venv/bin/python ]; then PY=.venv/bin/python; fi

OUT=simulation/analytics/out
"$PY" -m simulation.analytics demo --out "$OUT/demo.html"
"$PY" -m simulation.analytics backup --out "$OUT"
cp "$OUT/demo_backup.html" docs/demo_backup.html
echo "wrote docs/demo_backup.html (auto-playing, offline, no network)"

CHROME="${CHROME_PATH:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)}"
FFMPEG="${FFMPEG:-$(command -v ffmpeg || true)}"
if [ -z "$CHROME" ] || [ -z "$FFMPEG" ]; then
  echo "set CHROME_PATH and FFMPEG to also render docs/demo_backup.mp4"
  exit 0
fi

FRAMES="$(mktemp -d)"
trap 'rm -rf "$FRAMES"' EXIT
for f in "$OUT"/scene_*.html; do
  b="$(basename "$f" .html)"
  "$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --window-size=1280,720 \
    --virtual-time-budget=1500 --screenshot="$FRAMES/$b.png" "file://$ROOT/$f" \
    >/dev/null 2>&1 || true
done
: > "$FRAMES/list.txt"
for f in "$FRAMES"/scene_*.png; do
  echo "file '$f'" >> "$FRAMES/list.txt"
  echo "duration 6" >> "$FRAMES/list.txt"
done
echo "file '$(ls "$FRAMES"/scene_*.png | tail -1)'" >> "$FRAMES/list.txt"
"$FFMPEG" -y -f concat -safe 0 -i "$FRAMES/list.txt" \
  -vf "fps=30,format=yuv420p" -r 30 -c:v libx264 -pix_fmt yuv420p \
  docs/demo_backup.mp4 >/dev/null 2>&1
echo "wrote docs/demo_backup.mp4"
