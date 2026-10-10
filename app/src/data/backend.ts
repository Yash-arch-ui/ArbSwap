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
  T_A: { T_A_holds: boolean; T_A_i_real_flow_ci: { met: boolean; reason: string } };
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
