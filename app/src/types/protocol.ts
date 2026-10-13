/**
 * ArbSwap Core Types & Interfaces
 * Derived directly from the TruQuote / ArbSwap Build Plan & Specification
 */

export interface Token {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  logo: string;
  balance: number;
  priceUsd: number;
}

export interface QuoteLevel {
  level: number;
  offsetBps: number;
  weightBps: number;
  capacityUsd: number;
  bidPrice: number;
  askPrice: number;
}

/**
 * Raw ladder segment exactly as committed on-chain, for integer-exact output
 * math (`walk_ladder`). Kept as decimal strings so state stays serializable;
 * converted to `bigint` only inside the pure swap-math helpers.
 */
export interface RawLevel {
  offsetBps: number;
  weightBps: number;
  sqrtLo: string;
  sqrtHi: string;
  liquidity: string;
}

export interface QuoteState {
  /** True only when a committed quote account was actually read on-chain. */
  hasQuote: boolean;
  version: number;
  updateSlot: number;
  currentSlot: number;
  expirySlot: number;
  oraclePrice: number;
  anchorSqrtPrice: string;
  /** Raw Q64.64 reservation sqrt price (string), for integer swap math. */
  pResSqrt: string;
  reservationPrice: number;
  halfSpreadBps: number;
  askExtraBps: number;
  bidExtraBps: number;
  depthMultBps: number;
  flowNetSold: number; // in SOL
  oraclePublishTime: number; // Unix timestamp
  oracleConfBps: number;
  /** S2-19/S2-22: the keeper that authored the committed quote, or null when the
   * quote is unattributed (legacy/migrated). Never the configured operator. */
  quoteKeeper: string | null;
  shortVolBps: number; // sigma_s
  mediumVolBps: number; // sigma_m
  recentMoveBps: number;
  levels: QuoteLevel[];
  /** Raw ask/bid ladder segments from the committed quote (integer math). */
  askLevelsRaw: RawLevel[];
  bidLevelsRaw: RawLevel[];
  /**
   * `Unavailable` = no quote account read at all (never zero-fill this as a
   * numeric price); `Expired` = a real quote exists but its slot window passed.
   */
  status: 'Fresh' | 'Aging' | 'Expired' | 'Unavailable';
}

export interface VaultState {
  tvlUsd: number;
  baseReserve: number; // SOL
  quoteReserve: number; // USDC
  totalShares: number;
  userShares: number;
  userBaseEquivalent: number;
  userQuoteEquivalent: number;
  sharePriceUsd: number;
  inventoryImbalanceQ: number; // [-1, 1]
  targetRatio: number; // 0.50
  currentRatio: number;
  feeApy: number; // annualized
  lvrAvoided7dUsd: number;
  netHedgedApy: number; // annualized alpha (model)
  epoch: number;
  epochSlotsRemaining: number;
  status: 'Active' | 'Paused' | 'WindDown';
  insuranceBufferUsd: number;
  keeperPoolUsd: number;
  protocolFeesUsd: number;
  warmupSlots: number;
}

export interface SwapExecutionEstimate {
  inAmount: number;
  inToken: Token;
  outToken: Token;
  outAmount: number;
  effectiveRate: number; // USDC per SOL
  spotRate: number;
  priceImpactBps: number;
  feeAmount: number;
  feeBps: number;
  minAmountOut: number;
  quoteVersion: number;
  levelsConsumed: number;
  estimatedComputeUnits: number;
  guaranteeText: string;
}

export interface WithdrawalTicket {
  id: string;
  shares: number;
  requestedEpoch: number;
  eligibleEpoch: number;
  estimatedSol: number;
  estimatedUsdc: number;
  status: 'Pending' | 'Ready' | 'Claimed';
}

export interface RiskBreakers {
  oracleStalenessMaxSec: number;
  oracleCurrentStalenessSec: number;
  maxConfRatioBps: number;
  currentConfRatioBps: number;
  maxAnchorStepBps: number;
  maxSpreadBps: number;
  minSpreadBps: number;
  maxInventorySkewBps: number;
  currentInventorySkewBps: number;
  circuitBreakerTripped: boolean;
  activeBreakerReason: string | null;
  keeperBondActive: boolean;
  keeperActiveAddress: string;
}

export interface MarkoutPoint {
  tauSeconds: number; // -5 to +15
  arbSwapBps: number; // positive markout
  passiveAmmBps: number; // negative markout
}

export interface LvrComparisonPoint {
  day: string;
  arbSwapLvrLoss: number; // in USD
  passiveAmmLvrLoss: number; // in USD
  feesCollected: number;
}

export interface QuoteVsFillStat {
  metric: string;
  arbSwap: string;
  typicalPropAmm: string;
  passiveAmm: string;
}

/** A user's real on-chain deposit ticket (shares activating after warm-up). */
export interface DepositTicketView {
  shares: bigint;
  activateSlot: number;
  /** True once the slot has passed `activateSlot`. */
  active: boolean;
}

/** A user's real on-chain withdrawal ticket (settles in `requestedEpoch`). */
export interface WithdrawTicketView {
  shares: bigint;
  requestedEpoch: number;
}

/** Honest, source-labelled protocol status for the header/status surfaces. */
export interface ProtocolStatus {
  rpc: 'ok' | 'error' | 'unknown';
  programRead: 'ok' | 'missing' | 'error';
  oracle: { state: 'unavailable' | 'unknown' | 'available'; reason: string };
  quote: { available: boolean; expired: boolean; version: number; reason: string };
  keeper: { state: 'unverified' | 'active'; reason: string };
  keeperConfigured: string | null;
}
