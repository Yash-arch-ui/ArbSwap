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
- program keypair generated: E8ptkpV626P2neR8v4Q9UCFHoD6AMAH2aTRsEQiNDN3U
- Next.js latest = 16.3.8 (npm view)

Downloaded/installed this session:
- Rust: workspace + 3 crates (source files; deps minimal by design — arb-math is dependency-free)
- Python: venv + requirements.txt install (numpy/pandas/matplotlib/mpmath/pytest)
- Node: app/package.json + yarn install (next 16.3.8, react 19)
- docs/BUILD_PLAN.md copied verbatim from the human's Build Plan file

Known pending:
- Anchor program is a skeleton (initialize only) — P2 work
- golden vectors: 5 seed cases; the >=500-case set is T1.2
- CI anchor job uses a third-party action — verify before first real build
