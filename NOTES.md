# Setup session notes (2026-10-06)

Environment found (pre-installed Solana toolkit, as the human indicated):
- solana-cli 4.1.2 (Agave), cargo-build-sbf 4.1.0
- anchor-cli 1.1.2, avm 1.1.2
- rust 1.98.0, cargo 1.98.0
- node 24.10.0, npm 11.6.1, yarn 1.22.22
- python 3.12.3
- existing projects under ~/solana/ used as convention reference
  (anchor-lang 1.1.2, rust-toolchain 1.98.0, yarn, workspace layout)

Created: ~/solana/arbswap (per human instruction "create ArbSwap in cd solana").

Verified live during setup (not assumed):
- toolchain versions above (all commands run)
- anchor 1.x program conventions from the local vault example
- program keypair generated: CCR33kX4Q9iucvgN4kRga2txmtu32vxy3bXpKyxPdBQx
- Next.js latest = 16.3.8 (npm view)

Downloaded/installed this session:
- Rust: workspace + 3 crates (source files; deps minimal by design — arb-math is dependency-free)
- Python: venv + requirements.txt install (numpy/pandas/matplotlib/mpmath/pytest)
- Node: app/package.json + yarn install (next 16.3.8, react 19)
- docs/BUILD_PLAN.md copied verbatim from the human's Build Plan file

Known pending:
- Anchor program is a skeleton (initialize only) — P2 work
- golden vectors: 970 generated, Rust matches bit-for-bit (T1.2/T1.3 done)
- P1 simulator: B1-B4 + walk-forward calibration done; first E1-E4 results on
  SYNTHETIC regimes in docs/P1_RESULTS.md (T1.6). Remaining: real-data replay,
  E5 throttle ablation (B3==B4 currently), E9 sensitivity
- ladder six-level offset convention and first-depositor virtual shares are OPEN
  (docs/FORMULA.md §15)
- CI anchor job rewritten to native steps (solana 4.1.2 + anchor-cli 1.1.2 via
  cargo install + throwaway keypair + `anchor keys sync`); full sequence
  smoke-tested locally in a throwaway copy 2026-10-06 — green CI needs the
  pending commit pushed
- Pyth Hermes/Benchmarks require an API key (2026-08-26 upgrade) — working
  free key stored in .ENV (gitignored), verified 2026-10-06; history depth
  ≈75-80 days (details in research/data/README.md)

P1-P3 delivery pass (2026-10-07):
- P1 report regenerated with synthetic and sampled Binance SOLUSDT 1s replay;
  E5/E6/E9 and quote-gap/rejection metrics are included.
- P2 Anchor vault lifecycle implemented; `anchor build` and workspace tests pass.
- P3 deterministic keeper core/replay implemented; dry-run sender only.
- Production gates still open by design: Pyth CPI verification, local lifecycle
  integration test/devnet deployment, live RPC sender, and differential keeper
  parity suite.
