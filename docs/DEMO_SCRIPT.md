# DEMO_SCRIPT.md — 3-minute demo and live-demo script (Build Plan §12 P6, T6.3)

Artifacts (all offline, deterministic, **model output** — no funds, no network):

| Artifact | What it is |
|---|---|
| `docs/demo_backup.html` | Self-contained **auto-playing** backup replay (scripted scenes, captions) |
| `docs/demo_backup.mp4` | Rendered backup recording (6 scenes, 1280×720, ~36 s silent; narrate live) |
| `simulation/analytics/out/demo.html` | Interactive split-screen demo (scenario + attack buttons) |

Render everything with one command (writes the HTML; renders the MP4 if a
headless browser and ffmpeg are available):

```bash
CHROME_PATH=/path/to/chrome FFMPEG=/path/to/ffmpeg ./scripts/record_demo.sh
# no browser/ffmpeg? the HTML backup is still produced:
./scripts/record_demo.sh
```

The demo is the **split-screen replay**: passive pool (B1) on the left, ArbSwap on
the right, reference price below. Every dataset is a fixed-seed simulator run
embedded as JSON and drawn client-side — so it never depends on live markets.

## 3-minute video script

Open on the one-line claim, then run the six scenes. Timing is for narration over
the ~36 s backup clip (pause on each scene) or a live run.

| t | Scene | On screen | Narration (say this) |
|---|---|---|---|
| 0:00 | Title | README headline | "ArbSwap is an open, oracle-anchored, two-sided market-making vault. One hard promise: the price you are quoted is the price you get. Everything you'll see is a fixed-seed simulation — model output, not a product result." |
| 0:15 | 1 Baseline (`calm`) | Both value paths flat-ish, metrics panel | "Calm market, keeper live. The vault quotes both sides; B1 just sits there taking flow." |
| 0:45 | 2 `freeze_oracle` | ArbSwap value path changes; status shows the attack | "Now we freeze the oracle for 60 seconds. The vault widens and its stale quotes expire — no fills at a dead price." |
| 1:15 | 3 `kill_keeper` | ArbSwap swaps counter stops | "Kill the keeper. No new quotes, so fills stop. Safe failure by construction — the quote simply expires." |
| 1:45 | 4 Crash (`crash`) | Price path drops, ArbSwap reprices | "A crash. The vault reprices, but only within the on-chain anchor band — the keeper cannot move it arbitrarily." |
| 2:15 | 5 `attacker_bot` | Attacker flow, metrics | "An attacker bot with tight fees and big size. The spread floor and the per-window flow cap hold the line." |
| 2:45 | 6 Summary | Claims + limits | "That's the whole idea: bounded and honest by construction. It is **not** claimed to beat tight propAMMs on routed price, and its economic value is not yet shown on real flow. No known issues in self-review, independent audit pending." |

## Live-demo script (if presenting interactively)

1. `python -m simulation.analytics demo --out simulation/analytics/out/demo.html`
   then open it in a browser.
2. Start on **calm / none**; point at the two panes and the metrics line.
3. Click **freeze oracle** → "quotes expire, the vault doesn't fill a dead price."
4. Click **kill keeper** → "fills stop; safe failure."
5. Switch to **crash**, then click **attacker bot** → "spread floor and flow cap."
6. Close on the limits slide: model output; no competitor claim; audit pending.

## Backup plan

- If the browser or live machine fails, play `docs/demo_backup.mp4` (or open
  `docs/demo_backup.html`, which auto-advances on its own).
- Both are fully offline and deterministic, so the demo cannot be spoiled by
  network or market conditions.

## Honesty guardrails (do not violate on stage)

- Say "model output" whenever a markout/PnL/spread number appears.
- Never say the banned words ("audited", "safe", "cheap", "beats propAMMs", any
  APY). See `docs/CLAIMS.md`.
- Report the losing regime (ArbSwap ~0 routed volume share) as prominently as
  any win.
