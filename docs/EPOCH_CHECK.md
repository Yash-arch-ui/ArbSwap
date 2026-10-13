# EPOCH_CHECK.md — Devnet epoch / claim-timing analysis (read-only)

No secrets. No transactions submitted. Values read from the deployed program at
slot ~510719463 (Devnet).

## A1. Live values

| Parameter | Value | Source |
|---|---|---|
| `warmup_slots` | 150 | Config @152 |
| `epoch_slots` | 1500 | Config @160 |
| `grace_slots` | 2 | Config @168 |
| `expiry_slots` | 10 | Config @176 |
| `max_staleness_seconds` | 2 | Config @184 |
| `vault.epoch` | 0 | Vault @288 |
| `vault.epoch_start` | 510190432 | Vault @296 |
| slots since epoch_start | 529031 | now − epoch_start |
| `PendingConfig` | absent | PDA `[b"pending", vault]` |
| `TIMELOCK_SLOTS` | 216 000 | `vault/program/src/lib.rs:20` |
| **seconds/slot** | **0.25 s** | 11 recent `getBlockTime` samples (do not assume 400 ms) |

## A2. Earliest claim time (formulas)

Program logic:
- `request_withdraw`: `ticket.epoch = vault.epoch + 1` (`lib.rs:315-320`);
  requires `slot >= deposit_ticket.activate_slot` (warm-up, `lib.rs:307-310`).
- `crank_epoch`: requires `now >= epoch_start + epoch_slots` (`lib.rs:330-340`),
  then `vault.epoch += 1`, `epoch_start = now`.
- `claim_withdraw`: requires `ticket.epoch <= vault.epoch` (`lib.rs:351-355`).

**Withdrawal requested now** (`vault.epoch = 0` → `ticket.epoch = 1`):
- Crank eligibility: `now >= 510190432 + 1500 = 510191932`; current 510719463 ≥
  that → **already eligible**.
- One `crank_epoch` → `vault.epoch = 1`; then `ticket.epoch (1) <= 1` → claimable.
- **Earliest claim ≈ immediate** (one crank; bounded only by transaction time).
  In slots: effectively 0.

**Withdrawal requested after the next crank** (`vault.epoch = 1` → `ticket.epoch = 2`):
- Needs a second crank, eligible at `epoch_start(=crank time) + 1500` slots.
- At 0.25 s/slot → **1500 × 0.25 = 375 s ≈ 6.25 min**.

**Existing deposit ticket warm-up:** `activate_slot = 510405706` (S2-14 deposit),
`now = 510719463` → warm-up elapsed.

Conclusion: the earliest claim for a withdrawal requested now is **≈ immediate**,
well under 15 minutes.

## A3. What `set_params` can change (and bounds)

`ParamsUpdate` (`vault/program/src/lib.rs:1747+`) contains: `fee_bps`,
`insurance_bps`, `keeper_bps`, `protocol_bps`, `max_staleness_seconds` (line 1911),
`max_conf_bps`, `max_anchor_step_bps`, `max_spread_step_bps`, `min_spread_bps`,
`max_spread_bps`, `max_quote_size`, `max_inventory_bps`, `utilization_max_bps`,
`unbond_cooldown_slots`, `max_update_slot_age`, `edge_window_slots`,
`max_edge_loss_bps`, `max_anchor_dev_bps`, `flow_window_slots`,
`max_window_flow_bps`.

- **`epoch_slots` is NOT in `ParamsUpdate`.** It is set only in
  `initialize_vault` (`lib.rs:116`, from `InitParams` line 2050). It is therefore
  **immutable** after initialization; `set_params`/`apply_params` cannot change it.
- `set_params` (`lib.rs:986`) validates only the fee-bps sum; it writes
  `pending.activate_slot = now + TIMELOCK_SLOTS` and stores the params.
- `apply_params` (`lib.rs:1010`) requires `now >= activate_slot` and re-validates
  `min_spread_bps <= max_spread_bps` and `utilization_max_bps <= 8_000`, then copies
  the fields (including `config.max_staleness_seconds = update.max_staleness_seconds;`
  at `lib.rs:1138`).
- **`max_staleness_seconds` IS changeable** via `set_params` → `apply_params`
  (`lib.rs:1911` field, `lib.rs:1138` applied), after the timelock.
- Timelock: `TIMELOCK_SLOTS = 216 000` (`lib.rs:20`); at 0.25 s/slot ≈ **54 000 s ≈
  15 h** (at 400 ms it would be ~24 h).

## A4. Epoch proposal — NOT required, and NOT possible

The A4 trigger ("earliest claim time exceeds about 15 minutes") is **not met**: the
earliest claim is ≈ immediate (one overdue crank). Therefore no `set_params`
proposal is built.

Additionally, even if it were needed, a proposal setting `epoch_slots` to 1 500 is
**impossible through the deployed interface**: `epoch_slots` is not part of
`ParamsUpdate` and is immutable after init. Changing it would require a program
change and redeploy, which this task prohibits. `max_staleness_seconds` is
changeable but **must not** be changed here (hard rule 2).

No transaction was built, simulated, or submitted. No protocol parameter was
changed.
