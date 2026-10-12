import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
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
  fetchProtocolState,
  fetchShareBalance,
  fetchDepositTicket,
  fetchWithdrawTicket,
} from '../chain/program';
import { toQuoteState, toVaultState, toRiskBreakers } from '../chain/live';

const BASE_SYMBOL = ACTIVE_VAULT.baseMint.equals(BASE_MINT) ? 'WSOL' : 'BASE';
const QUOTE_SYMBOL = ACTIVE_VAULT.quoteMint.equals(QUOTE_MINT) ? 'USDC' : 'QUOTE';

/** Neutral state used before/without a live vault. Numbers are zero, not mock. */
const EMPTY_QUOTE_STATE: QuoteState = {
  version: 0, updateSlot: 0, currentSlot: 0, expirySlot: 0,
  oraclePrice: 0, anchorSqrtPrice: '0', reservationPrice: 0,
  halfSpreadBps: 0, askExtraBps: 0, bidExtraBps: 0, depthMultBps: 0,
  flowNetSold: 0, oraclePublishTime: 0, oracleConfBps: 0,
  shortVolBps: 0, mediumVolBps: 0, recentMoveBps: 0,
  levels: Array.from({ length: 6 }, (_, i) => ({
    level: i + 1, offsetBps: 0, weightBps: 0, capacityUsd: 0, bidPrice: 0, askPrice: 0,
  })),
  status: 'Expired',
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

interface ProtocolContextType {
  quoteState: QuoteState;
  vaultState: VaultState;
  riskBreakers: RiskBreakers;
  tokens: { SOL: Token; USDC: Token };
  status: ProtocolStatus;
  walletConnected: boolean;
  walletAddress: string | null;
  balancesLoading: boolean;
  vaultInitialized: boolean;
  quoteAvailable: boolean;
  quoteFresh: boolean;
  shareBalanceAtoms: bigint | null;
  depositTicket: DepositTicketView | null;
  withdrawTicket: WithdrawTicketView | null;
  currentSlot: number;
  lastUpdatedAt: number | null;
  liveError: string | null;
  activeVaultLabel: string;
  refreshBalances: () => Promise<void>;
  refreshProtocol: () => Promise<void>;
  connectWallet: () => void;
  disconnectWallet: () => void;
}

const ProtocolContext = createContext<ProtocolContextType | undefined>(undefined);

export const ProtocolProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { connection } = useConnection();
  const { connected, publicKey, connect, disconnect } = useWallet();
  const [quoteState, setQuoteState] = useState<QuoteState>(EMPTY_QUOTE_STATE);
  const [vaultState, setVaultState] = useState<VaultState>(EMPTY_VAULT_STATE);
  const [riskBreakers, setRiskBreakers] = useState<RiskBreakers>(EMPTY_RISK);
  const [tokens, setTokens] = useState(INITIAL_TOKENS);
  const [status, setStatus] = useState<ProtocolStatus>(EMPTY_STATUS);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [vaultInitialized, setVaultInitialized] = useState(false);
  const [quoteAvailable, setQuoteAvailable] = useState(false);
  const [quoteFresh, setQuoteFresh] = useState(false);
  const [shareBalanceAtoms, setShareBalanceAtoms] = useState<bigint | null>(null);
  const [depositTicket, setDepositTicket] = useState<DepositTicketView | null>(null);
  const [withdrawTicket, setWithdrawTicket] = useState<WithdrawTicketView | null>(null);
  const [currentSlot, setCurrentSlot] = useState(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const shareMintRef = useRef<string | null>(null);

  const refreshBalances = useCallback(async () => {
    if (!publicKey) {
      setTokens(INITIAL_TOKENS);
      setShareBalanceAtoms(null);
      return;
    }
    setBalancesLoading(true);
    try {
      const { base, quote } = await loadWalletBalances(connection, publicKey);
      const shares = await fetchShareBalance(connection, publicKey).catch(() => null);
      setTokens((prev) => ({
        SOL: { ...prev.SOL, balance: Number(base.toFixed(4)) },
        USDC: { ...prev.USDC, balance: Number(quote.toFixed(2)) },
      }));
      setShareBalanceAtoms(shares);
    } catch {
      // RPC hiccup: keep the last known balances.
    } finally {
      setBalancesLoading(false);
    }
  }, [connection, publicKey]);

  const refreshProtocol = useCallback(async () => {
    try {
      const [state, slot] = await Promise.all([
        fetchProtocolState(connection, ACTIVE_VAULT.baseMint, ACTIVE_VAULT.quoteMint),
        connection.getSlot().catch(() => 0),
      ]);
      const now = Math.floor(Date.now() / 1000);
      setVaultInitialized(state.exists);
      setCurrentSlot(slot);
      setLastUpdatedAt(now);
      setLiveError(null);
      if (state.vaultData) shareMintRef.current = state.vaultData.shareMint.toBase58();

      const quote = toQuoteState(state, slot);
      const hasQuote = state.quoteData !== undefined && Number(state.quoteData.version) > 0;
      const isFresh = hasQuote && slot < Number(state.quoteData?.expirySlot ?? 0);
      setQuoteState(quote);
      setQuoteAvailable(isFresh);
      setQuoteFresh(isFresh);
      const risk = toRiskBreakers(state, now);
      risk.circuitBreakerTripped = state.vaultData ? state.vaultData.status !== 0 : false;
      risk.activeBreakerReason = risk.circuitBreakerTripped ? 'Vault status is not Active' : null;
      risk.keeperActiveAddress = state.configData ? state.configData.keeper.toBase58() : '';
      setRiskBreakers(risk);
      setTokens((prev) => ({
        SOL: { ...prev.SOL, priceUsd: quote.oraclePrice || prev.SOL.priceUsd },
        USDC: { ...prev.USDC, priceUsd: 1 },
      }));

      let shares: bigint | null = null;
      let dep: DepositTicketView | null = null;
      let wd: WithdrawTicketView | null = null;
      if (publicKey && state.vaultData) {
        shares = await fetchShareBalance(connection, publicKey).catch(() => null);
        const dt = await fetchDepositTicket(connection, publicKey).catch(() => null);
        if (dt) {
          const activate = Number((dt.activateSlot as { toString(): string } | undefined)?.toString() ?? '0');
          dep = { shares: BigInt((dt.shares as { toString(): string }).toString()), activateSlot: activate, active: slot >= activate };
        }
        const wt = await fetchWithdrawTicket(connection, publicKey).catch(() => null);
        if (wt) {
          wd = {
            shares: BigInt((wt.shares as { toString(): string }).toString()),
            requestedEpoch: Number((wt.epoch as { toString(): string } | undefined)?.toString() ?? '0'),
          };
        }
      }
      setShareBalanceAtoms(shares);
      setDepositTicket(dep);
      setWithdrawTicket(wd);
      setVaultState(toVaultState(state, quote.oraclePrice, shares === null ? 0 : Number(shares.toString()) / 10 ** ACTIVE_VAULT.shareDecimals));

      setStatus({
        rpc: 'ok',
        programRead: state.exists ? 'ok' : 'missing',
        oracle: {
          state: 'unavailable',
          reason: hasQuote
            ? 'Quote present; oracle freshness is validated on-chain by the deployed 2 s Pyth rule.'
            : 'No valid on-chain Pyth quote. The configured credential lacks entitlement to the crypto-spot SOL/USD feed; the keeper cannot publish a quote.',
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
        keeper: {
          state: 'unverified',
          reason: 'Keeper submission status is not observable from the chain.',
        },
        keeperConfigured: state.configData ? state.configData.keeper.toBase58() : null,
      });
    } catch (error) {
      setLiveError((error as Error).message?.slice(0, 160) ?? 'RPC error');
      setStatus((prev) => ({ ...prev, rpc: 'error', programRead: 'error' }));
    }
  }, [connection, publicKey]);

  useEffect(() => {
    void refreshProtocol();
    const id = setInterval(() => { void refreshProtocol(); }, 8_000);
    return () => clearInterval(id);
  }, [refreshProtocol]);

  useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);

  const connectWallet = () => { void connect().catch(() => undefined); };
  const disconnectWallet = () => { void disconnect().catch(() => undefined); };

  return (
    <ProtocolContext.Provider
      value={{
        quoteState,
        vaultState,
        riskBreakers,
        tokens,
        status,
        walletConnected: connected,
        walletAddress: publicKey ? publicKey.toBase58() : null,
        balancesLoading,
        vaultInitialized,
        quoteAvailable,
        quoteFresh,
        shareBalanceAtoms,
        depositTicket,
        withdrawTicket,
        currentSlot,
        lastUpdatedAt,
        liveError,
        activeVaultLabel: ACTIVE_VAULT.label,
        refreshBalances,
        refreshProtocol,
        connectWallet,
        disconnectWallet,
      }}
    >
      {children}
    </ProtocolContext.Provider>
  );
};

export const useProtocol = () => {
  const context = useContext(ProtocolContext);
  if (!context) {
    throw new Error('useProtocol must be used within a ProtocolProvider');
  }
  return context;
};
