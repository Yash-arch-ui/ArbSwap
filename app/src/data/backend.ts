import { useEffect, useState } from 'react';

/**
 * Frontend integration with the backend artifact bundle (`artifacts/public`).
 * The JSON files are served from `/artifacts/*.json` (copied from the repo
 * `artifacts/public` by the deploy). All numbers here are the backend's real
 * model/evaluation outputs, not mock values.
 */

export interface HeadlineData {
  meta: { commit: string; short: string; date: string; flow_type: string };
  calibration: Record<string, number | null>;
  routed_world: RoutedWorld;
  e1_e4: Record<string, Record<string, number | null>>;
  cost: Record<string, number>;
}

export interface RoutedRow {
  venue: string;
  volume_share: number;
  fill_share: number;
  markout_2s_bps: number;
}

export interface RoutedWorld {
  source: string | null;
  rows: RoutedRow[];
}

export interface HeldOutWindow {
  dates: string;
  regime: string;
  sigma_per_sqrt_s: number | null;
  venues: Record<string, {
    hedged_pnl: number;
    markout_2s_bps: number;
    quiet_half_spread_bps: number;
    gap_bps: number;
    fill_rate: number;
    trades: number;
  }>;
}

export interface ThesisData {
  decision: string;
  T_A: {
    T_A_holds: boolean;
    T_A_i_real_flow_ci: { met: boolean; reason: string };
    T_A_iii_noprop_share_ge_10pct?: { met: boolean; share: number };
  };
  T_B: Record<string, Record<string, { volume_share: number }>>;
}

export interface BackendData {
  headline: HeadlineData | null;
  heldOut: Record<string, HeldOutWindow> | null;
  routed: RoutedWorld | null;
  thesis: ThesisData | null;
  testCounts: { rust: number; python: number } | null;
  mutation: { total: number; caught: number } | null;
  loading: boolean;
  error: string | null;
}

async function getJson<T>(name: string): Promise<T | null> {
  try {
    const res = await fetch(`/artifacts/${name}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function useBackend(): BackendData {
  const [data, setData] = useState<BackendData>({
    headline: null, heldOut: null, routed: null, thesis: null,
    testCounts: null, mutation: null, loading: true, error: null,
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      const [headline, heldOut, routed, thesis, testCounts, mutation] = await Promise.all([
        getJson<HeadlineData>('headline.json'),
        getJson<Record<string, HeldOutWindow>>('held_out.json'),
        getJson<RoutedWorld>('routed_world.json'),
        getJson<ThesisData>('thesis.json'),
        getJson<{ rust: number; python: number }>('test_counts.json'),
        getJson<{ total: number; caught: number }>('mutation.json'),
      ]);
      if (alive) {
        setData({ headline, heldOut, routed, thesis, testCounts, mutation, loading: false, error: null });
      }
    })();
    return () => { alive = false; };
  }, []);

  return data;
}

/** Equal-weighted mean of a per-window venue metric from `held_out.json`. */
export function meanVenueMetric(
  heldOut: Record<string, HeldOutWindow> | null,
  venue: string,
  metric: keyof HeldOutWindow['venues'][string],
): number | null {
  if (!heldOut) return null;
  const values = Object.values(heldOut)
    .map((w) => w.venues?.[venue]?.[metric])
    .filter((v): v is number => typeof v === 'number');
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Real, provenance-labelled model metrics derived from the published artifact
 * bundle (`app/public/artifacts/*`). These are OFFLINE MODEL/REPLAY outputs, not
 * live on-chain observations, and every field is `null` when the corresponding
 * artifact is unavailable so callers can render an honest "Unavailable".
 */
export interface ModelMetrics {
  /** W2–W6 mean 2-second markout (bps), ArbSwap vs passive B1 (`held_out.json`). */
  arbMarkout2sBps: number | null;
  b1Markout2sBps: number | null;
  /** `cu.json` median CU per instruction. */
  cuUpdateQuote: number | null;
  cuSwap: number | null;
  /** `cu_swap / cu_update_quote` (how many reprice updates one swap costs). */
  cuRatio: number | null;
  /** No-propAMM routed volume share for ArbSwap (`thesis.json` T-A.iii). */
  noPropAmmVolumeShare: number | null;
  /** Model decision string (`thesis.json`). */
  thesisDecision: string | null;
  /** Provenance for the whole bundle (`headline.json` meta). */
  meta: HeadlineData['meta'] | null;
}

export function deriveModelMetrics(data: {
  headline: HeadlineData | null;
  heldOut: Record<string, HeldOutWindow> | null;
  thesis: ThesisData | null;
}): ModelMetrics {
  const cuUpdateQuote = data.headline?.cost?.cu_update_quote ?? null;
  const cuSwap = data.headline?.cost?.cu_swap ?? null;
  const share = data.thesis?.T_A?.T_A_iii_noprop_share_ge_10pct;
  return {
    arbMarkout2sBps: meanVenueMetric(data.heldOut, 'ArbSwap', 'markout_2s_bps'),
    b1Markout2sBps: meanVenueMetric(data.heldOut, 'B1_passive', 'markout_2s_bps'),
    cuUpdateQuote,
    cuSwap,
    cuRatio: cuUpdateQuote && cuSwap ? cuSwap / cuUpdateQuote : null,
    noPropAmmVolumeShare:
      share && typeof (share as { share?: number }).share === 'number'
        ? (share as { share: number }).share
        : null,
    thesisDecision: data.thesis?.decision ?? null,
    meta: data.headline?.meta ?? null,
  };
}

/** Convenience hook: real model metrics from the artifact bundle. */
export function useModelMetrics(): ModelMetrics {
  const backend = useBackend();
  return deriveModelMetrics(backend);
}
