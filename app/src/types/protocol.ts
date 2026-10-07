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

export interface QuoteState {
  version: number;
  updateSlot: number;
  currentSlot: number;
  expirySlot: number;
  oraclePrice: number;
  anchorSqrtPrice: string;
  reservationPrice: number;
  halfSpreadBps: number;
  askExtraBps: number;
  bidExtraBps: number;
  depthMultBps: number;
  flowNetSold: number; // in SOL
  oraclePublishTime: number; // Unix timestamp
  oracleConfBps: number;
  shortVolBps: number; // sigma_s
  mediumVolBps: number; // sigma_m
  recentMoveBps: number;
  levels: QuoteLevel[];
  status: 'Fresh' | 'Aging' | 'Expired';
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
  netHedgedApy: number; // alpha APY
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
