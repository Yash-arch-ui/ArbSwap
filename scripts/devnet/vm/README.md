# scripts/devnet/vm — supervised keeper

Files for running the quote keeper as a long-lived, single-instance service on a
VM. Nothing here contains secrets: the RPC URL, API key and keypair paths come
from the gitignored `.env` (loaded by `EnvironmentFile`) or `$HOME`.

## Option A — tmux (simplest)

```bash
scripts/devnet/demo_up.sh 600          # keeper under tmux 'arbswap-keeper', flock-guarded
scripts/devnet/demo_check.sh           # fresh/expired, version, author, seconds to expiry, keeper SOL
scripts/devnet/measure_fresh.sh 1200 400   # 20 min, 400 ms monitor
tmux attach -t arbswap-keeper          # live status (Ctrl-b d to detach)
```

## Option B — systemd

1. Copy the repo to `/opt/arbswap` (or edit the paths in the unit).
2. `sudo cp scripts/devnet/vm/arbswap-keeper.service /etc/systemd/system/`
3. `sudo systemctl daemon-reload && sudo systemctl enable --now arbswap-keeper`
4. `systemctl status arbswap-keeper` / `journalctl -u arbswap-keeper -f`

`keeper_loop.sh` holds an exclusive `flock`, restarts a failed invocation with
backoff, and exits non-zero after `MAX_CONSECUTIVE_FAILURES` so the supervisor
decides. Success is a strictly advanced `QuoteState.version` with the expected
`QuoteState.keeper`, reread from chain — never the process return value.

## Independent keeper key

A non-privileged keypair (not the admin, not the upgrade authority) can author
quotes when `Config.min_bond == 0` and it bonds if required. Set
`ARBSWAP_KEYPAIR` to its path. Attribution is on-chain (`QuoteState.keeper`).

## Redaction

Never print the RPC URL. Every script uses `redactUrl`/`redacted` output; the
`api-key=` query parameter is stripped from all logs.
