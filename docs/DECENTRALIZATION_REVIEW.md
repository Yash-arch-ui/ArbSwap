# DECENTRALIZATION_REVIEW.md — architecture and authorization review

Read-only architecture review conducted before S2.3 vault initialization. No
code changes, no devnet transactions. Source: `vault/program/src/lib.rs`,
`vault/keeper`, `MasterPlan.md`, `BuilderPlan.md`, `docs/THREAT_MODEL.md`,
`docs/SECURITY_CHECKLIST.md`, `docs/AUDIT_ACHIEVED_VS_PLAN.md`.

## A. Instruction-by-instruction authorization matrix

| Instruction | Caller (signer) | Exact on-chain check | Effect | Plan ref |
|---|---|---|---|---|
| `initialize_program` | **any first signer** | none (PDA `[b"program"]` `init`; sets `admin = caller`) | Claims the **global program admin** | MasterPlan §5.2 / BuilderPlan §407 |
| `initialize_vault` | signer | `program_config.admin == admin.key()` (lib.rs:42) + param validation (:46-78) | Creates the **only** vault for a mint pair; sets `vault.admin = config.admin = admin`; mints share mint | MasterPlan §5.2 `admin` |
| `deposit` | LP signer | `vault.status==ACTIVE`; user-ATA owner/mint constraints | Proportional two-token deposit; shares; warm-up ticket | MasterPlan §5.2 |
| `swap` | trader signer | `status==ACTIVE`; `min_version`, `expiry_slot`, `max_quote_size`, ladder, flow cap, breaker | Trades vs the quoted ladder | MasterPlan §5.2 |
| `request_withdraw` | LP signer | warm-up elapsed; `shares ≤ user_shares` | Queues withdrawal at `epoch+1` | MasterPlan §5.2 |
| `claim_withdraw` | LP signer | `ticket.epoch ≤ vault.epoch` | Pro-rata payout, reserves ≥ liabilities | MasterPlan §5.2 |
| `crank_epoch` | **no signer** | `now ≥ epoch_start + epoch_slots` | Advances epoch (settles queue) | "anyone" |
| `update_quote` | keeper signer | if `min_bond==0`: `keeper == config.keeper` (:445-450); else valid bond PDA with `bond−unbond ≥ min_bond` (:455-483); Pyth feed `config.pyth_feed_id` fresh/confident (:511-519); monotonic slot | Writes the two-sided ladder | MasterPlan §5.2 |
| `bond_keeper` | keeper signer | `amount>0` | Locks quote-token bond in vault-owned PDA | "open participation" |
| `unbond_keeper` | keeper signer | self; two-phase cooldown | Releases own bond after cooldown | |
| `slash_keeper` | signer | `admin == vault.admin` (:1324) | Bond → quote reserve, booked to **insurance** (never admin) | |
| `claim_keeper_reward` | keeper signer | **`keeper == config.keeper`** (:1374) | Pays only the `keeper_*` fee buckets | |
| `trip_breaker` | **no signer** | stored state only (expired/stale); no external oracle | Pauses vault | "anyone" |
| `reset_breaker` | signer | `admin == vault.admin` (:1082) | Unpauses | "admin" |
| `wind_down` | signer | `admin == vault.admin` (:1097) | Status → WIND_DOWN | |
| `set_params` / `apply_params` | signer | `admin == vault.admin` + pending admin + `TIMELOCK_SLOTS` (:1108, :1132) | Timelocked param changes; `keeper` rotatable | "governance / timelock" |
| `propose_admin`/`accept_admin`/`cancel_admin` | current admin / successor | timelocked, successor must sign (:1185-1241) | Per-vault admin rotation | M19 |
| `propose_fee_claim`/`execute_fee_claim` | signer | `admin == vault.admin`, timelocked, **fixed `config.treasury`**, protocol bucket only (:1429-1460) | Fees → treasury; **LP principal untouched** | M19 |
| Test-token mint | `8R3V…` | SPL mint authority | Devnet TEST TOKENs only | devnet-only |

`TIMELOCK_SLOTS = 216_000`; statuses `ACTIVE=0 / PAUSED=1 / WIND_DOWN=2`.

## B. Trust boundaries / centralization assumptions

- **Global root:** `program_config.admin`, set by **permissionless first-caller
  `initialize_program`**. On devnet this is `8R3V…`. This one key gates all vault
  creation and, transitively, every vault's admin.
- **Per-vault root:** `vault.admin`/`config.admin` (same key). Controls params
  (timelocked), breaker reset, wind-down, slashing, fee claims. **Cannot move LP
  principal** — fee claims go only to the fixed `config.treasury`; slashed bonds
  go to the insurance bucket.
