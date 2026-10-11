# WEB_ASSUMPTIONS.md — verified web libraries, endpoints and audit waivers

Every id, endpoint and version below was checked against official documentation
or the installed lockfile. Do not invent values.

## Verified libraries and endpoints

| Item | Value | Source |
|---|---|---|
| Devnet RPC | `https://api.devnet.solana.com` | Solana docs |
| Wrapped SOL mint (devnet) | `So11111111111111111111111111111111111111112` | Solana docs |
| Devnet USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Circle docs / `developers.circle.com` |
| Devnet USDC faucet | `https://faucet.circle.com` (20 USDC / address / 2 h) | Circle faucet |
| Devnet SOL faucet | `https://faucet.solana.com` | Solana faucet |
| Program id | `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` | `declare_id!` / `Anchor.toml` / IDL |
| `@solana/web3.js` | `^1.99.0` | `app/package.json` |
| `@coral-xyz/anchor` | `^0.31.1` | `app/package.json` |
| `@solana/spl-token` | `^0.4.9` | `app/package.json` |
| Wallet adapters | `@solana/wallet-adapter-phantom ^0.9.30`, `-solflare ^0.6.34` (the `-wallets` meta-package was removed) | `app/package.json` |

## Dependency audit waivers

Context: the client bundle is `app/dist/assets/index-*.js`. Reachability was
checked against the built output; `grep` alone is unreliable (e.g. `toml`
matches `borderBottomLeft`), so hits were inspected in context. The Anchor
toolchain's `toml` parser is aliased to a stub (`app/src/stubs/toml.ts`) so it
never enters the bundle.

**Verified absent from the browser bundle** (0 real occurrences in the built
output): `lodash`, `protobufjs`, `bigint-buffer`, `@stellar/*`, `@trezor/*`,
`@react-native/*`, `react-native`, `metro*`, `@solana-mobile/*`, `braces`,
`micromatch`, `toml`.

All remaining high findings are therefore **lockfile/build-time or unused-adapter
dependencies that are not shipped to the browser**. They cannot be reached from
user input in the running app.

| Package | Advisory | Severity | Prod/Dev | Bundle evidence | Why not exploitable here | Review by |
|---|---|---|---|---|---|---|
| `@coral-xyz/anchor` / `toml` | GHSA-82x6-q7mm-w9cf, GHSA-v5mp-jgw5-2x6j | high | prod | not in bundle (aliased to stub; no real hits) | Anchor CLI-only TOML parsing; the dApp parses no untrusted TOML | 2026-11-10 |
| `bigint-buffer` (via `@solana/spl-token`, `@solana/buffer-layout-utils`) | GHSA-3gc7-fjrx-p6mg | high | prod | not in bundle | `toBigIntLE` overflow path is not used by the client code path; no untrusted-length buffers | 2026-11-10 |
| `braces` / `micromatch` / `metro*` / `@react-native/*` / `react-native` / `@solana-mobile/*` | GHSA-vfj7-8cjw-p6xm (braces) | high | prod (build-time) | not in bundle, not installed (`npm ls` empty) | build-time/mobile-adapter tree, tree-shaken; no runtime path in the client | 2026-11-10 |

Policy: **do not waive anything that is both in the browser bundle and reachable
from user input.** Nothing here meets that bar.

## CI gate

`.github/workflows/ci.yml` runs `npm audit --omit=dev --audit-level=high` and
fails on any finding whose advisory id is not in `frontend/audit-allowlist.json`,
or whose `review_by` date has passed.
