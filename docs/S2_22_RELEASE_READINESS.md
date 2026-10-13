# S2-22 — Release readiness record (local only)

Status: **local implementation + tests only. Not deployed. No transactions.**
Program `2mwpYHpZ…hyiNm` and all live accounts remain unchanged.

## 1. What this task added

- **Multi-RPC configuration + failover** for Node tooling (`scripts/devnet/rpc.ts`,
  23 local tests) and an environment-driven, cluster-guarded config for the
  frontend (`app/src/chain/rpcConfig.ts`, 5 vitest tests).
- **Read-only Devnet release preflight** (`scripts/devnet/release_preflight.ts`)
  and **keeper inspect** (`scripts/devnet/keeper_inspect.ts`).
- **Reproducible release manifest** (`scripts/devnet/release_manifest.ts` →
  `docs/release_manifest.json`).
- **Keeper dry-run** (`DRY_RUN=1`) and RPC-pool integration in `keeper_live.ts`.
- **Two-keeper end-to-end LiteSVM test** for large-jump + independent-keeper
  recovery, plus frontend quote-author attribution (`QuoteState.quoteKeeper`).

## 2. RPC failover (`scripts/devnet/rpc.ts`)

- `resolveRpcConfig(env)` reads `ARBSWAP_CLUSTER` (default `devnet`),
  `ARBSWAP_RPC_URL`/`RPC_URL` (primary) and `ARBSWAP_RPC_FALLBACKS`
  (comma-separated). A known public endpoint belonging to another cluster is a
  hard error — clusters are never mixed.
- `redactUrl` strips credentials/query before any logging.
- `classifyRpcError` distinguishes `rate_limited` / `timeout` / `http` /
  `network` from `unknown`; only transport failures are retryable.
- `backoffDelayMs` is bounded exponential backoff with jitter (injectable `rng`).
- `RpcPool.run(fn)` retries transport failures with backoff and fails over to the
  next endpoint; a non-transport (program) error is rethrown immediately — never
  masked or retried blindly. `RpcPool.assertCluster()` verifies the genesis hash.
- **Tested failure modes:** 429/rate-limit, timeout, HTTP 5xx, network
  (ECONNREFUSED), program error (not retried), failover selection, cross-cluster
  rejection, cluster-genesis mismatch, backoff bounds, URL redaction.

Transaction submission, confirmation, and post-commit verification stay distinct
(`keeper_commit.ts` + the driver), and an ambiguous signature is inspected before
any retry — the RPC layer never resubmits by itself.

**Frontend:** `resolveFrontendRpc(import.meta.env)` (`VITE_ARBSWAP_CLUSTER`,
`VITE_SOLANA_RPC_URL`, `VITE_SOLANA_RPC_FALLBACKS`) with the same cluster guard;
`SOLANA_DEVNET_RPC`/`SOLANA_RPC_FALLBACKS` are derived. Limitation: the browser
uses the primary endpoint; the full multi-endpoint `RpcPool` is implemented in the
Node tooling, not a browser `Connection` wrapper. This is availability-only and
documented honestly.

## 3. Two-keeper LiteSVM results (`vault/program/tests/litesvm_lifecycle.rs`)

Executed against the real local program (SBF artifact) and account constraints:

- `two_independent_keepers_stage_without_interference` — A and B stage into
  distinct per-keeper pending PDAs; staging does not commit.
- `keeper_attribution_is_isolated_across_two_keepers` — A's swap share accrues to
  A's `KeeperReward` PDA; B has no entitlement; B authoring the next quote accrues
  to B without moving A's accrual; aggregate == A + B.
- `independent_keeper_recovers_expired_quote_after_large_jump` — a ~10% jump is
  rejected `AnchorStepTooLarge` while fresh; after expiry, independent keeper B
  recovers it under the S2-18 rules and is attributed as the new author.
- `commit_rejects_expired_and_foreign_staging` — expired staging rejected
  (`StalePendingQuote`); a foreign keeper cannot commit another keeper's pending.
- 9 migration tests (S2-21A) + `UnattributedQuote` blocking for legacy quotes.
- Invalid cases (stale/wrong-feed/low-confidence/invalid-ladder/replayed/
  non-monotonic) are covered across `litesvm_recovery.rs`, `litesvm_oracle_scaling.rs`
  and the lifecycle suite and do not bypass on-chain checks.

## 4. Deployment / migration preflight

`release_preflight.ts` (read-only, exits non-zero on any finding) validates:
cluster + genesis; program account and **upgrade authority**; `QuoteState`
owner/discriminator/PDA/length (legacy vs current); rent shortfall; payer balance;
local artifact and IDL presence; IDL contains `migrate_quote_state`.

