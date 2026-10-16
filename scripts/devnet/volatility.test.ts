// Local regression tests for the volatility-aware keeper helpers.
// Pure, deterministic, no network, no secrets. Run: npx tsx volatility.test.ts
import assert from "node:assert/strict";
import { AccountMeta, PublicKey } from "@solana/web3.js";
import {
  BODY_DEPTH_MULT_OFFSET,
  BODY_HALF_SPREAD_OFFSET,
  buildCommitKeys,
  buildObserveIx,
  buildStageKeys,
  clampQuoteBody,
  decodeVolatilityState,
  isqrt,
  mulBpsCeil,
  pendingVolatilityPda,
  sigmaBps,
  sigmaQ64,
  volatilityAction,
  volatilityLimits,
  volatilityPda,
  VOLATILITY_ACCOUNT_LEN,
  type OnChainVolatility,
} from "./volatility";

let n = 0;
const check = (name: string, cond: boolean) => {
  n += 1;
  assert.ok(cond, `case failed: ${name}`);
  console.log(`ok ${n} - ${name}`);
};
const eq = (name: string, actual: unknown, expected: unknown) => {
  n += 1;
  assert.deepStrictEqual(actual, expected, `case failed: ${name}`);
  console.log(`ok ${n} - ${name}  (${String(actual)})`);
};

const PROGRAM = new PublicKey("2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm");
const VAULT = new PublicKey("8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt");
const Q64 = 1n << 64n;

/** Build a synthetic 175-byte VolatilityState for decode tests. */
function volBuffer(over: Partial<{
  vault: PublicKey;
  shortEwmaQ64: bigint;
  lastPriceQ64: bigint;
  lastPublishTime: bigint;
  lastObservationSlot: bigint;
  observationNonce: bigint;
  jumpDetected: boolean;
  jumpUntilSlot: bigint;
  jumpMultiple: number;
  maxSigmaQ64: bigint;
  volSpreadCoeffBps: number;
  volDepthCoeffBps: number;
  maxObservationAgeSlots: bigint;
  enabled: boolean;
  bump: number;
}> = {}): Buffer {
  const d = Buffer.alloc(VOLATILITY_ACCOUNT_LEN);
  (over.vault ?? VAULT).toBuffer().copy(d, 8);
  const w128 = (o: number, v: bigint) => {
    d.writeBigUInt64LE(v & 0xffffffffffffffffn, o);
    d.writeBigUInt64LE(v >> 64n, o + 8);
  };
  w128(40, over.shortEwmaQ64 ?? 0n);
  w128(56, 0n);
  w128(72, over.lastPriceQ64 ?? 0n);
  d.writeBigInt64LE(over.lastPublishTime ?? 0n, 88);
  d.writeBigUInt64LE(over.lastObservationSlot ?? 0n, 96);
  d.writeBigUInt64LE(over.observationNonce ?? 0n, 104);
  d.writeUInt8(over.jumpDetected ? 1 : 0, 112);
  d.writeBigUInt64LE(over.jumpUntilSlot ?? 0n, 113);
  d.writeUInt32LE(9_400, 121);
  d.writeUInt32LE(9_900, 125);
  d.writeUInt32LE(over.jumpMultiple ?? 4, 129);
  w128(133, over.maxSigmaQ64 ?? 1n << 60n);
  d.writeBigUInt64LE(1_800n, 149);
  d.writeUInt32LE(over.volSpreadCoeffBps ?? 1_000, 157);
  d.writeUInt32LE(over.volDepthCoeffBps ?? 2_000, 161);
  d.writeBigUInt64LE(over.maxObservationAgeSlots ?? 3_600n, 165);
  d.writeUInt8(over.enabled ? 1 : 0, 173);
  d.writeUInt8(over.bump ?? 255, 174);
  return d;
}

// --- PDA derivation --------------------------------------------------------
eq("volatility PDA is vault-bound and matches the deployed address",
  volatilityPda(VAULT, PROGRAM).toBase58(),
  "5HbPRjBorUKKFbncnMFxoHC2sio5t8UqF9FvfGwcity3");
eq("pending volatility PDA matches the deployed address",
  pendingVolatilityPda(VAULT, PROGRAM).toBase58(),
  "z9zyVXVoCNPXL8EHj6QKZwTxa1V8oHHrPcUrGLYukRF");
check("a different vault yields a different PDA",
  volatilityPda(PublicKey.default, PROGRAM).toBase58() !== volatilityPda(VAULT, PROGRAM).toBase58());

