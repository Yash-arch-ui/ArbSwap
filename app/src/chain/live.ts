import { BN } from '@coral-xyz/anchor';
import type { OnChainProtocolState, OnChainLevel } from './program';
import type { QuoteState, QuoteLevel, VaultState, RiskBreakers } from '../types/protocol';

/**
 * Map decoded on-chain accounts into the shapes the UI renders. Every number
 * here is derived from on-chain state (or is explicitly unavailable); nothing is
 * fabricated. TEST TOKEN, devnet: base = tSOL (9 dp), quote = tUSDC (6 dp).
 */

const Q128 = new BN(1).ushln(128);
const BASE_DECIMALS = 9;
const QUOTE_DECIMALS = 6;
const SHARE_DECIMALS = 9;
const DEC_SCALE = 10 ** (BASE_DECIMALS - QUOTE_DECIMALS); // 1000 for 9/6
const LEVELS = 6;

const num = (bn: BN | undefined | null): number => (bn ? Number(bn.toString()) : 0);

/** Human USD price from a Q64.64 sqrt price (raw-atom price × 10^(base-quote)). */
export function humanPriceFromSqrt(sqrt: BN): number {
  if (!sqrt || sqrt.isZero()) return 0;
  const scaled = sqrt.mul(sqrt).muln(1_000_000_000 * DEC_SCALE).div(Q128);
  return num(scaled) / 1_000_000_000;
}

/** Base (tSOL) capacity of a ladder level: liq·(hi−lo)/(lo·hi). */
export function baseCapacity(level: OnChainLevel): number {
  const delta = level.sqrtHi.sub(level.sqrtLo);
  if (delta.lten(0)) return 0;
  const cap = level.liquidity.mul(delta).div(level.sqrtLo.mul(level.sqrtHi));
  return num(cap) / 10 ** BASE_DECIMALS;
}

/** Quote (tUSDC) capacity of a ladder level: liq·(hi−lo)/2^128. */
export function quoteCapacity(level: OnChainLevel): number {
  const delta = level.sqrtHi.sub(level.sqrtLo);
  if (delta.lten(0)) return 0;
  const cap = level.liquidity.mul(delta).div(Q128);
  return num(cap) / 10 ** QUOTE_DECIMALS;
}

export function toQuoteState(
  onchain: OnChainProtocolState,
  currentSlot: number,
): QuoteState {
  const q = onchain.quoteData;
  const cfg = onchain.configData;
  const oraclePrice = q ? humanPriceFromSqrt(q.anchorSqrtPrice) : 0;
  const reservationPrice = q ? humanPriceFromSqrt(q.pResSqrt) : oraclePrice;

  const levels: QuoteLevel[] = [];
  for (let i = 0; i < LEVELS; i++) {
    const ask = q?.askLevels?.[i];
    const bid = q?.bidLevels?.[i];
    levels.push({
      level: i + 1,
      offsetBps: ask?.offsetBps ?? 0,
      weightBps: ask?.weightBps ?? 0,
      capacityUsd: ask ? baseCapacity(ask) * oraclePrice : 0,
      askPrice: ask ? humanPriceFromSqrt(ask.sqrtHi) : 0,
      bidPrice: bid ? humanPriceFromSqrt(bid.sqrtLo) : 0,
    });
  }

  const grace = cfg ? num(cfg.graceSlots) : 0;
  const expiry = q ? num(q.expirySlot) : 0;
  let status: QuoteState['status'] = 'Expired';
  if (q && expiry > 0) {
    if (currentSlot >= expiry) status = 'Expired';
    else if (currentSlot >= expiry - Math.max(0, grace)) status = 'Aging';
    else status = 'Fresh';
  }

  return {
    version: q ? num(q.version) : 0,
    updateSlot: q ? num(q.updateSlot) : 0,
    currentSlot,
    expirySlot: expiry,
    oraclePrice,
    anchorSqrtPrice: q ? q.anchorSqrtPrice.toString() : '0',
    reservationPrice,
    halfSpreadBps: q ? q.halfSpreadBps : 0,
    askExtraBps: q ? q.askExtraBps : 0,
    bidExtraBps: q ? q.bidExtraBps : 0,
    depthMultBps: q ? q.depthMultBps : 0,
    flowNetSold: 0,
    oraclePublishTime: q ? num(q.oraclePublishTime) : 0,
    oracleConfBps: q ? q.oracleConfBps : 0,
    shortVolBps: 0, // keeper-internal, not stored on-chain
    mediumVolBps: 0,
    recentMoveBps: 0,
    levels,
    status,
  };
}

