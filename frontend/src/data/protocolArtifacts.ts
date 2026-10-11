import manifestData from '../artifacts/manifest.json';
import headlineData from '../artifacts/headline.json';
import cuData from '../artifacts/cu.json';
import envelopeData from '../artifacts/envelope.json';
import heldOutData from '../artifacts/held_out.json';
import thesisData from '../artifacts/thesis.json';
import e8ProxyData from '../artifacts/e8_proxy.json';

export interface ProtocolManifest {
  commit: string;
  shortCommit: string;
  generated: string;
  flowType: string;
  schemaVersion: string;
}

export interface HeadlineMetrics {
  cuUpdateQuote: number;
  cuSwap: number;
  solPrice: number;
  bestMarkoutBps: number;
  targetMarkoutBps: number;
  bestHalfSpreadBps: number;
  targetHalfSpreadBps: number;
  calibratedWindow: string;
  routedVolumeShare: number;
  routedFillShare: number;
  routedMarkout2sBps: number;
  e1LvrReductionAvgPct: number;
}

export interface InstructionCu {
  name: string;
  computeUnits: number;
}

export interface HeldOutWindow {
  window: string;
  regime: string;
  arbSwapHedgedPnl: number;
  arbSwapMarkout2sBps: number;
  arbSwapQuietHalfSpreadBps: number;
  arbSwapFillRate: number;
  b1QuietHalfSpreadBps?: number;
  e1LvrReductionPct?: number;
}

export interface EnvelopeRow {
  regime: string;
  vault_fee_bps: number;
  prop_half_spread_bps: number;
  arb_volume_share: number;
  arb_markout_2s_bps: number;
  deploy_ok: boolean;
}

export const PROTOCOL_MANIFEST: ProtocolManifest = {
  commit: manifestData.commit,
  shortCommit: manifestData.commit.slice(0, 7),
  generated: (manifestData as { generated?: string }).generated || '2026-10-09',
  flowType: manifestData.flow_type,
  schemaVersion: manifestData.schema_version,
};

export const HEADLINE_METRICS: HeadlineMetrics = {
  cuUpdateQuote: headlineData.cost.cu_update_quote, // 48,209
  cuSwap: headlineData.cost.cu_swap,                 // 59,327
  solPrice: headlineData.cost.sol_price,             // 150.0
  bestMarkoutBps: Number(headlineData.calibration.best_markout_bps.toFixed(3)),
  targetMarkoutBps: headlineData.calibration.target_markout_bps,
  bestHalfSpreadBps: Number(headlineData.calibration.best_half_spread_bps.toFixed(2)),
  targetHalfSpreadBps: headlineData.calibration.target_half_spread_bps,
  calibratedWindow: headlineData.calibration.window,
  routedVolumeShare: headlineData.routed_world.rows[0]?.volume_share ?? 0.0,
  routedFillShare: headlineData.routed_world.rows[0]?.fill_share ?? 0.016,
  routedMarkout2sBps: headlineData.routed_world.rows[0]?.markout_2s_bps ?? 1.99,
  e1LvrReductionAvgPct: 627.6, // W2-W4 empirical average
};

export const INSTRUCTION_CU_LIST: InstructionCu[] = Object.entries(cuData.instructions).map(
  ([name, computeUnits]) => ({
    name: name.replace(/_/g, ' '),
    computeUnits: computeUnits as number,
  })
).sort((a, b) => b.computeUnits - a.computeUnits);

export const HELD_OUT_WINDOWS: HeldOutWindow[] = Object.entries(heldOutData).map(([winKey, val]) => {
  const win = val as {
    regime: string;
    venues: {
      ArbSwap?: {
        hedged_pnl: number;
        markout_2s_bps: number;
        quiet_half_spread_bps: number;
        gap_bps: number;
        fill_rate: number;
      };
      B1?: {
        quiet_half_spread_bps: number;
      };
    };
  };
  const arb = win.venues.ArbSwap;
  const b1 = win.venues.B1;
  const e1Info = (headlineData.e1_e4 as Record<string, { E1_pct?: number }>)[winKey];

  return {
    window: winKey,
    regime: win.regime,
    arbSwapHedgedPnl: arb ? Math.round(arb.hedged_pnl) : 0,
    arbSwapMarkout2sBps: arb ? Number(arb.markout_2s_bps.toFixed(2)) : 0,
    arbSwapQuietHalfSpreadBps: arb ? Number(arb.quiet_half_spread_bps.toFixed(2)) : 0,
    arbSwapFillRate: arb ? Number((arb.fill_rate * 100).toFixed(1)) : 0,
    b1QuietHalfSpreadBps: b1 ? Number(b1.quiet_half_spread_bps.toFixed(2)) : undefined,
    e1LvrReductionPct: e1Info?.E1_pct ? Math.round(e1Info.E1_pct) : undefined,
  };
});

export const E8_PROXY_STATUS = {
  kind: e8ProxyData.kind,
  samples: e8ProxyData.samples,
  ok: e8ProxyData.ok,
  changeRate: e8ProxyData.change_rate,
};

export const THESIS_DECISION = thesisData.decision || 'Option 1 not shown';

export const OPERATING_ENVELOPE_SAMPLES: EnvelopeRow[] = (envelopeData as EnvelopeRow[]).slice(0, 10);
