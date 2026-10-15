// S2-42: stale encoded-VAA reclamation (pure + injectable so it is unit-testable).
//
// Every Pyth push creates a Wormhole `EncodedVaa` account (338 bytes ~= 0.002367
// SOL rent). The Pyth push oracle closes it on a *successful* update, but a
// failed `push+commit` leaves the account orphaned and the rent locked. This
// module selects which keeper-owned encoded-VAA accounts may be closed:
//
//   * only addresses reported as owned by the keeper's write authority
//     (`findOwnedEncodedVaaAccounts` / `findEncodedVaaAccountsByWriteAuthority`);
//   * never an address a transaction may still need (the `active` set);
//   * never one first observed less than `graceMs` ago, where grace >= the
//     maximum Solana transaction lifetime, so a slow or ambiguous in-flight
//     push can never race the close.
//
// The selection is pure; the RPC-dependent find/close calls are injected.

/** Rent-exempt lamports a 338-byte Wormhole EncodedVaa account holds. */
export const ENCODED_VAA_RENT_LAMPORTS = 2_367_280;

export interface ReclaimSelectInput {
  /** Addresses reported as owned by the keeper's write authority. */
  owned: string[];
  /** address -> ms timestamp first observed by this keeper process. */
  firstSeenMs: Map<string, number>;
  nowMs: number;
  /** Minimum age before an account may be closed (>= max tx lifetime). */
  graceMs: number;
  /** Addresses a transaction may still need; never closed. */
  active: Set<string>;
}

/**
 * Pure selection of reclaimable accounts. `firstSeenMs` must already contain an
 * entry for every owned address the caller wants eligible (the caller seeds new
 * addresses with `nowMs`); unknown addresses are skipped.
 */
export function selectReclaimable(input: ReclaimSelectInput): string[] {
  const out: string[] = [];
  for (const address of input.owned) {
    if (input.active.has(address)) continue;
    const seen = input.firstSeenMs.get(address);
    if (seen === undefined) continue;
    if (input.nowMs - seen >= input.graceMs) out.push(address);
  }
  return out;
}

export interface ReclaimDeps {
  /** Keeper-owned encoded-VAA addresses (already ownership-filtered by the SDK). */
  findOwned: () => Promise<string[]>;
  /**
   * Close the given accounts (batched); must not throw for partial failures —
   * return which addresses closed and which failed. May throw only on a total
   * failure (treated as all-failed).
   */
  closeAccounts: (addresses: string[]) => Promise<{ closed: string[]; failed: string[] }>;
  firstSeenMs: Map<string, number>;
  active: Set<string>;
  nowMs: () => number;
  graceMs: number;
  /** Maximum accounts closed in one pass (bounds RPC/fees per cycle). */
  maxPerPass?: number;
  rentPerAccountLamports?: number;
  log?: (message: string) => void;
}

export interface ReclaimResult {
  owned: number;
  attempted: number;
  closed: number;
  failed: number;
  rentRecoveredLamports: number;
}

/**
 * Best-effort stale-VAA reclaim. Never throws: a discovery or close failure is
 * logged and counted so the keeper loop is unaffected. Newly observed accounts
 * are seeded with `nowMs` on first sight, so nothing is closed before it has
 * been observed (and untouched) for at least `graceMs`.
 */
export async function reclaimStaleVaas(deps: ReclaimDeps): Promise<ReclaimResult> {
  const log = deps.log ?? (() => undefined);
  const rent = deps.rentPerAccountLamports ?? ENCODED_VAA_RENT_LAMPORTS;
  let owned: string[];
  try {
    owned = await deps.findOwned();
  } catch (e) {
    log(`reclaim: discovery failed: ${String((e as Error).message ?? e)}`);
    return { owned: 0, attempted: 0, closed: 0, failed: 0, rentRecoveredLamports: 0 };
  }
  const now = deps.nowMs();
  for (const address of owned) {
    if (!deps.firstSeenMs.has(address)) deps.firstSeenMs.set(address, now);
  }
  const reclaimable = selectReclaimable({
    owned,
    firstSeenMs: deps.firstSeenMs,
    nowMs: now,
    graceMs: deps.graceMs,
    active: deps.active,
  }).slice(0, Math.max(0, deps.maxPerPass ?? 20));
  let closed = 0;
  let failed = 0;
  if (reclaimable.length > 0) {
    try {
      const res = await deps.closeAccounts(reclaimable);
      for (const address of res.closed) {
        deps.firstSeenMs.delete(address);
        closed += 1;
      }
      failed = res.failed.length;
      for (const address of res.failed) log(`reclaim: close ${address} failed`);
    } catch (e) {
      failed = reclaimable.length;
      log(`reclaim: batch close failed: ${String((e as Error).message ?? e)}`);
    }
  }
  return {
    owned: owned.length,
    attempted: reclaimable.length,
    closed,
    failed,
    rentRecoveredLamports: closed * rent,
  };
}
