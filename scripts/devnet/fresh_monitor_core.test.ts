// @ts-nocheck -- local assertion script (node: types not installed here).
// Issue D local test for the fresh-quote summariser. No network, no secrets.
// Run: npx tsx fresh_monitor_core.test.ts
import assert from "node:assert/strict";
import { summarise, decide, type FreshSample } from "./fresh_monitor_core";

let n = 0;
const check = (name: string, cond: boolean) => {
  n += 1;
  assert.ok(cond, `case failed: ${name}`);
  console.log(`ok ${n} - ${name}`);
};

const s = (t: number, fresh: boolean, version: number, slot: number, expiry: number): FreshSample => ({
  t, fresh, version: BigInt(version), slot, expirySlot: expiry, oracleAgeMs: fresh ? 1000 : null,
});

// Two fresh then two stale samples, 1s apart, window ends at the last sample.
const samples = [
  s(0, true, 1, 10, 20),
  s(1000, true, 1, 11, 20),
  s(2000, false, 1, 21, 20),
  s(3000, false, 1, 22, 20),
];
const r = summarise(samples, 3000);
check("sample count", r.samples === 4);
check("sample fraction is 2/4", r.fresh_fraction === 0.5);
// Fresh state held t=0..2000 (2000 ms), observed window 0..3000 => 0.667.
check("time-weighted counts the fresh-held interval", Math.abs(r.fresh_fraction_time_weighted - 0.667) < 0.01);
check("observed window", r.observed_ms === 3000);
check("effective interval", r.effective_interval_ms === 1000);
check("longest stale run", r.longest_stale_ms === 1000);
check("only one version", r.commits_observed === 0 && r.last_version === "1");
check("max oracle age surfaced", r.max_oracle_age_ms === 1000);

// A version change is counted as a commit.
const changed = summarise([s(0, true, 1, 10, 20), s(1000, true, 2, 11, 20)], 1000);
check("version change counts as a commit", changed.commits_observed === 1);
check("versions with fresh samples", changed.versions_with_fresh_samples === 2);

// Empty input is red, never fabricated.
const empty = summarise([], 5000);
check("empty is red", empty.samples === 0 && empty.decision === "red" && empty.fresh_fraction === 0);

// Decision thresholds.
check("green at 0.8", decide(0.8) === "green");
check("amber at 0.5", decide(0.5) === "amber");
check("red below 0.5", decide(0.49) === "red");

// Sample-fraction and time-weighted decisions can diverge; both are reported.
const skewed = summarise([s(0, true, 1, 10, 20), s(100, false, 1, 21, 20), s(200, true, 1, 12, 20)], 10_000);
check("reports both decisions", typeof skewed.decision === "string" && typeof skewed.decision_time_weighted === "string");

console.log(`\nfresh_monitor_core: ${n} checks passed`);
