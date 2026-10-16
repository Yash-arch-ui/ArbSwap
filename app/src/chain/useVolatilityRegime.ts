// Read the on-chain volatility regime for the Risk page. The read is classified
// (never conflating a transport failure with an absent account) and the derived
// view is pure integer math. Before the PDA exists, or when its observation is
// stale, the caller must show an "awaiting verified observation" state — never a
// keeper-local fallback.
import { useEffect, useRef, useState } from 'react';
import { APP_RPC_FAILOVER } from './rpcFailover';
import {
  readVolatility,
  volatilityView,
  type OnChainVolatility,
  type VolatilityReadResult,
  type VolatilityView,
} from './volatility';

export type VolatilityStatus = 'loading' | 'ready' | 'absent' | 'error';

export interface VolatilityRegime {
  status: VolatilityStatus;
  state: OnChainVolatility | null;
  view: VolatilityView | null;
  error: string | null;
}

const POLL_MS = 8_000;

export function useVolatilityRegime(currentSlot: number, minSpreadBps = 0): VolatilityRegime {
  const [result, setResult] = useState<VolatilityReadResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const slotRef = useRef(currentSlot);
  slotRef.current = currentSlot;

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await APP_RPC_FAILOVER.runKeyed('readVolatility', (c) => readVolatility(c));
        if (cancelled) return;
        setResult(r);
        setFailed(r.kind === 'rpc_error' ? r.reason : null);
      } catch (error) {
        if (cancelled) return;
        setFailed(error instanceof Error ? error.message : String(error));
      }
    };
    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (failed && (!result || result.kind === 'rpc_error')) {
    return { status: 'error', state: null, view: null, error: failed };
  }
  if (!result) return { status: 'loading', state: null, view: null, error: null };
  if (result.kind === 'not_found') {
    return { status: 'absent', state: null, view: null, error: null };
  }
  if (result.kind === 'invalid') {
    return { status: 'error', state: null, view: null, error: result.reason };
  }
  if (result.kind === 'rpc_error') {
    return { status: 'error', state: null, view: null, error: result.reason };
  }
  return {
    status: 'ready',
    state: result.state,
    view: volatilityView(result.state, slotRef.current, minSpreadBps),
    error: null,
  };
}
