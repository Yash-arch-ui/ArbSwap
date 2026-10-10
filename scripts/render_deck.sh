#!/usr/bin/env bash
# T6.4 - render the pitch deck (Build Plan §12 P6).
# docs/PITCH_DECK.md is Marp source. Produces docs/pitch_deck.html (always) and
# docs/pitch_deck.pdf (needs a headless browser: set CHROME_PATH or install one).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MARP=(npx --yes @marp-team/marp-cli@latest)

"${MARP[@]}" docs/PITCH_DECK.md -o docs/pitch_deck.html --allow-local-files --html
echo "wrote docs/pitch_deck.html"

if [ -n "${CHROME_PATH:-}" ] || command -v chromium >/dev/null 2>&1 \
   || command -v google-chrome >/dev/null 2>&1; then
  "${MARP[@]}" docs/PITCH_DECK.md -o docs/pitch_deck.pdf --allow-local-files
  echo "wrote docs/pitch_deck.pdf"
else
  echo "set CHROME_PATH (or install a browser) to also render docs/pitch_deck.pdf"
fi
