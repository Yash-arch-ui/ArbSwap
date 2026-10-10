import type { Token, QuoteState, VaultState, RiskBreakers, MarkoutPoint, LvrComparisonPoint, QuoteVsFillStat, WithdrawalTicket } from '../types/protocol';

export const TOKENS: { SOL: Token; USDC: Token } = {
  SOL: {
    symbol: 'SOL',
    name: 'Solana',
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
    balance: 14.852,
    priceUsd: 142.38,
  },
  USDC: {
    symbol: 'USDC',
    name: 'USD Coin',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
    balance: 2840.50,
    priceUsd: 1.00,
  },
};

export const INITIAL_QUOTE_STATE: QuoteState = {
  version: 49821,
  updateSlot: 310892401,
  currentSlot: 310892403,
  expirySlot: 310892411, // 10 slots expiry
  oraclePrice: 142.38,
  anchorSqrtPrice: '0x00000000000000000000000000000000',
  reservationPrice: 142.41,
  halfSpreadBps: 1.8,
  askExtraBps: 0.4,
  bidExtraBps: 0.0,
  depthMultBps: 8750,
  flowNetSold: 32.4,
  oraclePublishTime: Math.floor(Date.now() / 1000) - 1,
  oracleConfBps: 1.8,
  shortVolBps: 18.5,
  mediumVolBps: 14.2,
  recentMoveBps: 2.1,
  status: 'Fresh',
  levels: [
    { level: 1, offsetBps: 0, weightBps: 1000, capacityUsd: 84250, bidPrice: 142.384, askPrice: 142.435 },
    { level: 2, offsetBps: 2, weightBps: 1500, capacityUsd: 126375, bidPrice: 142.355, askPrice: 142.464 },
    { level: 3, offsetBps: 5, weightBps: 2000, capacityUsd: 168500, bidPrice: 142.312, askPrice: 142.506 },
    { level: 4, offsetBps: 10, weightBps: 2000, capacityUsd: 168500, bidPrice: 142.241, askPrice: 142.577 },
    { level: 5, offsetBps: 20, weightBps: 2000, capacityUsd: 168500, bidPrice: 142.099, askPrice: 142.720 },
    { level: 6, offsetBps: 40, weightBps: 1500, capacityUsd: 126375, bidPrice: 141.814, askPrice: 143.005 },
  ],
};

export const INITIAL_VAULT_STATE: VaultState = {
  tvlUsd: 1842500,
  baseReserve: 6470.24,
  quoteReserve: 921250.00,
  totalShares: 14250000,
  userShares: 85500,
  userBaseEquivalent: 38.82,
  userQuoteEquivalent: 5527.50,
  sharePriceUsd: 0.1293,
  inventoryImbalanceQ: -0.012,
  targetRatio: 0.50,
  currentRatio: 0.501,
  feeApy: 14.8,
  lvrAvoided7dUsd: 8420.50,
  netHedgedApy: 19.4,
  epoch: 412,
  epochSlotsRemaining: 420,
  status: 'Active',
  insuranceBufferUsd: 38500,
  keeperPoolUsd: 9420,
  protocolFeesUsd: 12300,
  warmupSlots: 150,
};

export const MOCK_USER_TICKETS: WithdrawalTicket[] = [
  {
    id: 'wd-ticket-4091',
    shares: 12000,
    requestedEpoch: 411,
    eligibleEpoch: 412,
    estimatedSol: 5.44,
    estimatedUsdc: 775.80,
    status: 'Ready',
  },
];

export const INITIAL_RISK_BREAKERS: RiskBreakers = {
  oracleStalenessMaxSec: 2.0,
  oracleCurrentStalenessSec: 0.4,
  maxConfRatioBps: 10.0,
  currentConfRatioBps: 1.8,
  maxAnchorStepBps: 50.0,
  maxSpreadBps: 50.0,
  minSpreadBps: 0.5,
  maxInventorySkewBps: 6000,
  currentInventorySkewBps: 120,
  circuitBreakerTripped: false,
  activeBreakerReason: null,
  keeperBondActive: true,
  keeperActiveAddress: 'Keep7bX9M...4kLm (Bond: 250 SOL)',
};

export const MOCK_MARKOUT_DATA: MarkoutPoint[] = [
  { tauSeconds: -5, arbSwapBps: 0.05, passiveAmmBps: -0.02 },
  { tauSeconds: -2, arbSwapBps: 0.08, passiveAmmBps: -0.05 },
  { tauSeconds: 0, arbSwapBps: 0.12, passiveAmmBps: -0.10 },
  { tauSeconds: 1, arbSwapBps: 0.28, passiveAmmBps: -0.18 },
  { tauSeconds: 2, arbSwapBps: 0.38, passiveAmmBps: -0.23 },
  { tauSeconds: 5, arbSwapBps: 0.42, passiveAmmBps: -0.28 },
  { tauSeconds: 10, arbSwapBps: 0.45, passiveAmmBps: -0.34 },
  { tauSeconds: 15, arbSwapBps: 0.46, passiveAmmBps: -0.36 },
];

export const MOCK_LVR_DATA: LvrComparisonPoint[] = [
  { day: 'Mon', arbSwapLvrLoss: 120, passiveAmmLvrLoss: 1420, feesCollected: 890 },
  { day: 'Tue', arbSwapLvrLoss: 190, passiveAmmLvrLoss: 1980, feesCollected: 1240 },
  { day: 'Wed', arbSwapLvrLoss: 140, passiveAmmLvrLoss: 1650, feesCollected: 1050 },
  { day: 'Thu', arbSwapLvrLoss: 310, passiveAmmLvrLoss: 3400, feesCollected: 2180 },
  { day: 'Fri', arbSwapLvrLoss: 210, passiveAmmLvrLoss: 2210, feesCollected: 1450 },
  { day: 'Sat', arbSwapLvrLoss: 95,  passiveAmmLvrLoss: 980,  feesCollected: 640 },
  { day: 'Sun', arbSwapLvrLoss: 110, passiveAmmLvrLoss: 1120, feesCollected: 720 },
];

export const MOCK_QUOTE_VS_FILL: QuoteVsFillStat[] = [
  {
    metric: 'Quote-vs-Fill Gap (bps)',
    arbSwap: '0.00 bps (Exact Fill)',
    typicalPropAmm: '1.08 bps (Slippage/Degradation)',
    passiveAmm: '2.50+ bps (AMM price impact)',
  },
  {
    metric: 'Identical Execution Rate',
    arbSwap: '99.9% (Version Protected)',
    typicalPropAmm: '39.0% (Flashblocks spoofing risk)',
    passiveAmm: 'Varies with mempool state',
  },
  {
    metric: 'Quiet Flow Half-Spread',
    arbSwap: '0.24 bps',
    typicalPropAmm: '0.26 bps',
    passiveAmm: '2.59 bps (10x wider)',
  },
  {
    metric: 'Average Compute Units / Update',
    arbSwap: '~620 CU',
    typicalPropAmm: '~485 - 676 CU',
    passiveAmm: '16,938+ CU per swap',
  },
];
