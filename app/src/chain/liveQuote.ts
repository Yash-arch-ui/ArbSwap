// S2-36: live, non-stale quote observation.
//
// The deployed quote expires after only `Config.expiry_slots` (10 slots). The
// previous frontend refreshed the whole vault/config/reserve/quote snapshot on a
// single slow adaptive poll, so the displayed quote could be several seconds —
// and several versions — out of date, and a "Fresh" label could freeze after the
// quote had already expired. This module drives the quote on its own fast feed:
//   * it reads QuoteState at the `processed` commitment (the commitment the
//     program itself uses), one lightweight RPC per tick, and
//   * it recomputes the freshness status against the *current* slot every tick,
//     so a quote flips to Expired the moment its window passes and a newly
//     committed version appears within ~1 slot.
// The classification is pure and independently tested. It never fabricates a
// quote: a missing/undecodable account is `Unavailable`, never a stale value
// presented as executable.
import { PublicKey } from '@solana/web3.js';
import type { OnChainQuote } from './program';

export type QuoteFreshness = 'Unavailable' | 'Expired' | 'Aging' | 'Fresh';

/**
 * Classify a committed quote against a slot, mirroring `toQuoteState`:
 * `Unavailable` when there is no attributed quote; `Expired` at/after the expiry
 * slot; `Aging` inside the grace band; otherwise `Fresh`. Only `Fresh` is
 * executable.
 */
export function classifyQuoteFreshness(
  version: bigint,
  expirySlot: bigint,
  currentSlot: bigint,
  graceSlots = 0,
): QuoteFreshness {
  if (version <= 0n || expirySlot <= 0n) return 'Unavailable';
  if (currentSlot >= expirySlot) return 'Expired';
  if (graceSlots > 0 && currentSlot >= expirySlot - BigInt(graceSlots)) return 'Aging';
  return 'Fresh';
}

export interface LiveQuoteUpdate {
  /** Decoded quote, or null when the account is absent/undecodable. */
  quote: OnChainQuote | null;
  version: number;
  expirySlot: number;
  currentSlot: number;
  status: QuoteFreshness;
  /** True only when the quote is genuinely Fresh against the current slot. */
  executable: boolean;
  /** True when this update used the most recent successful read (not retained). */
  sourceOk: boolean;
  /** Quote author (keeper) when attributed, else null. */
  keeper: string | null;
}

export interface LiveQuoteFeedOptions {
  /** Current chain slot at `processed` commitment. */
  fetchSlot: () => Promise<number>;
  /** Current QuoteState at `processed` commitment, or null. */
  fetchQuote: () => Promise<OnChainQuote | null>;
  /** Grace slots from the live Config (default 0). */
  graceSlots?: () => number;
  /** Interval between ticks (ms). */
  intervalMs?: number;
  onUpdate: (u: LiveQuoteUpdate) => void;
  onError?: (e: unknown) => void;
  /** Injectable scheduler for tests; defaults to setTimeout. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

/**
 * Fast, self-rescheduling quote feed. Ticks are sequential (the next is scheduled
 * only after the previous completes), so responses can never arrive out of
 * order; an explicit monotonic-slot guard additionally ignores any tick that
 * would regress the slot. On a read failure the last decoded quote is retained
 * but its status is still recomputed against the *live* slot, so a stale quote is
 * never reported as Fresh.
 */
export class LiveQuoteFeed {
  private stopped = false;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSlot = 0;
  private last: LiveQuoteUpdate | null = null;
  private readonly opts: LiveQuoteFeedOptions;

  constructor(opts: LiveQuoteFeedOptions) {
    this.opts = opts;
  }

  /** Perform one read + classify + emit cycle. Returns the update (or null if skipped). */
  async tick(): Promise<LiveQuoteUpdate | null> {
    if (this.stopped) return null;
    let slot: number | null = null;
    let quote: OnChainQuote | null = null;
    let sourceOk = true;
    try {
      slot = await this.opts.fetchSlot();
    } catch (e) {
      sourceOk = false;
      this.opts.onError?.(e);
    }
    try {
      quote = await this.opts.fetchQuote();
      if (quote === null && sourceOk) sourceOk = false;
    } catch (e) {
      sourceOk = false;
      this.opts.onError?.(e);
    }
    // Retain the last quote when this read failed, so a transient RPC error does
    // not blank the book; the slot below still decides whether it is live.
    const effectiveQuote = quote ?? this.last?.quote ?? null;
    const currentSlot = slot ?? this.last?.currentSlot ?? 0;
    // Monotonic guard: never regress the slot (a slow/retried response).
    if (slot !== null && slot < this.lastSlot) return null;
    if (slot !== null) this.lastSlot = slot;

    const version = effectiveQuote ? BigInt(effectiveQuote.version.toString()) : 0n;
    const expirySlot = effectiveQuote ? BigInt(effectiveQuote.expirySlot.toString()) : 0n;
    const status = classifyQuoteFreshness(version, expirySlot, BigInt(currentSlot), this.opts.graceSlots?.() ?? 0);
    const keeper =
      effectiveQuote && effectiveQuote.keeper && !effectiveQuote.keeper.equals(PublicKey.default)
        ? effectiveQuote.keeper.toBase58()
        : null;
    const update: LiveQuoteUpdate = {
      quote: effectiveQuote,
      version: Number(version),
      expirySlot: Number(expirySlot),
      currentSlot,
      status,
      executable: status === 'Fresh',
      sourceOk,
      keeper,
    };
    this.last = update;
    this.opts.onUpdate(update);
    return update;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const setT = this.opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    const interval = this.opts.intervalMs ?? 700;
    const loop = async () => {
      if (this.stopped) return;
      try { await this.tick(); } catch (e) { this.opts.onError?.(e); }
      if (!this.stopped) this.timer = setT(() => void loop(), interval);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
