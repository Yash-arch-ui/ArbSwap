/**
 * Pure swap-availability gate. Swaps must fail closed: no vault, paused vault,
 * or no fresh on-chain quote => a concrete reason and no submission. The reason
 * text is surfaced directly in the UI.
 */
export interface SwapGateInput {
  vaultInitialized: boolean;
  circuitBreakerTripped: boolean;
  quoteAvailable: boolean;
}

export function swapUnavailableReason(input: SwapGateInput): string | null {
  if (!input.vaultInitialized) {
    return 'Swaps unavailable: the vault is not initialized.';
  }
  if (input.circuitBreakerTripped) {
    return 'Swaps unavailable: the vault is paused by the circuit breaker.';
  }
  if (!input.quoteAvailable) {
    return 'Swaps unavailable: no fresh Pyth quote. The oracle must meet the deployed 2-second freshness requirement.';
  }
  return null;
}

/** Mirror of the deployed `claim_withdraw` precondition: `ticket.epoch <= vault.epoch`. */
export interface ClaimGateInput {
  walletConnected: boolean;
  hasTicket: boolean;
  ticketEpoch: number;
  vaultEpoch: number;
  ticketShares: bigint;
}

export function claimWithdrawState(input: ClaimGateInput): { allowed: boolean; reason: string } {
  if (!input.walletConnected) return { allowed: false, reason: 'Connect a wallet to manage withdrawals.' };
  if (!input.hasTicket) return { allowed: false, reason: 'No withdrawal ticket for this wallet.' };
  if (input.ticketShares <= 0n) return { allowed: false, reason: 'This withdrawal has already been claimed.' };
  if (input.ticketEpoch > input.vaultEpoch) {
    return {
      allowed: false,
      reason: `Withdrawal settles in epoch ${input.ticketEpoch}; the vault is at epoch ${input.vaultEpoch}. An epoch crank is required first.`,
    };
  }
  return { allowed: true, reason: `Ready to claim (epoch ${input.ticketEpoch} reached).` };
}
