import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { QuoteState, VaultState, RiskBreakers, Token } from '../types/protocol';
import { BASE_MINT, QUOTE_MINT, loadWalletBalances } from '../chain/solana';
import { fetchProtocolState } from '../chain/program';
import { toQuoteState, toVaultState, toRiskBreakers } from '../chain/live';

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
    symbol: 'tSOL', name: 'Test SOL (devnet)', mint: BASE_MINT.toBase58(),
    decimals: 9, logo: '', balance: 0, priceUsd: 0,
  },
  USDC: {
    symbol: 'tUSDC', name: 'Test USDC (devnet)', mint: QUOTE_MINT.toBase58(),
    decimals: 6, logo: '', balance: 0, priceUsd: 1,
  },
};

interface ProtocolContextType {
  quoteState: QuoteState;
  vaultState: VaultState;
  riskBreakers: RiskBreakers;
  tokens: { SOL: Token; USDC: Token };
  walletConnected: boolean;
  walletAddress: string | null;
  balancesLoading: boolean;
  vaultInitialized: boolean;
  liveError: string | null;
  refreshBalances: () => Promise<void>;
  connectWallet: () => void;
  disconnectWallet: () => void;
  tripManualBreaker: (reason: string) => void;
  resetBreaker: () => void;
}

const ProtocolContext = createContext<ProtocolContextType | undefined>(undefined);

export const ProtocolProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { connection } = useConnection();
  const { connected, publicKey, connect, disconnect } = useWallet();
  const [quoteState, setQuoteState] = useState<QuoteState>(EMPTY_QUOTE_STATE);
  const [vaultState, setVaultState] = useState<VaultState>(EMPTY_VAULT_STATE);
  const [riskBreakers, setRiskBreakers] = useState<RiskBreakers>(EMPTY_RISK);
  const [tokens, setTokens] = useState(INITIAL_TOKENS);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [vaultInitialized, setVaultInitialized] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const shareMintRef = useRef<string | null>(null);

  const refreshBalances = useCallback(async () => {
    if (!publicKey) {
      setTokens(INITIAL_TOKENS);
      return;
    }
    setBalancesLoading(true);
    try {
      const { base, quote } = await loadWalletBalances(connection, publicKey);
      let userShares = 0;
      if (shareMintRef.current) {
        try {
          const ata = getAssociatedTokenAddressSync(new PublicKey(shareMintRef.current), publicKey);
          const bal = await connection.getTokenAccountBalance(ata);
          userShares = Number(bal.value.uiAmount ?? 0);
        } catch { /* no share account yet */ }
      }
      setTokens((prev) => ({
        SOL: { ...prev.SOL, balance: Number(base.toFixed(4)) },
        USDC: { ...prev.USDC, balance: Number(quote.toFixed(2)) },
      }));
      setVaultState((prev) => ({ ...prev, userShares }));
    } catch {
      // RPC hiccup: keep the last known balances.
    } finally {
      setBalancesLoading(false);
    }
  }, [connection, publicKey]);

  const refreshProtocol = useCallback(async () => {
    try {
      const [state, slot] = await Promise.all([
        fetchProtocolState(connection),
        connection.getSlot().catch(() => 0),
      ]);
      const now = Math.floor(Date.now() / 1000);
      setVaultInitialized(state.exists);
      setLiveError(null);
      if (state.vaultData) shareMintRef.current = state.vaultData.shareMint.toBase58();
      const quote = toQuoteState(state, slot);
      setQuoteState(quote);
      setRiskBreakers(toRiskBreakers(state, now));
      setTokens((prev) => ({
        SOL: { ...prev.SOL, priceUsd: quote.oraclePrice || prev.SOL.priceUsd },
        USDC: { ...prev.USDC, priceUsd: 1 },
      }));
      let userShares = 0;
      if (publicKey && state.vaultData) {
        try {
          const ata = getAssociatedTokenAddressSync(state.vaultData.shareMint, publicKey);
          const bal = await connection.getTokenAccountBalance(ata);
          userShares = Number(bal.value.uiAmount ?? 0);
        } catch { /* no shares */ }
      }
      setVaultState(toVaultState(state, quote.oraclePrice, userShares));
    } catch (error) {
      setLiveError((error as Error).message?.slice(0, 160) ?? 'RPC error');
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

  // Breaker controls are admin-only on-chain; the UI never forges a trip.
  const tripManualBreaker = (reason: string) => {
    setRiskBreakers((prev) => ({ ...prev, circuitBreakerTripped: true, activeBreakerReason: reason }));
  };
  const resetBreaker = () => {
    setRiskBreakers((prev) => ({ ...prev, circuitBreakerTripped: false, activeBreakerReason: null }));
  };

  return (
    <ProtocolContext.Provider
      value={{
        quoteState,
        vaultState,
        riskBreakers,
        tokens,
        walletConnected: connected,
        walletAddress: publicKey ? publicKey.toBase58() : null,
        balancesLoading,
        vaultInitialized,
        liveError,
        refreshBalances,
        connectWallet,
        disconnectWallet,
        tripManualBreaker,
        resetBreaker,
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
