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
