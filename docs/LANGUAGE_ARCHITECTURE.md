# ArbSwap Language Architecture

This file stores the Python-versus-Rust architecture represented in the
project diagrams. The former `tq-math` name in the diagrams is now
`arb-math` after the TruQuote to ArbSwap rename.

## Python: What It Is Used For

| Component | Why Python |
|---|---|
| High-precision reference model | Independent `decimal`/`mpmath` implementation used to check Rust integer math. If both implementations came from the same code, the check would prove nothing. |
| Golden test vectors | Generates deterministic input-output files, including rounding edge cases, that Rust must match. |
| Data download and cleaning | Handles CEX reference prices, Pyth history, and future Solana swap datasets. |
| Research notebooks/scripts | Walk-forward calibration, sensitivity analysis, and regime studies. |
| Metrics and charts | Markouts, hedged PnL, quiet-flow splits, quote gaps, and demo charts. |
| Prototype simulator | Fast event-driven research implementation; only performance-critical loops move to Rust. |

## Rust: What It Is Used For

| Component | Why Rust |
|---|---|
| On-chain program (Anchor) | Solana programs are written in Rust; custody and validation must be deterministic and audited. |
| `arb-math` crate | Production core for ladder walking, fees, shares, rounding, and checked integer arithmetic. It is testable without Solana. |
| Keeper bot | Fast, reliable, continuously running, and uses the production Rust math path. |
| Simulator inner loop (optional) | Replays large 1-second datasets with production math when Python becomes too slow. |
| Attacker bots (optional) | Adversarial programs and clients interacting with the program and keeper. |
| Fuzz and property tests | Rust-based fuzzing/property tooling exercises the program and production math. |
| Indexer (optional) | Rust is acceptable for event ingestion, but it is not required by the product architecture. |

## Pipeline Contract

```text
P1 Python data/reference/simulator
        |
        | P1 price CSV: timestamp_ms, price
        v
P3 Rust keeper -> checked decimal/Q64 conversion -> arb-math -> Anchor/Borsh update_quote payload
                                      |
                                      v
P2 ArbSwap program -> on-chain bounds, expiry, ladder walk, custody
```

The Python implementation remains independent and is the research oracle. The
Rust `arb-math` implementation is the production path. P1 golden vectors are
the bridge between them; the keeper's emitted instruction payload is the bridge
between P3 and P2.
