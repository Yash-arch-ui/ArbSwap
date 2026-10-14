import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import type {
  QuoteState,
  VaultState,
  RiskBreakers,
  Token,
  ProtocolStatus,
  DepositTicketView,
  WithdrawTicketView,
} from '../types/protocol';
import { ACTIVE_VAULT, BASE_MINT, QUOTE_MINT, loadWalletBalances } from '../chain/solana';
import {
  fetchShareBalance,
  fetchDepositTicket,
  fetchWithdrawTicket,
  fetchQuoteOnly,
  verifyCluster,
  verifyProgram,
  deriveVaultAddresses,
  type OnChainProtocolState,
} from '../chain/program';
import { readVault } from '../chain/vaultRead';
import { toQuoteState, toVaultState, toRiskBreakers } from '../chain/live';
import { LiveQuoteFeed } from '../chain/liveQuote';
import { APP_RPC_FAILOVER, APP_LIVE_RPC, type RpcHealthSnapshot } from '../chain/rpcFailover';
import {
  liveSource,
  loadingSource,
  sourceErrorFromException,
  staleSource,
  unavailableSource,
  type SourceError,
  type SourceState,
  type Sourced,
} from '../chain/dataState';

const RPC_FAILOVER = APP_RPC_FAILOVER;

const BASE_SYMBOL = ACTIVE_VAULT.baseMint.equals(BASE_MINT) ? 'WSOL' : 'BASE';
const QUOTE_SYMBOL = ACTIVE_VAULT.quoteMint.equals(QUOTE_MINT) ? 'USDC' : 'QUOTE';

/** Neutral state used before/without a live vault. Numbers are zero, not mock. */
const EMPTY_QUOTE_STATE: QuoteState = {
  hasQuote: false,
  version: 0, updateSlot: 0, currentSlot: 0, expirySlot: 0,
  oraclePrice: 0, anchorSqrtPrice: '0', pResSqrt: '0', reservationPrice: 0,
  halfSpreadBps: 0, askExtraBps: 0, bidExtraBps: 0, depthMultBps: 0,
  flowNetSold: 0, oraclePublishTime: 0, oracleConfBps: 0, quoteKeeper: null,
  shortVolBps: 0, mediumVolBps: 0, recentMoveBps: 0,
  levels: Array.from({ length: 6 }, (_, i) => ({
    level: i + 1, offsetBps: 0, weightBps: 0, capacityUsd: 0, bidPrice: 0, askPrice: 0,
  })),
  askLevelsRaw: [],
  bidLevelsRaw: [],
  status: 'Unavailable',
};

const EMPTY_VAULT_STATE: VaultState = {
  tvlUsd: 0, baseReserve: 0, quoteReserve: 0, totalShares: 0, userShares: 0,
  userBaseEquivalent: 0, userQuoteEquivalent: 0, sharePriceUsd: 0,
  inventoryImbalanceQ: 0, targetRatio: 0.5, currentRatio: 0.5,
  feeApy: 0, lvrAvoided7dUsd: 0, netHedgedApy: 0, epoch: 0, epochSlotsRemaining: 0,
  status: 'Active', insuranceBufferUsd: 0, keeperPoolUsd: 0, protocolFeesUsd: 0, warmupSlots: 0,
};

const EMPTY_RISK: RiskBreakers = {
  oracleStalenessMaxSec: 0, oracleCurrentStalenessSec: 0, maxConfRatioBps: 0,
  currentConfRatioBps: 0, maxAnchorStepBps: 0, maxSpreadBps: 0, minSpreadBps: 0,
  maxInventorySkewBps: 0, currentInventorySkewBps: 0, circuitBreakerTripped: false,
  activeBreakerReason: null, keeperBondActive: false, keeperActiveAddress: '',
};

const INITIAL_TOKENS: { SOL: Token; USDC: Token } = {
  SOL: {
    symbol: BASE_SYMBOL, name: `${BASE_SYMBOL} (vault base)`, mint: BASE_MINT.toBase58(),
    decimals: ACTIVE_VAULT.baseDecimals, logo: '', balance: 0, priceUsd: 0,
  },
  USDC: {
    symbol: QUOTE_SYMBOL, name: `${QUOTE_SYMBOL} (vault quote)`, mint: QUOTE_MINT.toBase58(),
    decimals: ACTIVE_VAULT.quoteDecimals, logo: '', balance: 0, priceUsd: 1,
  },
};