// --- decode ----------------------------------------------------------------
const decoded = decodeVolatilityState(volBuffer({
  shortEwmaQ64: Q64,
  lastPriceQ64: 150n << 64n,
  lastPublishTime: 1_000n,
  lastObservationSlot: 5n,
  observationNonce: 7n,
  jumpDetected: true,
  jumpUntilSlot: 1_805n,
  maxSigmaQ64: 1n << 62n,
  volSpreadCoeffBps: 500,
  volDepthCoeffBps: 2_000,
  maxObservationAgeSlots: 50n,
  enabled: true,
}))!;
eq("decode: short EWMA", decoded.shortEwmaQ64, Q64);
eq("decode: last price", decoded.lastPriceQ64, 150n << 64n);
eq("decode: publish time", decoded.lastPublishTime, 1_000n);
eq("decode: observation slot", decoded.lastObservationSlot, 5n);
eq("decode: nonce", decoded.observationNonce, 7n);
eq("decode: jump flag", decoded.jumpDetected, true);
eq("decode: jump until", decoded.jumpUntilSlot, 1_805n);
eq("decode: max sigma", decoded.maxSigmaQ64, 1n << 62n);
eq("decode: spread coeff", decoded.volSpreadCoeffBps, 500);
eq("decode: depth coeff", decoded.volDepthCoeffBps, 2_000);
eq("decode: max age", decoded.maxObservationAgeSlots, 50n);
eq("decode: enabled", decoded.enabled, true);
eq("decode: vault", decoded.vault, VAULT.toBase58());
eq("decode: too-short buffer returns null", decodeVolatilityState(Buffer.alloc(174)), null);

// --- fixed-point math ------------------------------------------------------
eq("isqrt(0)", isqrt(0n), 0n);
eq("isqrt(1<<128) = 1<<64", isqrt(1n << 128n), 1n << 64n);
eq("sigmaQ64(variance 1.0) = 1.0", sigmaQ64(Q64), Q64);
eq("sigmaBps(variance 1.0) = 10_000", sigmaBps(Q64), 10_000n);
eq("sigmaBps(0) = 0", sigmaBps(0n), 0n);
// variance 0.0006 -> sigma = sqrt(0.0006) = 0.02449 -> 244 bps
eq("sigmaBps(0.0006) = 244", sigmaBps(11_068_046_444_225_730n), 244n);
eq("mulBpsCeil rounds up", mulBpsCeil(5n, 2_000n), 1n);
eq("mulBpsCeil exact", mulBpsCeil(10_000n, 10_000n), 10_000n);

// --- guard limits ----------------------------------------------------------
const calm = decodeVolatilityState(volBuffer({ shortEwmaQ64: Q64, lastPriceQ64: Q64, maxSigmaQ64: 1n << 65n }))!;
const calmLimits = volatilityLimits(calm, 0n, 2n);
eq("calm spread floor", calmLimits.floorBps, 1_000n);
eq("calm depth cap", calmLimits.capBps, 8_000n);
eq("calm not over ceiling", calmLimits.overCeiling, false);

const jump = decodeVolatilityState(volBuffer({
  shortEwmaQ64: Q64, lastPriceQ64: Q64, maxSigmaQ64: 1n << 65n, jumpDetected: true, jumpMultiple: 4,
}))!;
const jumpLimits = volatilityLimits(jump, 0n, 2n);
eq("jump spread floor (x4)", jumpLimits.floorBps, 4_000n);
eq("jump depth cap", jumpLimits.capBps, 2_000n);

const ceiling = decodeVolatilityState(volBuffer({ shortEwmaQ64: Q64, lastPriceQ64: Q64, maxSigmaQ64: 1n << 50n }))!;
check("sigma above ceiling is flagged", volatilityLimits(ceiling, 0n, 2n).overCeiling);

// --- quote gating ----------------------------------------------------------
eq("absent PDA -> blocked", volatilityAction(null, 100n), "blocked-absent");
eq("no baseline -> observe", volatilityAction(decodeVolatilityState(volBuffer({ maxObservationAgeSlots: 100n }))!, 100n), "observe-baseline");
eq("stale observation -> observe",
  volatilityAction(decodeVolatilityState(volBuffer({ lastPriceQ64: Q64, lastObservationSlot: 10n, maxObservationAgeSlots: 20n }))!, 100n),
  "observe-stale");
eq("fresh observation -> quote",
  volatilityAction(decodeVolatilityState(volBuffer({ lastPriceQ64: Q64, lastObservationSlot: 95n, maxObservationAgeSlots: 20n }))!, 100n),
  "quote");

