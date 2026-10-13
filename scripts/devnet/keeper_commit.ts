// S2-18: pure, locally testable keeper commit-result classification.
//
// The live keeper must never infer success from "a process returned", from a
// nonzero *existing* QuoteState version, or from a missing `getTransaction`
// response. Success is only ever a confirmed, successful transaction whose
// resulting QuoteState version strictly advanced into a still-live quote.

export type CommitState =
  | 'SUBMITTED' // a signature exists but we could not yet observe/confirm it
  | 'CONFIRMED' // observed and executed without error, but state not verified
  | 'FAILED' // observed and executed with an error, or no signature at all
  | 'UNOBSERVED' // getTransaction could not retrieve the tx; inspect first
  | 'COMMITTED_AND_VERIFIED'; // confirmed + version advanced + quote live

export interface CommitObservation {
  /** Signature returned by sendTransaction, or null if submission never yielded one. */
  signature: string | null;
  /** Whether `getTransaction` returned a non-null response. */
  txFound: boolean;
  /** `meta.err` of the retrieved transaction (null/undefined = success). */
  txErr: unknown;
  /** QuoteState version read *before* the attempt. */
  prevVersion: bigint;
  /** QuoteState version read *after* the attempt, or null if the read failed. */
  newVersion: bigint | null;
  /** Current processed slot, or null if the read failed. */
  currentSlot: bigint | null;
  /** QuoteState expiry slot, or null if the read failed. */
  expirySlot: bigint | null;
}

export interface CommitClassification {
  state: CommitState;
  reason: string;
}

export function classifyCommit(o: CommitObservation): CommitClassification {
  if (!o.signature) {
    return { state: 'FAILED', reason: 'no transaction signature was obtained' };
  }
  if (!o.txFound) {
    // Ambiguous: the tx may be dropped, delayed, or simply not indexed yet.
    // Never treat this as success or as a clean failure — inspect on-chain.
    return { state: 'UNOBSERVED', reason: 'getTransaction returned no response; inspect the signature before retrying' };
  }
  if (o.txErr != null) {
    return { state: 'FAILED', reason: `transaction executed with error: ${JSON.stringify(o.txErr)}` };
  }
  if (o.newVersion === null || o.currentSlot === null || o.expirySlot === null) {
    return { state: 'CONFIRMED', reason: 'confirmed without error but QuoteState was not read; not verified' };
  }
  if (o.newVersion <= o.prevVersion) {
    return {
      state: 'CONFIRMED',
      reason: `confirmed but QuoteState.version did not advance (${o.prevVersion} -> ${o.newVersion})`,
    };
  }
  if (o.currentSlot >= o.expirySlot) {
    return {
      state: 'CONFIRMED',
      reason: `confirmed and version advanced (${o.prevVersion} -> ${o.newVersion}) but the quote is already expired at slot ${o.currentSlot}`,
    };
  }
  return {
    state: 'COMMITTED_AND_VERIFIED',
    reason: `version ${o.prevVersion} -> ${o.newVersion}, fresh until expiry slot ${o.expirySlot}`,
  };
}

export function isSuccess(state: CommitState): boolean {
  return state === 'COMMITTED_AND_VERIFIED';
}

/** Exponential backoff for transient providers, bounded by `capMs`. */
export function backoffDelayMs(attempt: number, baseMs = 500, capMs = 8_000): number {
  const exp = Math.max(0, attempt - 1);
  return Math.min(capMs, baseMs * 2 ** exp);
}