export interface ProtocolParams {
  feeBps: number;
  insuranceBps: number;
  keeperBps: number;
  protocolBps: number;
  warmupSlots: number;
  epochSlots: number;
  graceSlots: number;
  expirySlots: number;
  maxQuoteSize: string;
  maxWindowFlowBps: number;
  maxStalenessSeconds: number;
  maxConfBps: number;
}

const EMPTY_STATUS: ProtocolStatus = {
  rpc: 'unknown',
  programRead: 'missing',
  oracle: {
    state: 'unavailable',
    reason: 'No valid on-chain Pyth quote. The keeper needs a SOL/USD price within the deployed 2 s freshness limit.',
  },
  quote: { available: false, expired: true, version: 0, reason: 'No quote has been published.' },
  keeper: { state: 'unverified', reason: 'Keeper submission status is not observable from the chain.' },
  keeperConfigured: null,
};

export interface WalletBalances {
  base: bigint;
  quote: bigint;
  sol: number;
}

export interface RpcStatus extends RpcHealthSnapshot {
  state: SourceState;
  /** Current adaptive poll delay (ms); larger when the provider is unhealthy. */
  pollDelayMs: number;
  /** True when background auto-retry is paused to avoid a retry storm. */
  autoRetryPaused: boolean;
}

interface ProtocolContextType {
  quoteState: QuoteState;
  vaultState: VaultState;
  riskBreakers: RiskBreakers;
  /** Live on-chain protocol parameters (Config), or null until read. */
  protocolParams: ProtocolParams | null;
  tokens: { SOL: Token; USDC: Token };
  status: ProtocolStatus;
  walletConnected: boolean;
  walletAddress: string | null;
  balancesLoading: boolean;
  /** Exact atom balances of the connected wallet's base/quote ATAs (null until read). */
  walletAtoms: { base: bigint; quote: bigint } | null;
  /** Full classified wallet-balance source (state/value/asOf/error). */
  balancesSource: Sourced<WalletBalances>;
  /** Classified protocol account source (the authoritative vault/quote/config read). */
  vaultSource: Sourced<OnChainProtocolState>;
  /**
   * true = a successful authoritative read found the account; false = a
   * successful read proved it is absent; null = not yet established (e.g. an
   * RPC failure). NEVER false because of a transport error.
   */
  vaultExists: boolean | null;
  rpcStatus: RpcStatus;
  /**
   * true only when a vault account was successfully decoded AND the derived
   * config/quote are present. Distinct from "the latest read succeeded".
   */
  vaultInitialized: boolean;
  quoteAvailable: boolean;
  quoteFresh: boolean;
  shareBalanceAtoms: bigint | null;
  /** Raw atom amounts for integer-exact deposit/share math (null until read). */
  vaultAtoms: { totalShares: bigint; baseNet: bigint; quoteNet: bigint; minLiquidity: bigint } | null;
  depositTicket: DepositTicketView | null;
  withdrawTicket: WithdrawTicketView | null;
  currentSlot: number;
  lastUpdatedAt: number | null;
  /** Single, sanitized, classified error message (never a raw RPC object). */
  liveError: string | null;
  /** Devnet genesis + deployed program verified before on-chain data is trusted. */
  genesisVerified: boolean;
  programVerified: boolean;
  /** Latest observed chain block time (unix seconds) or null. */
  blockTime: number | null;
  activeVaultLabel: string;
  refreshBalances: () => Promise<void>;
  refreshProtocol: () => Promise<void>;
  /** Manual retry: resets backoff/pause and performs one refresh now. */
  retryNow: () => void;
  connectWallet: () => void;
  disconnectWallet: () => void;
}

const ProtocolContext = createContext<ProtocolContextType | undefined>(undefined);

// The deployed quote expires after only `Config.expiry_slots` (10 slots, ~2.4 s
// on Devnet), so a 4 s poll would almost never observe a fresh quote. Poll
// slightly faster than the expiry window; concurrent identical reads are
// deduplicated by the failover layer and back off on provider failures, so this
// does not add RPC chatter beyond what a fresh-quote UI needs.
const POLL_BASE_MS = 1_500;
const POLL_CAP_MS = 30_000;
const PAUSE_AFTER_FAILURES = 4;

