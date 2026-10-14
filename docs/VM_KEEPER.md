# VM_KEEPER.md — running the quote keeper as a service

Devnet only. The keeper stages Pyth updates and commits `QuoteState`; it never
swaps, deposits, withdraws, claims or transfers. No secrets are stored in this
document or in `scripts/devnet/vm/` — the RPC URL and Pyth token live in the
gitignored `.env`; keypair paths live under `$HOME`.

## Prerequisites

- A funded Devnet keeper keypair (SOL for fees). The configured operator is
  `8R3V…` (`$HOME/.config/solana/id.json`); an independent non-privileged keeper
  may be used when `Config.min_bond == 0` (attribution is on-chain via
  `QuoteState.keeper`).
- `.env` with `ARBSWAP_RPC_URL` and `PYTH_API_KEY` (see `docs/INTEGRATION.md`).
- `npx tsx` available in `scripts/devnet`.

## Read-only preflight before starting

```bash
scripts/devnet/demo_check.sh        # one-shot: fresh/expired, version, author, seconds, keeper SOL, RPC latency
npx tsx preflight.ts                # cluster/program hash/vault/config/quote
```

## Start / supervise

- tmux: `scripts/devnet/demo_up.sh 600` (session `arbswap-keeper`, flock-guarded).
- systemd: `scripts/devnet/vm/arbswap-keeper.service` (see `scripts/devnet/vm/README.md`).
- bounded loop: `scripts/devnet/keeper_loop.sh "$ARBSWAP_RPC_URL" 600`.

`keeper_loop.sh` uses an exclusive `flock`, bounded restarts with backoff, and
exits non-zero after `MAX_CONSECUTIVE_FAILURES`. Success is decided by a strictly
advanced `QuoteState.version` and the expected author, reread from chain.

## Freshness monitor

```bash
scripts/devnet/measure_fresh.sh 1200 400   # 20 min, 400 ms sampling
```

Reports the fresh fraction (share of samples with `current_slot < expiry_slot`),
the longest stale gap, commits observed, and a mechanical decision rule
(≥80 % green, 50–80 % amber, <50 % red).

## Redaction

Never print the RPC URL: all tools use `redactUrl` (strips `api-key=`). Logs go to
the gitignored `logs/` directory.
