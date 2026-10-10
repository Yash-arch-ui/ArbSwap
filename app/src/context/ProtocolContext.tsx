import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import type { QuoteState, VaultState, RiskBreakers, Token } from '../types/protocol';
import { INITIAL_QUOTE_STATE, INITIAL_VAULT_STATE, INITIAL_RISK_BREAKERS, TOKENS } from '../data/mockData';
import { loadWalletBalances } from '../chain/solana';

interface ProtocolContextType {
  quoteState: QuoteState;
  vaultState: VaultState;
  riskBreakers: RiskBreakers;
  tokens: { SOL: Token; USDC: Token };
  walletConnected: boolean;
  walletAddress: string | null;
  balancesLoading: boolean;
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
  const [quoteState, setQuoteState] = useState<QuoteState>(INITIAL_QUOTE_STATE);
  const [vaultState] = useState<VaultState>(INITIAL_VAULT_STATE);
  const [riskBreakers, setRiskBreakers] = useState<RiskBreakers>(INITIAL_RISK_BREAKERS);
  const [tokens, setTokens] = useState(TOKENS);
  const [balancesLoading, setBalancesLoading] = useState(false);

  // ---- live wallet balances (SOL / wrapped SOL / USDC) ----------------------
  const refreshBalances = useCallback(async () => {
    if (!publicKey) {
      setTokens(TOKENS);
      return;
    }
    setBalancesLoading(true);
    try {
      const { sol, wsol, usdc } = await loadWalletBalances(connection, publicKey);
      setTokens((prev) => ({
        SOL: { ...prev.SOL, balance: Number(sol.toFixed(4)) },
        USDC: { ...prev.USDC, balance: Number(usdc.toFixed(2)) },
        // `wsol` is exposed through the SOL entry's `mint` account when needed.
      }));
      void wsol;
    } catch {
      // RPC hiccup: keep the last known balances.
    } finally {
      setBalancesLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);

  // ---- model/demo quote ticker (NOT live data; labelled as such in the UI) --
  useEffect(() => {
    const interval = setInterval(() => {
      setQuoteState((prev) => {
        const nextSlot = prev.currentSlot + 1;
        const isExpiring = nextSlot >= prev.expirySlot;
        const randomTick = (Math.random() - 0.49) * 0.04;
        const newOraclePrice = Number((prev.oraclePrice + randomTick).toFixed(2));
        const newResPrice = Number((newOraclePrice * (1 + 0.0002)).toFixed(2));
        return {
          ...prev,
          currentSlot: nextSlot,
          oraclePrice: newOraclePrice,
          reservationPrice: newResPrice,
          oraclePublishTime: Math.floor(Date.now() / 1000),
          status: isExpiring ? 'Aging' : 'Fresh',
          ...(nextSlot % 4 === 0
            ? { version: prev.version + 1, updateSlot: nextSlot, expirySlot: nextSlot + 10, status: 'Fresh' }
            : {}),
        };
      });
      setRiskBreakers((prev) => ({
        ...prev,
        oracleCurrentStalenessSec: Number((0.3 + Math.random() * 0.3).toFixed(1)),
      }));
    }, 400);
    return () => clearInterval(interval);
  }, []);

  const connectWallet = () => {
    void connect().catch(() => undefined);
  };

  const disconnectWallet = () => {
    void disconnect().catch(() => undefined);
  };

  const tripManualBreaker = (reason: string) => {
    setRiskBreakers((prev) => ({
      ...prev,
      circuitBreakerTripped: true,
      activeBreakerReason: reason,
    }));
  };

  const resetBreaker = () => {
    setRiskBreakers((prev) => ({
      ...prev,
      circuitBreakerTripped: false,
      activeBreakerReason: null,
    }));
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