- **Upgrade authority** `ddGs6hk5…`: can replace program code (ultimate anchor).
- **Keeper:** allowlisted (`min_bond==0`) or permissionless-but-bonded
  (`min_bond>0`). `trip_breaker`/`crank_epoch` are permissionless and state-only.
- **No admin seize path** (verified :1429-1460, :1357).

The system is a planned hybrid, **not fully decentralized**: vault creation and
emergency/param controls are admin-gated, which is what the plan specifies.

## C. Vault PDA seeds and the frontrunning consequence

Seeds `[b"vault", base_mint, quote_mint]` (:1809) make the address a pure function
of the pair → **exactly one vault per pair, forever** (`init` fails if it exists).

If `initialize_vault` were **permissionless**, the first caller to sign for a pair:

1. becomes that vault's admin and freezes all parameters (fees, `keeper`,
   `treasury`, `pyth_feed_id`, spreads, caps, utilization, ladder) at init;
2. can set a **hostile but "valid"** config (e.g. `treasury = attacker`, high fee,
   `min_bond` huge, tiny `utilization_max`, bogus feed) and then pause/wind-down;
3. **squats the only address** for that pair, so the legitimate operator can never
   deploy it; recovery needs a *different* pair (e.g. a different quote mint) — a
   permanent DoS per pair.

The current admin gate (`program_config.admin == admin`) is what prevents this.

## D. Candidate designs

| Option | How | Pros | Cons / risk |
|---|---|---|---|
| **A. Admin-created curated vaults (current)** | admin-only init | no squatting; vetted params; matches plan | launch centralization; single hot key |
| **B. Permissionless + strict param validation** | anyone inits, bounds enforced | open | **frontrunning/squatting** of the unique PDA; attacker still picks admin/keeper/treasury/feed |
| **C. Permissionless + unique pool id / config commitment** | add salt/config-hash to seeds | multiple vaults per pair; no single-address squat | program change (seeds); spam/DoS; needs param policy |
| **D. Governance-approved config + permissionless init** | registry approves a config hash; anyone inits that PDA | open init without hostile params | new approval account + program change |

## E. Recommendation (smallest defensible, plan-aligned)

**Retain Option A for the controlled devnet test and the initial production
model**, because the plan assigns `initialize_vault` to `admin` and governance to
a multisig/timelock (MasterPlan §5.2, §8.9, M19). Keep the unique-PDA-per-pair
seeds.

Production changes to reach the intended model (no code change required now):

1. Move `program_config.admin`, each `vault.admin`, and the **upgrade authority**
   to a **Squads multisig / governance** (or make the program immutable).
2. **Harden the bootstrap:** gate `initialize_program` to the upgrade authority,
   or claim it atomically with deploy, so the first-caller global-admin race
   cannot be taken by a third party.
3. **Resolve the keeper-network inconsistency:** `update_quote` is permissionless
   for any bonded keeper (`min_bond>0`) but `claim_keeper_reward` requires
   `keeper == config.keeper`; a permissionless-network keeper can quote but not be
   paid. Either route rewards per-bond-keeper or document the permissionless path
   as unpaid.
4. If **open vault creation** is desired later, adopt **C or D** — never bare
   permissionless (B) with the current seeds.

## F. Devnet-only privileges vs production prerequisites

| Privilege | Devnet (now) | Production |
|---|---|---|
| `initialize_program` first-caller admin | claimed by `8R3V…` | gate to upgrade authority / atomic deploy |
| Vault `admin` single key `8R3V…` | acceptable | multisig/governance |
| Upgrade authority `ddGs6hk5…` (single key) | acceptable | multisig or immutable |
| Test-token mint authority `8R3V…` | needed for TEST tokens | rotate/revoke before public release |
| Keeper allowlist (`min_bond=0`) | MVP demo | bonded permissionless or documented |
| `TIMELOCK_SLOTS=216,000` (~1 day) | fine | review vs governance cadence |

## G. Decision

**The existing design is consistent with ArbSwap's stated decentralization goal** —
a hybrid: admin/governance-gated **vault creation, params, and emergency
controls**, with **permissionless deposits, swaps, withdrawals, epoch cranking,
breaker-tripping, and (bonded) quoting**, and **no admin path to LP funds**. It is
**not "fully decentralized"**, and must not be described as such, because vault
creation and emergency controls are admin-gated — but that matches the plan.

**Before public release:** replace the single hot `program_config.admin`,
`vault.admin`, and upgrade authority with a multisig/governance; harden the
`initialize_program` bootstrap; resolve the reward-claim/keeper-network
inconsistency; and, only if open vault creation is later desired, add a
pool-identifier/config-commitment (C/D). **Retain for the controlled devnet test:**
admin-gated `initialize_vault`, unique-PDA-per-pair seeds, the timelock, the
pause-only/cannot-seize controls, and the permissionless user operations.
