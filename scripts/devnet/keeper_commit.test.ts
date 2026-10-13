// @ts-nocheck -- local assertion script; `node:` types are not installed here.
// S2-18 local test for the keeper commit-result classifier.
// Run: npx tsx keeper_commit.test.ts   (no network, no transactions, no secrets)
import assert from "node:assert/strict";
import { classifyCommit, isSuccess, backoffDelayMs, type CommitObservation } from "./keeper_commit";

const base: CommitObservation = {
  signature: "sig",
  txFound: true,
  txErr: null,
  prevVersion: 18n,
  newVersion: 19n,
  currentSlot: 1_000n,
  expirySlot: 1_010n,
};

let n = 0;
function check(name: string, cond: boolean) {
  n += 1;
  assert.ok(cond, `case failed: ${name}`);
  console.log(`ok ${n} - ${name}`);
}

// The exact S2-16B defects:
check("stale existing version is NOT success", !isSuccess(classifyCommit({ ...base, newVersion: 18n }).state));
check("missing getTransaction is NOT success", classifyCommit({ ...base, txFound: false }).state === "UNOBSERVED");
check("submission without observation is NOT success", !isSuccess(classifyCommit({ ...base, signature: null }).state));
check("executed error is FAILED", classifyCommit({ ...base, txErr: { InstructionError: [3, { Custom: 6039 }] } }).state === "FAILED");

// The required success condition.
check("confirmed + version advanced + fresh => success", isSuccess(classifyCommit(base).state));

// Boundary conditions.
check("version advanced to the same value is not success", !isSuccess(classifyCommit({ ...base, newVersion: 18n }).state));
check("version advanced but already expired is not success", !isSuccess(classifyCommit({ ...base, currentSlot: 1_010n, expirySlot: 1_010n }).state));
check("unread QuoteState is CONFIRMED not success", classifyCommit({ ...base, newVersion: null }).state === "CONFIRMED");

// Backoff is bounded and monotone up to the cap.
check("backoff grows and is capped", backoffDelayMs(1) === 500 && backoffDelayMs(2) === 1000 && backoffDelayMs(10) === 8000);

console.log(`\n${n} passed`);
