"""Download historical Pyth oracle updates from Pyth Benchmarks (T0.4, §8.6).

The Benchmarks endpoint returns 1-second-spaced points inside each requested
window (window width <= 60 s), so a range is paged in 60 s windows. Since the
2026-08-26 upgrade every request needs an API key; we read ``PYTH_API_KEY``
from the environment (see ``.ENV`` and ``research/data/README.md``).

Output columns: ``timestamp,price,conf,publish_time`` where ``price`` is the
human-scaled oracle price (``raw * 10**expo``), ``conf`` the absolute
confidence half-width and ``publish_time`` the Pyth publish second.

Usage::

    PYTH_API_KEY=... python -m research.data.download_pyth \
        --hours 1 --out research/data/raw/pyth_SOLUSD_1s.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

BENCHMARKS = "https://benchmarks.pyth.network/v1/updates/price"
USER_AGENT = "arbswap-research/0.1"
SOL_USD_FEED = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"
WINDOW_SECONDS = 60
REQUESTS_PER_WINDOW = 1
# Benchmarks allows 10 requests / 10 s / IP; stay comfortably under it.
THROTTLE_SECONDS = 1.05


def _api_key(explicit: str | None = None) -> str:
    key = explicit or os.environ.get("PYTH_API_KEY")
    if key:
        return key.strip()
    env_file = Path(".ENV")
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("PYTH_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError("PYTH_API_KEY not set and not found in .ENV")


def _get(url: str, key: str, *, retries: int = 5, backoff: float = 1.5):
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(
                url, headers={"User-Agent": USER_AGENT, "Authorization": f"Bearer {key}"}
            )
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            time.sleep(backoff**attempt)
    raise RuntimeError(f"request failed after {retries} attempts: {url}") from last_error


def _parse_price(parsed: dict) -> tuple[float, float, int]:
    price = parsed["price"]
    scale = 10.0 ** price["expo"]
    return (
        int(price["price"]) * scale,
        int(price["conf"]) * scale,
        int(price["publish_time"]),
    )


def download(
    *,
    hours: float = 1.0,
    out: Path,
    feed_id: str = SOL_USD_FEED,
    api_key: str | None = None,
    end_time: int | None = None,
) -> Path:
    key = _api_key(api_key)
    end_time = end_time if end_time is not None else int(time.time())
    start_time = end_time - int(hours * 3600)
    by_time: dict[int, tuple[float, float]] = {}
    cursor = start_time
    while cursor < end_time:
        url = (
            f"{BENCHMARKS}/{cursor}/{WINDOW_SECONDS}"
            f"?ids[]={feed_id}&parsed=true"
        )
        payload = _get(url, key)
        entries = payload if isinstance(payload, list) else [payload]
        for entry in entries:
            for parsed in entry.get("parsed", []):
                price, conf, publish_time = _parse_price(parsed)
                by_time[publish_time] = (price, conf)
        cursor += WINDOW_SECONDS
        time.sleep(THROTTLE_SECONDS)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["timestamp", "price", "conf", "publish_time"])
        for publish_time in sorted(by_time):
            price, conf = by_time[publish_time]
            writer.writerow([publish_time, f"{price:.10f}", f"{conf:.10f}", publish_time])
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hours", type=float, default=1.0)
    parser.add_argument("--feed-id", default=SOL_USD_FEED)
    parser.add_argument("--out", type=Path,
                        default=Path("research/data/raw/pyth_SOLUSD_1s.csv"))
    parser.add_argument("--api-key", default=None)
    args = parser.parse_args()
    path = download(hours=args.hours, out=args.out, feed_id=args.feed_id,
                    api_key=args.api_key)
    lines = sum(1 for _ in path.open()) - 1
    print(f"wrote {lines} oracle points to {path}")


if __name__ == "__main__":
    main()
