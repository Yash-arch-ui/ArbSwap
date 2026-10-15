// @ts-nocheck -- local assertion script (node: types not installed here).
// S2-42: regression tests for stale encoded-VAA reclamation. Deterministic, no
// network. Covers ownership filtering, in-flight safety, the grace window,
// cleanup-failure tolerance, discovery failure, and the per-pass cap.
import assert from "node:assert/strict";
import {
  selectReclaimable,
  reclaimStaleVaas,
  ENCODED_VAA_RENT_LAMPORTS,
} from "./keeper_reclaim";

let n = 0;
const check = (name, cond) => {
  n += 1;
  assert.ok(cond, `case failed: ${name}`);
  console.log(`ok ${n} - ${name}`);
};

const A = "VaaAAAA";
const B = "VaaBBBB";
const C = "VaaCCCC";

// --- ownership: only `owned` addresses are eligible; unknown tracked entries are ignored ---
{
  const owned = [A];
  const firstSeen = new Map([[A, 0], [B, 0]]); // B tracked but not owned
  const got = selectReclaimable({ owned, firstSeenMs: firstSeen, nowMs: 1000, graceMs: 10, active: new Set() });
  check("only owned addresses are selected", got.length === 1 && got[0] === A);
}

// --- grace window: too-young excluded, old included ---
{
  const owned = [A, B];
  const firstSeen = new Map([[A, 1000], [B, 1000]]);
  const fresh = selectReclaimable({ owned, firstSeenMs: firstSeen, nowMs: 1500, graceMs: 1000, active: new Set() });
  check("young accounts are not reclaimed", fresh.length === 0);
  const old = selectReclaimable({ owned, firstSeenMs: firstSeen, nowMs: 2500, graceMs: 1000, active: new Set() });
  check("aged accounts are reclaimed", old.length === 2);
}

// --- in-flight safety: an active address is never reclaimed even when old ---
{
  const owned = [A, B];
  const firstSeen = new Map([[A, 0], [B, 0]]);
  const got = selectReclaimable({ owned, firstSeenMs: firstSeen, nowMs: 10_000, graceMs: 1000, active: new Set([A]) });
  check("in-flight address is skipped", got.length === 1 && got[0] === B);
}

// --- reclaimStaleVaas: first observation seeds; nothing is closed before grace ---
{
  const firstSeen = new Map();
  const closed = [];
  let now = 0;
  const deps = {
    findOwned: async () => [A],
    closeAccounts: async (addrs) => { closed.push(...addrs); return { closed: addrs, failed: [] }; },
    firstSeenMs: firstSeen,
    active: new Set(),
    nowMs: () => now,
    graceMs: 1000,
    log: () => {},
  };
  const r1 = await reclaimStaleVaas(deps);
  check("first pass seeds and closes nothing", r1.closed === 0 && r1.owned === 1 && firstSeen.get(A) === 0);
  now = 999;
  const r2 = await reclaimStaleVaas(deps);
  check("still inside grace: no close", r2.closed === 0 && closed.length === 0);
  now = 1000;
  const r3 = await reclaimStaleVaas(deps);
  check("after grace: closed once", r3.closed === 1 && closed.length === 1 && r3.rentRecoveredLamports === ENCODED_VAA_RENT_LAMPORTS);
  check("closed account leaves the ledger", !firstSeen.has(A));
}

// --- cleanup failure: a failing close is reported but does not stop the others ---
{
  const firstSeen = new Map([[A, 0], [B, 0], [C, 0]]);
  const closed = [];
  const r = await reclaimStaleVaas({
    findOwned: async () => [A, B, C],
    closeAccounts: async (addrs) => {
      const ok = addrs.filter((a) => a !== B);
      closed.push(...ok);
      return { closed: ok, failed: addrs.filter((a) => a === B) };
    },
    firstSeenMs: firstSeen,
    active: new Set(),
    nowMs: () => 10_000,
    graceMs: 1000,
    log: () => {},
  });
  check("failed close counted", r.attempted === 3 && r.failed === 1 && r.closed === 2);
  check("other accounts still closed", closed.includes(A) && closed.includes(C) && !closed.includes(B));
  check("failed account stays in the ledger for retry", firstSeen.has(B));
}

// --- a thrown batch close is contained (all-failed, never crashes the caller) ---
{
  const firstSeen = new Map([[A, 0]]);
  const r = await reclaimStaleVaas({
    findOwned: async () => [A],
    closeAccounts: async () => { throw new Error("tx failed"); },
    firstSeenMs: firstSeen,
    active: new Set(),
    nowMs: () => 10_000,
    graceMs: 1000,
    log: () => {},
  });
  check("thrown batch close is counted as failed", r.closed === 0 && r.failed === 1 && firstSeen.has(A));
}

// --- in-flight safety end-to-end through reclaimStaleVaas ---
{
  const firstSeen = new Map([[A, 0]]);
  let closed = 0;
  const r = await reclaimStaleVaas({
    findOwned: async () => [A],
    closeAccounts: async (addrs) => { closed += addrs.length; return { closed: addrs, failed: [] }; },
    firstSeenMs: firstSeen,
    active: new Set([A]),
    nowMs: () => 10_000,
    graceMs: 1000,
    log: () => {},
  });
  check("active account is not closed", closed === 0 && r.attempted === 0);
}

// --- discovery failure is contained (never throws, zero result) ---
{
  const r = await reclaimStaleVaas({
    findOwned: async () => { throw new Error("rpc down"); },
    closeAccounts: async (addrs) => ({ closed: addrs, failed: [] }),
    firstSeenMs: new Map(),
    active: new Set(),
    nowMs: () => 0,
    graceMs: 1000,
    log: () => {},
  });
  check("discovery failure is contained", r.owned === 0 && r.closed === 0 && r.failed === 0);
}

// --- per-pass cap bounds how many accounts are closed in one pass ---
{
  const owned = ["V0", "V1", "V2", "V3", "V4"];
  const firstSeen = new Map(owned.map((a) => [a, 0]));
  const closed = [];
  const r = await reclaimStaleVaas({
    findOwned: async () => owned,
    closeAccounts: async (addrs) => { closed.push(...addrs); return { closed: addrs, failed: [] }; },
    firstSeenMs: firstSeen,
    active: new Set(),
    nowMs: () => 10_000,
    graceMs: 1000,
    maxPerPass: 2,
    log: () => {},
  });
  check("per-pass cap limits closes", r.attempted === 2 && closed.length === 2 && r.owned === 5);
}

console.log(`\n${n} reclaim cases passed`);
