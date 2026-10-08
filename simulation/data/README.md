# Research data

**Download scripts only — no raw data in git** (Build Plan §4).

## T0.4 access confirmation (probed 2026-10-06)

| Source | Purpose | Endpoint verified | Status |
| --- | --- | --- | --- |
| Binance REST klines | live 1s reference prices (SOLUSDT, SOLUSDC) | `GET https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1s&limit=…` | ✅ 200, returns 1s bars |
| Binance bulk archives | full history for walk-forward backtests | `https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?prefix=data/spot/daily/klines/SOLUSDT/1s/` (daily `.zip` + `.CHECKSUM`) | ✅ 200, files from 2020-08-11 onward |
| Bybit public archive | 1s top-of-book markout source (same archive as propAMM paper) | `https://public.bybit.com/trading/SOLUSDT/SOLUSDT2026-….csv.gz`; also `/spot/`, `/spot_index/`, `/premium_index/` | ✅ 200, daily files from 2021-06-29 |
| Pyth Benchmarks (historical) | oracle lag/error history for E1 spread simulation | `https://benchmarks.pyth.network/v1/updates/price/{ts}[/{interval≤60}]` | ✅ **200 with API key** (retention ~75–80 days) |
| Pyth Hermes (live/history) | feed metadata + updates | `https://hermes.pyth.network/v2/…` | ✅ **200 with API key**; metadata works keyless |

**Pyth auth:** since the 2026-08-26 upgrade every Hermes/Benchmarks request
needs `Authorization: Bearer $PYTH_API_KEY`. A working free key is in `.ENV`
at the repo root (`PYTH_API_KEY=<44-char key>`, **gitignored — .gitignore:12**);
load with `set -a; source .ENV; set +a` or `KEY=$(awk -F= '{print $2}' .ENV)`.
Verified 2026-10-06: `latest` 200; historical 200 at 1/2/3/5/7/14/30/60/75
days ago, 404 at 80+ days → **history depth ≈ 75–80 days** (plan backtests
around this; CEX archives below cover the longer horizon). Sample: SOL/USD
2026-10-05 = 12002840057e-8, conf 1.8e-2. Rate limits: 10 req / 10 s / IP.
SOL/USD feed id: `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d`.

## Scripts

Scripts live here as `download_*.py` and write to `raw/` (git-ignored).
Credentials come from environment variables only.