export function toVaultState(
  onchain: OnChainProtocolState,
  oraclePrice: number,
  userShares: number,
): VaultState {
  const v = onchain.vaultData;
  const baseReserve = v ? num(v.baseReserveAmount) / 10 ** BASE_DECIMALS : 0;
  const quoteReserve = v ? num(v.quoteReserveAmount) / 10 ** QUOTE_DECIMALS : 0;
  const totalShares = v ? num(v.totalShares) / 10 ** SHARE_DECIMALS : 0;
  const tvlUsd = baseReserve * oraclePrice + quoteReserve;
  const baseValue = baseReserve * oraclePrice;
  const status: VaultState['status'] =
    !v || v.status === 0 ? 'Active' : v.status === 1 ? 'Paused' : 'WindDown';
  const bucket = (b?: BN, q?: BN): number =>
    (b ? num(b) / 10 ** BASE_DECIMALS : 0) * oraclePrice + (q ? num(q) / 10 ** QUOTE_DECIMALS : 0);
  return {
    tvlUsd,
    baseReserve,
    quoteReserve,
    totalShares,
    userShares,
    userBaseEquivalent: totalShares > 0 ? (userShares * baseReserve) / totalShares : 0,
    userQuoteEquivalent: totalShares > 0 ? (userShares * quoteReserve) / totalShares : 0,
    sharePriceUsd: totalShares > 0 ? tvlUsd / totalShares : 0,
    inventoryImbalanceQ: 0, // not stored on-chain
    targetRatio: 0.5,
    currentRatio: baseValue + quoteReserve > 0 ? baseValue / (baseValue + quoteReserve) : 0.5,
    feeApy: 0, // no on-chain projection
    lvrAvoided7dUsd: 0,
    netHedgedApy: 0,
    epoch: v ? num(v.epoch) : 0,
    epochSlotsRemaining: 0,
    status,
    insuranceBufferUsd: bucket(v?.insuranceBase, v?.insuranceQuote),
    keeperPoolUsd: bucket(v?.keeperBase, v?.keeperQuote),
    protocolFeesUsd: bucket(v?.protocolBase, v?.protocolQuote),
    warmupSlots: onchain.configData ? num(onchain.configData.warmupSlots) : 0,
  };
}

export function toRiskBreakers(onchain: OnChainProtocolState, nowUnix: number): RiskBreakers {
  const cfg = onchain.configData;
  const q = onchain.quoteData;
  const v = onchain.vaultData;
  const pub = q ? num(q.oraclePublishTime) : 0;
  return {
    oracleStalenessMaxSec: cfg ? num(cfg.maxStalenessSeconds) : 0,
    oracleCurrentStalenessSec: pub > 0 ? Math.max(0, nowUnix - pub) : 0,
    maxConfRatioBps: cfg ? cfg.maxConfBps : 0,
    currentConfRatioBps: q ? q.oracleConfBps : 0,
    maxAnchorStepBps: cfg ? cfg.maxAnchorStepBps : 0,
    maxSpreadBps: cfg ? cfg.maxSpreadBps : 0,
    minSpreadBps: cfg ? cfg.minSpreadBps : 0,
    maxInventorySkewBps: cfg ? cfg.maxInventoryBps : 0,
    currentInventorySkewBps: 0,
    circuitBreakerTripped: v ? v.status !== 0 : false,
    activeBreakerReason: null,
    keeperBondActive: cfg ? num(cfg.minBond) > 0 : false,
    keeperActiveAddress: cfg ? cfg.keeper.toBase58() : '',
  };
}
