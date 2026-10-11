import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import type { QuoteState, VaultState, RiskBreakers, Token } from '../types/protocol';
import { INITIAL_QUOTE_STATE, INITIAL_VAULT_STATE, INITIAL_RISK_BREAKERS, TOKENS } from '../data/mockData';
import {
  PROTOCOL_MANIFEST,
  HEADLINE_METRICS,
  INSTRUCTION_CU_LIST,
  HELD_OUT_WINDOWS,
  E8_PROXY_STATUS,
  THESIS_DECISION,
  type ProtocolManifest,
  type HeadlineMetrics,
  type InstructionCu,
  type HeldOutWindow,
} from '../data/protocolArtifacts';
import { fetchLiveDevnetState, loadWalletBalances, ARBSWAP_CHAIN_CONFIG } from '../chain/solana';

export type MarketRegime = 'calm' | 'trend' | 'jump' | 'crash';

export interface SwapRecord {
  id: string;
  timestamp: number;
  inSymbol: 'SOL' | 'USDC';
  outSymbol: 'SOL' | 'USDC';
  inAmount: number;
  outAmount: number;
  price: number;
  slot: number;
  sig: string;
  isSimulated: boolean;
}

interface ProtocolContextType {
  quoteState: QuoteState;
  vaultState: VaultState;
  riskBreakers: RiskBreakers;
  tokens: { SOL: Token; USDC: Token };
  walletConnected: boolean;
  walletAddress: string | null;
  currentRegime: MarketRegime;
  isLiveDevnet: boolean;
  balancesLoading: boolean;
  refreshBalances: () => Promise<void>;
  manifest: ProtocolManifest;
  headline: HeadlineMetrics;
  instructionCu: InstructionCu[];
  heldOutWindows: HeldOutWindow[];
  e8Proxy: typeof E8_PROXY_STATUS;
  thesisDecision: string;
  chainConfig: typeof ARBSWAP_CHAIN_CONFIG;
  recentSwaps: SwapRecord[];
  setRegime: (regime: MarketRegime) => void;
  connectWallet: () => void;
  disconnectWallet: () => void;
  tripManualBreaker: (reason: string) => void;
  resetBreaker: () => void;
  executeSwap: (params: {
    side: 'buyBase' | 'sellBase';
    inAmount: number;
    outAmount: number;
    inSymbol: 'SOL' | 'USDC';
    outSymbol: 'SOL' | 'USDC';
    price: number;
    isSimulated: boolean;
    txSignature?: string;
  }) => Promise<{ txHash: string; slot: number }>;
}

const ProtocolContext = createContext<ProtocolContextType | undefined>(undefined);

