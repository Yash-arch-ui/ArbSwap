"""Convert a P1 price CSV into the deterministic P3 keeper replay format.

The resulting file is directly consumable by:

    cargo run -p arbswap-keeper -- replay <output.csv>

This is the explicit P1 -> P3 handoff. The P2 program consumes the instruction
hex emitted by the keeper; account addresses remain deployment-specific.
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

from research.sim.price_source import load_price_csv

Q64 = 1 << 64


def export(source: Path, destination: Path, *, base: int = 1_000, quote: int = 150_000) -> Path:
    points = load_price_csv(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["slot", "publish_time", "price_q64", "confidence_bps", "base_reserve", "quote_reserve"])
        for point in points:
            # QuoteState starts at update_slot=0; begin the replay at slot 2 so
            # the first payload satisfies P2's strict monotonic-slot guard.
            writer.writerow([(point.second + 1) * 2, point.second, int(point.price * Q64), 2, base, quote])
    return destination


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--base", type=int, default=1_000)
    parser.add_argument("--quote", type=int, default=150_000)
    args = parser.parse_args()
    path = export(args.source, args.destination, base=args.base, quote=args.quote)
    print(f"wrote keeper replay input to {path}")


if __name__ == "__main__":
    main()