function delayForFailures(base: number, failures: number): number {
  if (failures <= 0) return base;
  return Math.min(POLL_CAP_MS, base * 2 ** (failures - 1));
}

export const ProtocolProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { connected, publicKey, connect, disconnect } = useWallet();
  const [quoteState, setQuoteState] = useState<QuoteState>(EMPTY_QUOTE_STATE);
  const [vaultState, setVaultState] = useState<VaultState>(EMPTY_VAULT_STATE);
  const [riskBreakers, setRiskBreakers] = useState<RiskBreakers>(EMPTY_RISK);
  const [protocolParams, setProtocolParams] = useState<ProtocolParams | null>(null);
  const [tokens, setTokens] = useState(INITIAL_TOKENS);
  const [status, setStatus] = useState<ProtocolStatus>(EMPTY_STATUS);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [walletAtoms, setWalletAtoms] = useState<{ base: bigint; quote: bigint } | null>(null);
  const [balancesSource, setBalancesSource] = useState<Sourced<WalletBalances>>(
    loadingSource('Wallet balances have not been read.'),
  );
  const [vaultSource, setVaultSource] = useState<Sourced<OnChainProtocolState>>(
    loadingSource('The vault account has not been read.'),
  );
  const [vaultExists, setVaultExists] = useState<boolean | null>(null);
  const [vaultInitialized, setVaultInitialized] = useState(false);
  const [quoteAvailable, setQuoteAvailable] = useState(false);
  const [quoteFresh, setQuoteFresh] = useState(false);
  const [shareBalanceAtoms, setShareBalanceAtoms] = useState<bigint | null>(null);
  const [vaultAtoms, setVaultAtoms] = useState<ProtocolContextType['vaultAtoms']>(null);
  const [depositTicket, setDepositTicket] = useState<DepositTicketView | null>(null);
  const [withdrawTicket, setWithdrawTicket] = useState<WithdrawTicketView | null>(null);
  const [currentSlot, setCurrentSlot] = useState(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [genesisVerified, setGenesisVerified] = useState(false);
  const [programVerified, setProgramVerified] = useState(false);
  const [blockTime, setBlockTime] = useState<number | null>(null);
  const [rpcState, setRpcState] = useState<SourceState>('loading');
  const [rpcSnapshot, setRpcSnapshot] = useState<RpcHealthSnapshot>(() => RPC_FAILOVER.health());
  const [pollDelayMs, setPollDelayMs] = useState(POLL_BASE_MS);
  const [autoRetryPaused, setAutoRetryPaused] = useState(false);

  const shareMintRef = useRef<string | null>(null);
  const configDataRef = useRef<OnChainProtocolState['configData']>(undefined);
  const refreshSeqRef = useRef(0);
  const lastGoodRef = useRef<{ state: OnChainProtocolState; slot: number } | null>(null);
  const failureStreakRef = useRef(0);
  const pollDelayRef = useRef(POLL_BASE_MS);
  const pausedRef = useRef(false);
  const lastSuccessMsRef = useRef<number | null>(null);

  const refreshBalances = useCallback(async () => {
    if (!publicKey) {
      setTokens(INITIAL_TOKENS);
      setShareBalanceAtoms(null);
      setWalletAtoms(null);
      setBalancesSource(loadingSource('Connect a wallet to read balances.'));
      return;
    }
    setBalancesLoading(true);
    try {
      const balances = await RPC_FAILOVER.runKeyed(`walletBalances:${publicKey.toBase58()}`, (c) =>
        loadWalletBalances(c, publicKey),
      );
      const shares = await RPC_FAILOVER
        .runKeyed(`shareBalance:${publicKey.toBase58()}`, (c) => fetchShareBalance(c, publicKey))
        .catch(() => null);
      setTokens((prev) => ({
        SOL: { ...prev.SOL, balance: Number(balances.base.toFixed(4)) },
        USDC: { ...prev.USDC, balance: Number(balances.quote.toFixed(2)) },
      }));
      setWalletAtoms({ base: balances.baseAtoms, quote: balances.quoteAtoms });
      setShareBalanceAtoms(shares);
      setBalancesSource(
        liveSource<WalletBalances>(
          { base: balances.baseAtoms, quote: balances.quoteAtoms, sol: balances.sol },
          Date.now(),
        ),
      );
    } catch (error) {
      const { kind, reason } = sourceErrorFromException(error);
      setBalancesSource((prev) =>
        prev.value
          ? staleSource(prev, `${reason} Showing last-known balances.`, kind)
          : unavailableSource(`Balances unavailable: ${reason}`, kind),
      );
    } finally {
      setBalancesLoading(false);
    }
  }, [publicKey]);

  /** Apply a successfully-read protocol snapshot to all derived UI state. */
  const applySnapshot = useCallback(
    (state: OnChainProtocolState, slot: number, nowMs: number, extra: {
      genesisVerified: boolean; programVerified: boolean; blockTime: number | null;
      shares: bigint | null; dep: DepositTicketView | null; wd: WithdrawTicketView | null;
      sourceState: 'live' | 'stale'; reason: string | null; errorKind: SourceError | null;
    }) => {
      const quote = toQuoteState(state, slot);
      const hasQuote = state.quoteData !== undefined && Number(state.quoteData.version) > 0;
      const isFresh = hasQuote && slot < Number(state.quoteData?.expirySlot ?? 0);
      // NOTE: the quote freshness state (quoteState/quoteAvailable/quoteFresh/
      // currentSlot) is owned by the live quote feed (S2-36), not this slow
      // vault/config read, so the UI never renders a stale quote as live.
      const risk = toRiskBreakers(state, nowMs / 1000);
      risk.circuitBreakerTripped = state.vaultData ? state.vaultData.status !== 0 : false;
      risk.activeBreakerReason = risk.circuitBreakerTripped ? 'Vault status is not Active' : null;
      risk.keeperActiveAddress = state.configData ? state.configData.keeper.toBase58() : '';
      setRiskBreakers(risk);
      if (state.configData) {
        configDataRef.current = state.configData;
        const c = state.configData;
        setProtocolParams({
          feeBps: c.feeBps,
          insuranceBps: c.insuranceBps,
          keeperBps: c.keeperBps,
          protocolBps: c.protocolBps,
          warmupSlots: Number(c.warmupSlots.toString()),
          epochSlots: Number(c.epochSlots.toString()),
          graceSlots: Number(c.graceSlots.toString()),
          expirySlots: Number(c.expirySlots.toString()),
          maxQuoteSize: c.maxQuoteSize.toString(),
          maxWindowFlowBps: c.maxWindowFlowBps,
          maxStalenessSeconds: Number(c.maxStalenessSeconds.toString()),
          maxConfBps: c.maxConfBps,
        });
      }
      setCurrentSlot((prev) => (prev === 0 ? slot : prev));
      setBlockTime(extra.blockTime);
      setGenesisVerified(extra.genesisVerified);
      setProgramVerified(extra.programVerified);
      setShareBalanceAtoms(extra.shares);
      setDepositTicket(extra.dep);
      setWithdrawTicket(extra.wd);
      setTokens((prev) => ({
        SOL: { ...prev.SOL, priceUsd: quote.oraclePrice || prev.SOL.priceUsd },
        USDC: { ...prev.USDC, priceUsd: 1 },
      }));
      if (state.vaultData) {
        shareMintRef.current = state.vaultData.shareMint.toBase58();
        const v = state.vaultData;
        const b = (x?: { toString(): string }) => BigInt((x?.toString() ?? '0'));
        const baseNet = b(v.baseReserveAmount) - b(v.insuranceBase) - b(v.keeperBase) - b(v.protocolBase);
        const quoteNet = b(v.quoteReserveAmount) - b(v.insuranceQuote) - b(v.keeperQuote) - b(v.protocolQuote);
        setVaultAtoms({
          totalShares: b(v.totalShares),
          baseNet: baseNet > 0n ? baseNet : 0n,
          quoteNet: quoteNet > 0n ? quoteNet : 0n,
          minLiquidity: state.configData ? b(state.configData.minLiquidity) : 0n,
        });
      }
      setVaultState(
        toVaultState(state, quote.oraclePrice, extra.shares === null ? 0 : Number(extra.shares.toString()) / 10 ** ACTIVE_VAULT.shareDecimals, slot),
      );
      setVaultSource({
        state: extra.sourceState,
        value: state,
        asOf: extra.sourceState === 'live' ? nowMs : lastSuccessMsRef.current ?? nowMs,
        reason: extra.reason,
        errorKind: extra.errorKind,
      });
      if (extra.sourceState === 'live') lastSuccessMsRef.current = nowMs;
      setVaultExists(true);
      setVaultInitialized(true);
      setStatus({
        rpc: 'ok',
        programRead: 'ok',
        oracle: {
          state: 'unavailable',
          reason: hasQuote
            ? 'Quote present; oracle freshness is validated on-chain by the deployed 2 s Pyth rule.'
            : 'No committed on-chain quote is currently readable for this vault.',
        },
        quote: {
          available: isFresh,
          expired: !isFresh,
          version: hasQuote ? Number(state.quoteData?.version ?? 0) : 0,
          reason: isFresh
            ? `Fresh quote v${Number(state.quoteData?.version ?? 0)} (expires slot ${Number(state.quoteData?.expirySlot ?? 0)}).`
            : hasQuote
              ? 'Quote is present but expired at the current slot.'
              : 'No quote has been published by the keeper.',
        },
        keeper: { state: 'unverified', reason: 'Keeper submission status is not observable from the chain.' },
        keeperConfigured: state.configData ? state.configData.keeper.toBase58() : null,
      });
    },
    [],
  );

  const refreshProtocol = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const nowMs = Date.now();
    try {
      // One authoritative, classified vault read. Concurrent identical reads are
      // deduplicated by the failover layer.
      const result = await RPC_FAILOVER.runKeyed('readVault', (c) => readVault(c));
      if (seq !== refreshSeqRef.current) return;

      if (result.kind === 'rpc_error') {
        failureStreakRef.current += 1;
        const { reason, errorKind } = result;
        setLiveError(`${reason} Live vault and quote data could not be refreshed.`);
        setRpcState('stale');
        const prev = lastGoodRef.current;
        if (prev) {
          // Retain last-known values, explicitly marked stale (never as fresh).
          applySnapshot(prev.state, prev.slot, nowMs, {
            genesisVerified, programVerified, blockTime,
            shares: shareBalanceAtoms, dep: depositTicket, wd: withdrawTicket,
            sourceState: 'stale', reason, errorKind,
          });
        } else {
          setVaultSource(unavailableSource(reason, errorKind));
          setVaultInitialized(false);
          setStatus((p) => ({ ...p, rpc: 'error', programRead: 'error' }));
        }
        const paused = failureStreakRef.current >= PAUSE_AFTER_FAILURES;
        pausedRef.current = paused;
        setAutoRetryPaused(paused);
        pollDelayRef.current = delayForFailures(POLL_BASE_MS, failureStreakRef.current);
        setPollDelayMs(pollDelayRef.current);
        return;
      }

      if (result.kind === 'not_found') {
        // Authoritative: a successful lookup returned no account.
        failureStreakRef.current = 0;
        pausedRef.current = false;
        setAutoRetryPaused(false);
        pollDelayRef.current = POLL_BASE_MS;
        setPollDelayMs(POLL_BASE_MS);
        setLiveError(null);
        setRpcState('live');
        setVaultExists(false);
        setVaultInitialized(false);
        setQuoteAvailable(false);
        setQuoteFresh(false);
        setVaultSource(unavailableSource('No vault account exists for the configured mints on Devnet.', 'not_found'));
        setQuoteState(EMPTY_QUOTE_STATE);
        setVaultState(EMPTY_VAULT_STATE);
        setStatus({ ...EMPTY_STATUS, rpc: 'ok', programRead: 'missing' });
        return;
      }

      if (result.kind === 'invalid') {
        failureStreakRef.current = 0;
        pausedRef.current = false;
        setAutoRetryPaused(false);
        setLiveError(result.reason);
        setRpcState('invalid');
        setVaultSource(prevSourceInvalid(result.reason, result.errorKind));
        setVaultInitialized(false);
        setStatus((p) => ({ ...p, rpc: 'error', programRead: 'error' }));
        return;
      }

      // kind === 'ready'
      failureStreakRef.current = 0;
      pausedRef.current = false;
      setAutoRetryPaused(false);
      pollDelayRef.current = POLL_BASE_MS;
      setPollDelayMs(POLL_BASE_MS);
      setLiveError(null);
      setRpcState('live');

      const state = result.state;
      const [slot, cluster, program] = await Promise.all([
        RPC_FAILOVER.runKeyed('getSlot', (c) => c.getSlot()).catch(() => 0),
        RPC_FAILOVER.runKeyed('verifyCluster', (c) => verifyCluster(c)).catch(() => ({ verified: false, genesisHash: null })),
        RPC_FAILOVER.runKeyed('verifyProgram', (c) => verifyProgram(c)).catch(() => ({ verified: false, owner: null, executable: false })),
      ]);
      if (seq !== refreshSeqRef.current) return;
      lastGoodRef.current = { state, slot };

      let shares: bigint | null = null;
      let dep: DepositTicketView | null = null;
      let wd: WithdrawTicketView | null = null;
      if (publicKey && state.vaultData) {
        shares = await RPC_FAILOVER
          .runKeyed(`shareBalance:${publicKey.toBase58()}`, (c) => fetchShareBalance(c, publicKey))
          .catch(() => null);
        const dt = await RPC_FAILOVER
          .runKeyed(`depositTicket:${publicKey.toBase58()}`, (c) => fetchDepositTicket(c, publicKey))
          .catch(() => null);
        if (dt) {
          const activate = Number((dt.activateSlot as { toString(): string } | undefined)?.toString() ?? '0');
          dep = { shares: BigInt((dt.shares as { toString(): string }).toString()), activateSlot: activate, active: slot >= activate };
        }
        const wt = await RPC_FAILOVER
          .runKeyed(`withdrawTicket:${publicKey.toBase58()}`, (c) => fetchWithdrawTicket(c, publicKey))
          .catch(() => null);
        if (wt) {
          wd = {
            shares: BigInt((wt.shares as { toString(): string }).toString()),
            requestedEpoch: Number((wt.epoch as { toString(): string } | undefined)?.toString() ?? '0'),
          };
        }
      }
      if (seq !== refreshSeqRef.current) return;
      const bt = slot > 0
        ? await RPC_FAILOVER.runKeyed(`blockTime:${slot}`, (c) => c.getBlockTime(slot)).catch(() => null)
        : null;
      if (seq !== refreshSeqRef.current) return;

      applySnapshot(state, slot, nowMs, {
        genesisVerified: cluster.verified,
        programVerified: program.verified,
        blockTime: bt,
        shares, dep, wd,
        sourceState: 'live', reason: null, errorKind: null,
      });
      setLastUpdatedAt(Math.floor(nowMs / 1000));
    } catch (error) {
      if (seq !== refreshSeqRef.current) return;
      const { kind, reason } = sourceErrorFromException(error);
      failureStreakRef.current += 1;
      setLiveError(`${reason} Live vault and quote data could not be refreshed.`);
      setRpcState('stale');
      const prev = lastGoodRef.current;
      if (prev) {
        applySnapshot(prev.state, prev.slot, nowMs, {
          genesisVerified, programVerified, blockTime,
          shares: shareBalanceAtoms, dep: depositTicket, wd: withdrawTicket,
          sourceState: 'stale', reason, errorKind: kind,
        });
      } else {
        setVaultSource(unavailableSource(reason, kind));
      }
      const paused = failureStreakRef.current >= PAUSE_AFTER_FAILURES;
      pausedRef.current = paused;
      setAutoRetryPaused(paused);
      pollDelayRef.current = delayForFailures(POLL_BASE_MS, failureStreakRef.current);
      setPollDelayMs(pollDelayRef.current);
    } finally {
      setRpcSnapshot(RPC_FAILOVER.health());
      setLastUpdatedAt((t) => t ?? Math.floor(nowMs / 1000));
    }
  }, [applySnapshot, publicKey, genesisVerified, programVerified, blockTime, shareBalanceAtoms, depositTicket, withdrawTicket]);

  const retryNow = useCallback(() => {
    failureStreakRef.current = 0;
    pausedRef.current = false;
    setAutoRetryPaused(false);
    pollDelayRef.current = POLL_BASE_MS;
    setPollDelayMs(POLL_BASE_MS);
    RPC_FAILOVER.resetHealth();
    void refreshProtocol();
  }, [refreshProtocol]);

  // Adaptive, self-rescheduling poll (never a fixed fast interval). Auto-retry
  // pauses after repeated failures to avoid hammering a rate-limited provider.
  const refreshRef = useRef(refreshProtocol);
  refreshRef.current = refreshProtocol;
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      await refreshRef.current();
      if (stopped || pausedRef.current) return;
      timer = setTimeout(loop, pollDelayRef.current);
    };
    void loop();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);

  // S2-36: the quote is driven by its own fast, `processed`-commitment feed so it
  // is observed within ~1 slot of a commit and its status flips to Expired as
  // slots advance — never frozen at the value captured by the slow vault poll.
  useEffect(() => {
    const { vault, config, quoteState: quoteStateKey } = deriveVaultAddresses();
    const feed = new LiveQuoteFeed({
      fetchSlot: () => APP_LIVE_RPC.runKeyed('liveSlot', (c) => c.getSlot('processed')),
      fetchQuote: () => APP_LIVE_RPC.runKeyed('liveQuote', (c) => fetchQuoteOnly(c)),
      graceSlots: () =>
        configDataRef.current ? Number(configDataRef.current.graceSlots.toString()) : 0,
      intervalMs: 700,
      onUpdate: (u) => {
        const synthetic: OnChainProtocolState = {
          exists: true, vault, config, quoteState: quoteStateKey,
          quoteData: u.quote ?? undefined, configData: configDataRef.current ?? undefined,
        };
        const q = toQuoteState(synthetic, u.currentSlot);
        setQuoteState(q);
        setQuoteAvailable(u.executable);
        setQuoteFresh(u.executable);
        setCurrentSlot(u.currentSlot);
        if (q.oraclePrice > 0) {
          setTokens((prev) => ({ ...prev, SOL: { ...prev.SOL, priceUsd: q.oraclePrice } }));
        }
        setStatus((p) => ({
          ...p,
          quote: {
            available: u.executable,
            expired: u.status === 'Expired',
            version: u.version,
            reason:
              u.status === 'Unavailable'
                ? 'No quote has been published by the keeper.'
                : u.executable
                  ? `Fresh quote v${u.version} (expires slot ${u.expirySlot}).`
                  : `Quote v${u.version} is ${u.status.toLowerCase()} at slot ${u.currentSlot} (expiry slot ${u.expirySlot}).`,
          },
        }));
        setLastUpdatedAt((t) => t ?? Math.floor(Date.now() / 1000));
      },
    });
    feed.start();
    return () => feed.stop();
  }, []);

  const connectWallet = () => { void connect().catch(() => undefined); };
  const disconnectWallet = () => { void disconnect().catch(() => undefined); };

  const rpcStatus: RpcStatus = {
    ...rpcSnapshot,
    state: rpcState,
    pollDelayMs,
    autoRetryPaused,
  };

  return (
    <ProtocolContext.Provider
      value={{
        quoteState,
        vaultState,
        riskBreakers,
        protocolParams,
        tokens,
        status,
        walletConnected: connected,
        walletAddress: publicKey ? publicKey.toBase58() : null,
        balancesLoading,
        walletAtoms,
        balancesSource,
        vaultSource,
        vaultExists,
        rpcStatus,
        vaultInitialized,
        quoteAvailable,
        quoteFresh,
        shareBalanceAtoms,
        vaultAtoms,
        depositTicket,
        withdrawTicket,
        currentSlot,
        lastUpdatedAt,
        liveError,
        genesisVerified,
        programVerified,
        blockTime,
        activeVaultLabel: ACTIVE_VAULT.label,
        refreshBalances,
        refreshProtocol,
        retryNow,
        connectWallet,
        disconnectWallet,
      }}
    >
      {children}
    </ProtocolContext.Provider>
  );
};

/** `invalid` helper kept local to avoid re-importing and to stay pure. */
function prevSourceInvalid(reason: string, errorKind: SourceError): Sourced<OnChainProtocolState> {
  return { state: 'invalid', value: null, asOf: null, reason, errorKind };
}

export const useProtocol = () => {
  const context = useContext(ProtocolContext);
  if (!context) {
    throw new Error('useProtocol must be used within a ProtocolProvider');
  }
  return context;
};