export const ProtocolProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { connection } = useConnection();
  const { connected, publicKey, connect, disconnect } = useWallet();
  const [quoteState, setQuoteState] = useState<QuoteState>(INITIAL_QUOTE_STATE);
  const [vaultState, setVaultState] = useState<VaultState>(INITIAL_VAULT_STATE);
  const [riskBreakers, setRiskBreakers] = useState<RiskBreakers>(INITIAL_RISK_BREAKERS);
  const [tokens, setTokens] = useState(TOKENS);
  const [currentRegime, setCurrentRegime] = useState<MarketRegime>('calm');
  const [isLiveDevnet, setIsLiveDevnet] = useState<boolean>(false);
  const [recentSwaps, setRecentSwaps] = useState<SwapRecord[]>([]);
  const [balancesLoading, setBalancesLoading] = useState(false);

  // ── Live wallet balances (SOL / USDC) ────────────────────────────────────────
  const refreshBalances = useCallback(async () => {
    if (!publicKey) {
      setTokens(TOKENS); // reset to defaults when disconnected
      return;
    }
    setBalancesLoading(true);
    try {
      const { sol, wsol, usdc } = await loadWalletBalances(connection, publicKey);
      void wsol; // wsol exposed via WSOL_MINT ATA when needed
      setTokens((prev) => ({
        SOL: { ...prev.SOL, balance: Number(sol.toFixed(4)) },
        USDC: { ...prev.USDC, balance: Number(usdc.toFixed(2)) },
      }));
    } catch {
      // RPC hiccup — keep last known balances
    } finally {
      setBalancesLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);

  // ── Poll Live Devnet On-chain State ────────────────────────────────────────
  useEffect(() => {
    let mounted = true;

    async function syncDevnet() {
      const live = await fetchLiveDevnetState();
      if (!mounted) return;

      if (live.isLive) {
        setIsLiveDevnet(true);
        if (Object.keys(live.quotePartial).length > 0) {
          setQuoteState((prev) => ({
            ...prev,
            ...live.quotePartial,
            currentSlot: live.slot,
          }));
        }
        if (Object.keys(live.vaultPartial).length > 0) {
          setVaultState((prev) => ({
            ...prev,
            ...live.vaultPartial,
          }));
        }
      }
    }

    syncDevnet();
    const timer = setInterval(syncDevnet, 4000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  // ── Microstructure Tick Simulation (Slot & Volatility Rhythm) ──────────────
  useEffect(() => {
    const interval = setInterval(() => {
      setQuoteState((prev) => {
        const nextSlot = prev.currentSlot + 1;
        const isExpiring = nextSlot >= prev.expirySlot;

        // Apply regime-specific behavior
        let tickMultiplier = 0.04;
        let skew = 0;
        if (currentRegime === 'trend') {
          tickMultiplier = 0.15;
          skew = 0.08; // upward drift
        } else if (currentRegime === 'jump') {
          tickMultiplier = 0.45;
          skew = -0.25; // sharp adverse move
        } else if (currentRegime === 'crash') {
          tickMultiplier = 0.85;
          skew = -0.60;
        }

        const randomTick = (Math.random() - 0.49 + skew) * tickMultiplier;
        const newOraclePrice = Number(Math.max(10, prev.oraclePrice + randomTick).toFixed(2));
        const newResPrice = Number((newOraclePrice * (1 + 0.0002)).toFixed(2));

        const autoRoll = nextSlot % 6 === 0;

        return {
          ...prev,
          currentSlot: nextSlot,
          oraclePrice: newOraclePrice,
          reservationPrice: newResPrice,
          oraclePublishTime: Math.floor(Date.now() / 1000),
          status: isExpiring ? 'Aging' : 'Fresh',
          ...(autoRoll ? {
            version: prev.version + 1,
            updateSlot: nextSlot,
            expirySlot: nextSlot + 12,
            status: 'Fresh',
          } : {})
        };
      });

      setRiskBreakers((prev) => ({
        ...prev,
        oracleCurrentStalenessSec: Number((0.2 + Math.random() * 0.4).toFixed(1)),
      }));
    }, 450);

    return () => clearInterval(interval);
  }, [currentRegime]);

  // ── Interactive Regime Switcher (Step 4) ───────────────────────────────────
  const setRegime = useCallback((regime: MarketRegime) => {
    setCurrentRegime(regime);
    setQuoteState((prev) => {
      if (regime === 'calm') {
        return {
          ...prev,
          halfSpreadBps: 1.8,
          depthMultBps: 9200,
          shortVolBps: 12.4,
          mediumVolBps: 10.8,
        };
      } else if (regime === 'trend') {
        return {
          ...prev,
          halfSpreadBps: 3.2,
          depthMultBps: 7600,
          shortVolBps: 24.8,
          mediumVolBps: 18.2,
        };
      } else if (regime === 'jump') {
        return {
          ...prev,
          halfSpreadBps: 8.5,
          depthMultBps: 4200, // throttled depth protects LPs
          shortVolBps: 58.2,
          mediumVolBps: 32.0,
          oraclePrice: Number((prev.oraclePrice * 1.018).toFixed(2)),
        };
      } else {
        // crash
        return {
          ...prev,
          halfSpreadBps: 18.0,
          depthMultBps: 1800, // sharp capacity contraction
          shortVolBps: 94.5,
          mediumVolBps: 64.0,
          oraclePrice: Number((prev.oraclePrice * 0.92).toFixed(2)),
        };
      }
    });
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

  const executeSwap = async (params: {
    side: 'buyBase' | 'sellBase';
    inAmount: number;
    outAmount: number;
    inSymbol: 'SOL' | 'USDC';
    outSymbol: 'SOL' | 'USDC';
    price: number;
    isSimulated: boolean;
    txSignature?: string;
  }) => {
    const { inAmount, outAmount, inSymbol, outSymbol, price, isSimulated, txSignature } = params;

    // Deduct inAmount, add outAmount to local balances
    setTokens((prev) => ({
      ...prev,
      [inSymbol]: {
        ...prev[inSymbol],
        balance: Math.max(0, Number((prev[inSymbol].balance - inAmount).toFixed(4))),
      },
      [outSymbol]: {
        ...prev[outSymbol],
        balance: Number((prev[outSymbol].balance + outAmount).toFixed(4)),
      },
    }));

    // Update vault reserves slightly to simulate active inventory rebalancing
    setVaultState((prev) => {
      const isSellingSol = inSymbol === 'SOL';
      return {
        ...prev,
        baseReserve: isSellingSol
          ? Number((prev.baseReserve + inAmount).toFixed(4))
          : Math.max(100, Number((prev.baseReserve - outAmount).toFixed(4))),
        quoteReserve: isSellingSol
          ? Math.max(100, Number((prev.quoteReserve - outAmount).toFixed(2)))
          : Number((prev.quoteReserve + inAmount).toFixed(2)),
      };
    });

    const txHash = txSignature || `devnet_sim_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
    const slot = quoteState.currentSlot;

    const record: SwapRecord = {
      id: txHash,
      timestamp: Date.now(),
      inSymbol,
      outSymbol,
      inAmount,
      outAmount,
      price,
      slot,
      sig: txHash,
      isSimulated,
    };

    setRecentSwaps((prev) => [record, ...prev.slice(0, 9)]);

    return { txHash, slot };
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
        currentRegime,
        isLiveDevnet,
        balancesLoading,
        refreshBalances,
        manifest: PROTOCOL_MANIFEST,
        headline: HEADLINE_METRICS,
        instructionCu: INSTRUCTION_CU_LIST,
        heldOutWindows: HELD_OUT_WINDOWS,
        e8Proxy: E8_PROXY_STATUS,
        thesisDecision: THESIS_DECISION,
        chainConfig: ARBSWAP_CHAIN_CONFIG,
        recentSwaps,
        setRegime,
        connectWallet,
        disconnectWallet,
        tripManualBreaker,
        resetBreaker,
        executeSwap,
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