// --- body clamp ------------------------------------------------------------
const body = Buffer.alloc(692);
body.writeUInt32LE(5, BODY_HALF_SPREAD_OFFSET);
body.writeUInt32LE(10_000, BODY_DEPTH_MULT_OFFSET);
const clamped = clampQuoteBody(body, 1_000n, 8_000n);
eq("clamp raises spread to floor", clamped.readUInt32LE(BODY_HALF_SPREAD_OFFSET), 1_000);
eq("clamp lowers depth to cap", clamped.readUInt32LE(BODY_DEPTH_MULT_OFFSET), 8_000);
eq("clamp does not mutate the engine body", body.readUInt32LE(BODY_HALF_SPREAD_OFFSET), 5);
// The engine's spread already above the floor is preserved.
const body2 = Buffer.alloc(692);
body2.writeUInt32LE(4_500, BODY_HALF_SPREAD_OFFSET);
body2.writeUInt32LE(3_000, BODY_DEPTH_MULT_OFFSET);
const clamped2 = clampQuoteBody(body2, 1_000n, 8_000n);
eq("clamp keeps a higher spread", clamped2.readUInt32LE(BODY_HALF_SPREAD_OFFSET), 4_500);
eq("clamp keeps a lower depth", clamped2.readUInt32LE(BODY_DEPTH_MULT_OFFSET), 3_000);

// --- instruction account lists --------------------------------------------
const KEEPER = new PublicKey("8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH");
const CONFIG = new PublicKey("ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT");
const QUOTE_STATE = new PublicKey("5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG");
const PENDING = PublicKey.default;
const BASE_RESERVE = new PublicKey("8vfr2KmMmXYUTjRg5cAiSYD6EhN1d8pjJnmFC95E2vfm");
const QUOTE_RESERVE = new PublicKey("G8q1WMKT8fnGQh85kCB8Aihf6F7tctXJDKbA6gn1jPeS");
const BOND = new PublicKey("DsSQaVCdwzKjbxRJm4vmbbqqJwLgLMmDgzMjkeneUryd");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const WORMHOLE = new PublicKey("HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ");
const VOL = volatilityPda(VAULT, PROGRAM);
const SYSTEM = PublicKey.default;

const stage = buildStageKeys({
  programId: PROGRAM, keeper: KEEPER, vault: VAULT, config: CONFIG, quoteState: QUOTE_STATE,
  pendingQuote: PENDING, baseReserve: BASE_RESERVE, quoteReserve: QUOTE_RESERVE, keeperBond: BOND,
  volatilityState: VOL, systemProgram: SYSTEM,
});
eq("stage: account count", stage.length, 10);
eq("stage: volatility immediately before system", [stage[8].pubkey.toBase58(), stage[9].pubkey.toBase58()], [VOL.toBase58(), SYSTEM.toBase58()]);
eq("stage: keeper signer+writable", [stage[0].isSigner, stage[0].isWritable], [true, true]);
eq("stage: pending writable", stage[4].isWritable, true);
eq("stage: volatility readonly", stage[8].isWritable, false);
eq("stage: non-volatility prefix preserved", stage.slice(1, 8).map((m) => m.pubkey.toBase58()),
  [VAULT, CONFIG, QUOTE_STATE, PENDING, BASE_RESERVE, QUOTE_RESERVE, BOND].map((p) => p.toBase58()));
check("stage: no duplicate PDA", stage.filter((m) => m.pubkey.equals(VOL)).length === 1);

const commit = buildCommitKeys({
  programId: PROGRAM, keeper: KEEPER, vault: VAULT, config: CONFIG, quoteState: QUOTE_STATE,
  pendingQuote: PENDING, priceUpdate: SYSTEM, baseReserve: BASE_RESERVE, quoteReserve: QUOTE_RESERVE,
  keeperBond: BOND, baseMint: WSOL, quoteMint: USDC, volatilityState: VOL, extraTrailing: [WORMHOLE],
});
eq("commit: program accounts + extras", commit.length, 13);
eq("commit: volatility at index 11", commit[11].pubkey.toBase58(), VOL.toBase58());
eq("commit: mints before volatility", [commit[9].pubkey.toBase58(), commit[10].pubkey.toBase58()], [WSOL.toBase58(), USDC.toBase58()]);
eq("commit: extra trailing preserved", commit[12].pubkey.toBase58(), WORMHOLE.toBase58());
eq("commit: quoteState writable", commit[3].isWritable, true);
eq("commit: keeper signer+writable", [commit[0].isSigner, commit[0].isWritable], [true, true]);
eq("commit: volatility readonly", commit[11].isWritable, false);
check("commit: no duplicate PDA", commit.filter((m) => m.pubkey.equals(VOL)).length === 1);

const observe = buildObserveIx({
  programId: PROGRAM, observer: KEEPER, vault: VAULT, config: CONFIG,
  volatilityState: VOL, priceUpdate: SYSTEM, baseMint: WSOL, quoteMint: USDC,
});
eq("observe: account order", observe.keys.map((m: AccountMeta) => m.pubkey.toBase58()),
  [KEEPER, VAULT, CONFIG, VOL, SYSTEM, WSOL, USDC].map((p) => p.toBase58()));
eq("observe: observer signer", observe.keys[0].isSigner, true);
eq("observe: volatility_state writable", observe.keys[3].isWritable, true);
eq("observe: discriminator is global:observe_volatility[..8]", observe.data.length, 8);

console.log(`\nvolatility.test: all ${n} checks passed`);
