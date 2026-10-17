# BROWSER_WALLET_SMOKE.md — manual single-sided wallet verification

**Status: BLOCKED — USER WALLET ACTION REQUIRED.** The agent cannot sign with a
browser wallet. Everything else is prepared; this is the one remaining gate
before `VITE_ENABLE_SINGLE_SIDED` may be turned on in a demo build.

This runbook is devnet-only and uses test tokens. Never paste a seed phrase or
private key anywhere. The agent never signs on your behalf.

## What this proves (and what the CLI smoke already proved)

- Already proved (CLI-signed, `docs/DEVNET.md` STEP 4): `deposit_single` and
  `claim_withdraw_single` execute on devnet with exact accounting for both the
  base (WSOL) and quote (USDC) directions.
- Not yet proved: the **browser wallet adapter** path — connect → simulate →
  preview → wallet prompt → submit → confirm — and the UI states around it.

## Prerequisites

- Phantom or Solflare set to **Solana Devnet**.
- Your wallet funded with devnet **WSOL** and devnet **USDC**
  (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) and ~0.05 devnet SOL for fees.
- The deployed program is `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm`; the
  active vault is `8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt`.
- A fresh quote: a keeper must be running (`scripts/devnet/demo_up.sh` or
  `keeper_live.ts`). Check with `scripts/devnet/demo_status.ts` → `FRESH`.

## Build with the flag (dev/preview only — do NOT commit this default)

```bash
VITE_ENABLE_SINGLE_SIDED=true yarn --cwd app dev
# or a local preview build:
VITE_ENABLE_SINGLE_SIDED=true yarn --cwd app build && yarn --cwd app preview
```

Confirm the Vault page shows **Deposit with: Both / Single token** and
**Receive as: Both / One token** toggles.

## Test A — single-sided deposit, WSOL in

1. Vault → **Deposit with: Single token** → token **SOL** → amount `0.001`.
2. Press **Preview single-token deposit**. Expect a simulated preview panel with
   swap portion, internal swap out, fee, price impact, expected shares and
   `min_shares`; no wallet prompt yet.
3. Press **Confirm & sign in wallet**. The wallet prompt must show:
   - Network: **Devnet**.
   - Program `2mwpYHpZ…`.
   - Fee payer: your wallet.
4. Approve. Expect a neutral **◌ Submitting…** card first, then **✓ Operation
   Confirmed** with a signature and explorer link only after confirmation.
5. Verify on-chain: your WSOL ATA decreases by exactly `0.001`; the vault base
   reserve increases by `0.001`; your USDC ATA is untouched; your share balance
   increases; the deposit ticket shows the minted shares.

## Test B — single-sided withdrawal claim, WSOL out

1. Wait out the warm-up (150 slots ≈ 37 s), then Vault → **Withdraw** → queue the
   shares (this is the normal two-sided request; the ticket is shared).
2. Wait the epoch (`epoch_slots = 1500` ≈ 6 min), then press **Crank epoch**.
3. **Receive as: One token** → token **SOL** → **Preview one-token claim** →
   **Confirm & sign in wallet**.
4. Approve. Verify: base payout > 0; USDC ATA untouched; ticket shares → 0;
   `total_shares` decreases by exactly the ticket shares.

## Test C — repeat A/B with USDC (quote) in/out

Same flow with token **USDC**; verify the mirrored deltas.

## Failure behaviour to confirm (no incorrect success)

- **Stale quote:** the single-token controls are disabled with a concrete reason;
  pressing confirm after the quote expires discards the prepared tx and shows an
  error — never a success.
- **Failed simulation:** the preview never appears; an error notice is shown; the
  wallet is never prompted.
- **Wallet rejection:** a **✕ Request Cancelled** (amber) card, not success.
- **Input change after preview:** the preview is cleared and cannot be confirmed.

## Stop / rollback

- No protocol configuration is changed by this test.
- If a deposit lands and you do not want it, recover through the normal
  withdrawal flow (request → wait epoch → crank → claim).
- If anything looks wrong, stop, disconnect, and record the signature; do not
  retry blindly.

## Record for evidence

For each step: signature, slot, the wallet's shown network, and the observed
token/share deltas. Hand the signatures back to the agent; the agent will
independently verify them against devnet before any evidence or release-status
update.