Live run (read-only) against Devnet returned `ok: true`:
`QuoteState` legacy **865 B**, `migration_required: true`, rent shortfall
162,560 lamports, payer funded, artifact sha256 `b4df2b0f…`, IDL has the migration
instruction. No transaction was sent.

`keeper_inspect.ts` prints the live quote (version/expiry/keeper/attributed state),
config (`min_bond`, configured keeper, feed), vault status, and the eligibility
rule — read-only.

## 5. Reproducible build / artifact / IDL

`release_manifest.ts` writes `docs/release_manifest.json` (no secrets) with the
source commit, program id, toolchain versions, build command, `.so` size + sha256,
IDL size + sha256, account layouts (865/897, disc `beffae2c13d7259c`), the required
migration, expected post-deploy checks, and the test commands. The manifest is
generated from the exact local artifact, so a different artifact cannot be
mistaken for the one that passed tests.

## 6. Preserved mathematics

`git diff` shows no changes to `price_from_sqrt`, normalization, swap
input/output/rounding, share minting, reserves/NAV, fee bps/splits, ladder/
inventory/capacity, or oracle verification. `vault/math/tests/liveness_regression.rs`
and the full accounting suites pass unchanged; no golden value was edited.

## 7. Governance centralization (review only — no change)

| Control | Holder | Timelock | Still centralizing? |
|---|---|---|---|
| Upgrade authority | `ddGs6hk5…` (single key) | none | **Yes** — move to a multisig before real funds |
| `set_params`/`apply_params` | admin `8R3V…` | 216 000 slots | Yes (governance) — **keeper eligibility is now immutable** |
| `reset_breaker` | admin | none | Yes (emergency) |
| `wind_down` | admin | none | Yes (emergency); withdrawals unaffected |
| `slash_keeper` | admin | none | Yes — discretionary; no objective criteria |
| Fee claims | admin | 216 000 slots | Yes (governance) |
| Admin rotation | admin → successor | 216 000 slots | Yes |
| `initialize_program` | first caller | none | Claim-once |

Routine quote maintenance/recovery is **permissionless** (`min_bond==0`) and needs
no administrator. Remaining admin dependencies are genuine governance/emergency
controls (upgrade, params, breaker reset, wind-down, slashing, fee claims). The
protocol is **not fully decentralized** while the upgrade authority is a single key
and slashing is discretionary; reducing that requires a multisig + on-chain
slashing criteria (separately authorised).

## 8. Commands

```bash
# deterministic local tests
cargo test --workspace
(cd scripts/devnet && npx tsx rpc.test.ts && npx tsx keeper_commit.test.ts)
(cd app && yarn test && yarn lint && yarn build)
.venv/bin/python -m pytest simulation/analytics/tests -q

# read-only live inspection
(cd scripts/devnet && npx tsx keeper_inspect.ts)
(cd scripts/devnet && npx tsx release_preflight.ts)

# keeper dry-run (builds + size-checks, never sends)
(cd scripts/devnet && DRY_RUN=1 ARBSWAP_CLUSTER=devnet npx tsx keeper_live.ts)

# reproducible manifest
(cd scripts/devnet && npx tsx release_manifest.ts)
```

## 9. Remaining steps for the authorised Devnet release

1. Deploy the upgraded program (upgrade authority; no config/authority change).
2. Run `release_preflight.ts` → expect `quote_state.layout == current` only after
   migration; first run the migration: `migrate_quote_state(payer, vault, quote_state)`
   once (865 → 897; permissionless). Verify 897 B + `keeper == default`.
3. Independent keeper commits a fresh quote (permissionless) → `keeper` set → a
   swap credits that keeper's `KeeperReward` PDA.
4. Run the two-independent-keeper failure-injection test on Devnet (outage, stale
   quote, large jump, recovery).
5. (Governance, separately) move the upgrade authority to a multisig.

## 10. Known limitations

- Oracle freshness (2 s) remains provider-sensitive on a single public RPC.
- Frontend multi-endpoint failover is config/guard only (browser path uses the
  primary); the Node tooling has the full pool.
- Single-key upgrade authority and discretionary slashing remain.

---

## S2-23 executed on Devnet (verified)

- **Upgrade:** sig `5ub1Su7Z…`, finalized; deployed ELF sha256 `b4df2b0f…` **MATCH**.
- **Migration:** sig `qmTocoCx…`; QuoteState 865 → **897**, keeper sentinel `1111…`, version/expiry preserved.
- **Fresh quote:** push+commit `4ABgziXU…`; QuoteState **v19**, author `8R3V…` (correct), conf 9 bps.
- **Keeper robustness fixes (local, uncommitted):** inspect a signature before treating a confirm timeout as failure; fetch a fresh blockhash for the push tx.
- **Second keeper live:** blocked by market confidence at the deployed cap + intermittent Devnet RPC connect timeouts; semantics proven in LiteSVM.
