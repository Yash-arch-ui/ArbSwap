/**
 * Pure swap-availability gate. Swaps must fail closed: an explicit disabled
 * mode, an unverified cluster, no vault, a paused vault, or no fresh on-chain
 * quote => a concrete reason and no submission. The reason text is surfaced
 * directly in the UI. There is no blanket "integration mode" blocker: the mode
 * is one explicit input among the protocol's real safety checks.
 */
import { isTransportError, type SourceError, type SourceState } from './dataState';
import type { QuoteState } from '../types/protocol';

export interface SwapGateInput {
  /** True when this build is permitted to submit (trade mode on Devnet). */
  transactionsEnabled: boolean;
  /** Explicit reason transactions are disabled (read-only mode / wrong cluster). */
  transactionDisabledReason: string | null;
  /** Devnet genesis hash verified against the connected RPC. */
  genesisVerified: boolean;
  vaultInitialized: boolean;
  circuitBreakerTripped: boolean;
  quoteAvailable: boolean;
}

export function swapUnavailableReason(input: SwapGateInput): string | null {
  if (!input.transactionsEnabled) {
    return input.transactionDisabledReason ?? 'Transactions are disabled in this build.';
  }
  if (!input.genesisVerified) {
    return 'Swaps unavailable: the RPC endpoint could not be verified as Devnet. Refusing to submit against an unverified cluster.';
  }
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

/**
 * S2-36: state-aware gate. It distinguishes a transport failure (HTTP 429 /
 * timeout / network) from an authoritative "vault absent", and never calls a
 * failed read an uninitialized vault.
 */
export interface LiveSwapGateInput {
  vaultState: SourceState;
  vaultExists: boolean | null;
  errorKind: SourceError | null;
  /** Devnet genesis hash verified against the connected RPC before submission. */
  genesisVerified: boolean;
  circuitBreakerTripped: boolean;
  quoteAvailable: boolean;
  quoteStatus: QuoteState['status'];
}

export function liveSwapGateReason(input: LiveSwapGateInput): string | null {
  if (input.vaultState === 'loading') {
    return 'Reading live vault and quote state from Devnet…';
  }
  if (isTransportError(input.errorKind)) {
    const label = input.errorKind === 'rate_limited'
      ? 'Devnet RPC is rate-limiting requests (HTTP 429).'
      : 'The Devnet RPC read failed.';
    return `Swaps unavailable: ${label} Live vault and quote data could not be refreshed. Trading remains unavailable until the data read succeeds.`;
  }
  if (input.vaultState === 'invalid') {
    return 'Swaps unavailable: the vault account failed validation (owner/layout mismatch).';
  }
  if (input.vaultExists === false) {
    return 'Swaps unavailable: no vault is initialized for this pair on this cluster.';
  }
  if (input.vaultState === 'stale') {
    return `Swaps unavailable: showing last-known data (${input.quoteStatus === 'Expired' ? 'quote expired' : 'not fresh'}); a successful live read is required.`;
  }
  // Fail closed against an unknown/mismatched cluster: never submit because the
  // env *says* devnet — require the genesis hash to have been verified.
  if (!input.genesisVerified) {
    return 'Swaps unavailable: the RPC endpoint could not be verified as Devnet. Refusing to submit against an unverified cluster.';
  }
  if (input.circuitBreakerTripped) {
    return 'Swaps unavailable: the vault is paused by the circuit breaker.';
  }
  if (!input.quoteAvailable) {
    if (input.quoteStatus === 'Expired') return 'Swaps unavailable: the on-chain quote is expired.';
    if (input.quoteStatus === 'Aging') return 'Swaps unavailable: the on-chain quote is aging (not fresh).';
    return 'Swaps unavailable: no fresh on-chain quote is available.';
  }
  return null;
}

/**
 * S2-35: submission-time freshness gate. The polled UI state can be up to one
 * poll interval older than the live account, and the deployed quote expires
 * after only `Config.expiry_slots` (read live from chain). Immediately before
 * building a swap the quote is
 * re-read; this turns that re-read into a user-facing reason (or null to
 * proceed). It mirrors the deployed `swap` checks: `version > 0` (attributed,
 * never a migrated placeholder) and `current_slot < expiry_slot`, so the client
 * refuses exactly what the program would reject — and never reports success.
 */
export function submitFreshnessReason(
  fresh: { fresh: boolean; version: bigint; currentSlot: bigint; expirySlot: bigint } | null,
): string | null {
  if (!fresh) {
    return 'Swaps unavailable: the on-chain quote could not be re-read at submission time. The swap was not submitted.';
  }
  if (fresh.version <= 0n) {
    return 'Swaps unavailable: no attributed on-chain quote exists for this vault.';
  }
  if (!fresh.fresh) {
    return `Swaps unavailable: the on-chain quote expired (expiry slot ${fresh.expirySlot}, current slot ${fresh.currentSlot}). The keeper has not committed a fresh quote.`;
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
