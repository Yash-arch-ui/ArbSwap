// S2-37/Issue D: pure freshness summariser for the read-only monitor.
//
// The deployed `QuoteState` freshness rule is `version > 0 && slot < expiry_slot`
// — an *unexpired* quote. That is not the same as a *fresh oracle*: the program
// does not re-check the Pyth age at swap, so a quote can be unexpired while the
// price it encodes is older than `max_staleness_seconds`. This module reports
// both the sample fraction (the historical metric) and a wall-clock
// time-weighted fraction, plus the maximum oracle age seen on fresh samples, so
// the distinction is visible rather than hidden.
//
// No network, no secrets, no transactions — safe to unit test.

export interface FreshSample {
  /** Wall-clock ms when the sample was taken. */
  t: number;
  /** `version > 0 && slot < expiry_slot`. */
  fresh: boolean;
  version: bigint;
  slot: number;
  expirySlot: number;
  /** Wall-clock age of the committed oracle price at sample time, ms. */
  oracleAgeMs: number | null;
}

export interface FreshSummary {
  samples: number;
  fresh: number;
  fresh_fraction: number;
  fresh_fraction_time_weighted: number;
  fresh_ms: number;
  observed_ms: number;
  effective_interval_ms: number;
  longest_stale_ms: number;
  commits_observed: number;
  last_version: string;
  versions_with_fresh_samples: number;
  max_oracle_age_ms: number | null;
  decision: "green" | "amber" | "red";
  decision_time_weighted: "green" | "amber" | "red";
}

export const GREEN_MIN = 0.8;
export const AMBER_MIN = 0.5;

export function decide(fraction: number): "green" | "amber" | "red" {
  return fraction >= GREEN_MIN ? "green" : fraction >= AMBER_MIN ? "amber" : "red";
}

/**
 * Summarise samples taken over `[firstSample, endMs]`. Each sample's state is
 * assumed to hold until the next sample (and the last until `endMs`), giving a
 * wall-clock time-weighted fraction that is not biased by RPC latency changing
 * the effective sampling period.
 */
export function summarise(samples: FreshSample[], endMs: number): FreshSummary {
  const n = samples.length;
  if (n === 0) {
    return {
      samples: 0, fresh: 0, fresh_fraction: 0, fresh_fraction_time_weighted: 0,
      fresh_ms: 0, observed_ms: 0, effective_interval_ms: 0, longest_stale_ms: 0,
      commits_observed: 0, last_version: "-1", versions_with_fresh_samples: 0,
      max_oracle_age_ms: null, decision: "red", decision_time_weighted: "red",
    };
  }

  let fresh = 0;
  let freshMs = 0;
  let longestStaleMs = 0;
  let staleRun = 0;
  let commits = 0;
  let lastVersion = -1n;
  let maxOracleAge: number | null = null;
  const versionFresh = new Map<string, number>();

  for (let i = 0; i < n; i += 1) {
    const s = samples[i];
    if (s.fresh) {
      fresh += 1;
      versionFresh.set(s.version.toString(), (versionFresh.get(s.version.toString()) ?? 0) + 1);
      if (s.oracleAgeMs != null) maxOracleAge = Math.max(maxOracleAge ?? 0, s.oracleAgeMs);
    }
    if (lastVersion !== -1n && s.version !== lastVersion) commits += 1;
    lastVersion = s.version;

    // Attribute the interval from this sample to the next (or to the window end
    // for the final sample) to this sample's state.
    const nextT = i + 1 < n ? samples[i + 1].t : endMs;
    const dt = Math.max(0, nextT - s.t);
    if (s.fresh) {
      freshMs += dt;
      staleRun = 0;
    } else {
      staleRun += dt;
      longestStaleMs = Math.max(longestStaleMs, staleRun);
    }
  }

  const observedMs = Math.max(0, endMs - samples[0].t);
  const fraction = fresh / n;
  const timeWeighted = observedMs > 0 ? freshMs / observedMs : fraction;
  return {
    samples: n,
    fresh,
    fresh_fraction: Number(fraction.toFixed(3)),
    fresh_fraction_time_weighted: Number(timeWeighted.toFixed(3)),
    fresh_ms: freshMs,
    observed_ms: observedMs,
    effective_interval_ms: Math.round(observedMs / Math.max(1, n - 1)) || 0,
    longest_stale_ms: Math.round(longestStaleMs),
    commits_observed: commits,
    last_version: lastVersion.toString(),
    versions_with_fresh_samples: versionFresh.size,
    max_oracle_age_ms: maxOracleAge == null ? null : Math.round(maxOracleAge),
    decision: decide(fraction),
    decision_time_weighted: decide(timeWeighted),
  };
}
