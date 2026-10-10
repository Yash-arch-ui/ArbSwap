# P6_AUDIT.md — Story and submission (Build Plan §12 P6)

**Gate: a stranger can reproduce the headline chart from the README. — PASSED.**
`./scripts/headline.sh` writes `docs/headline_chart.svg` with no data and no API
keys (it uses the gitignored raw archives when present, else a deterministic
synthetic price path).

| Task | Status | Evidence |
|---|---|---|
| T6.1 README one-command headline chart | **DONE** | `scripts/headline.sh`, `simulation/sim/headline.py`, `simulation/sim/test_headline.py`; README section "Reproduce the headline chart (one command)"; `docs/headline_chart.svg` |
| T6.2 Methodology doc; results with limits | **DONE** | `docs/METHODOLOGY.md` (E8 line updated to PARTIAL), new `docs/RESULTS.md` |
| T6.3 Demo video + live-demo script; backup recording | **DONE** | `docs/DEMO_SCRIPT.md` (3-min script + live script + backup plan); `docs/demo_backup.html` (auto-play) and rendered `docs/demo_backup.mp4` (36 s, 1280×720, h264); `simulation/analytics/backup.py` + `simulation/analytics/tests/test_backup.py`; `scripts/record_demo.sh` |
| T6.4 Pitch deck | **DONE** | `docs/PITCH_DECK.md` (Marp source) rendered to `docs/pitch_deck.html` and `docs/pitch_deck.pdf`; `scripts/render_deck.sh` |

## Reproduction commands

```bash
./scripts/headline.sh          # headline chart (no data/keys)
./scripts/record_demo.sh       # demo + backup HTML; MP4 if a browser+ffmpeg are present
./scripts/render_deck.sh       # deck HTML; PDF if a browser is present
```

The backup MP4 was rendered with a headless Chromium and `ffmpeg` (static
build); the deck PDF with Marp CLI + headless Chromium. Both scripts degrade
gracefully to the HTML artifact when a browser/ffmpeg is absent.

## Honesty checks

- Every number in `docs/RESULTS.md` is labelled **model output** or **on-chain
  SUPPORTED**; no APY/return projection; no banned wording (`docs/CLAIMS.md`).
- The losing regime (ArbSwap ~0 routed volume share) is in the README-adjacent
  results and the deck, as prominently as the positive model markout.
- The deck closes on limits and "no known issues in self-review, independent
  audit pending."

## Notes / limits

- The demo and backup are **model output** from the fixed-seed simulator; they
  are not live-market replays.
- The deck PDF and demo MP4 are generated artifacts; the committed copies are
  reproducible from the scripts.
