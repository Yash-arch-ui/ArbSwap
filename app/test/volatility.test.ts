import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import {
  bigintSqrt,
  decodeVolatilityState,
  sigmaBpsOf,
  volatilityView,
  VOLATILITY_ACCOUNT_LEN,
} from '../src/chain/volatility';

const Q64 = 1n << 64n;

function writeU128(buf: Buffer, offset: number, value: bigint) {
  buf.writeBigUInt64LE(value & 0xffffffffffffffffn, offset);
  buf.writeBigUInt64LE(value >> 64n, offset + 8);
}

interface FixtureOverrides {
  enabled?: boolean;
  jumpDetected?: boolean;
  shortEwmaQ64?: bigint;
  lastPriceQ64?: bigint;
  lastObservationSlot?: number;
  maxObservationAgeSlots?: number;
  observationNonce?: number;
  jumpMultiple?: number;
}

function encodeVolatility(vault: PublicKey, overrides: FixtureOverrides = {}): Buffer {
  const b = Buffer.alloc(VOLATILITY_ACCOUNT_LEN);
  let o = 8;
  vault.toBuffer().copy(b, o);
  o += 32;
  writeU128(b, o, overrides.shortEwmaQ64 ?? Q64);
  o += 16;
  writeU128(b, o, 0n); // medium
  o += 16;
  writeU128(b, o, overrides.lastPriceQ64 ?? Q64);
  o += 16;
  b.writeBigInt64LE(1_700_000_000n, o); // last_publish_time
  o += 8;
  b.writeBigUInt64LE(BigInt(overrides.lastObservationSlot ?? 1_000), o);
  o += 8;
  b.writeBigUInt64LE(BigInt(overrides.observationNonce ?? 7), o);
  o += 8;
  b.writeUInt8(overrides.jumpDetected ? 1 : 0, o);
  o += 1;
  b.writeBigUInt64LE(0n, o); // jump_until_slot
  o += 8;
  b.writeUInt32LE(9_400, o); // short_lambda_bps
  o += 4;
  b.writeUInt32LE(9_900, o); // medium_lambda_bps
  o += 4;
  b.writeUInt32LE(overrides.jumpMultiple ?? 4, o); // jump_multiple
  o += 4;
  writeU128(b, o, 1n << 63n); // max_sigma_q64
  o += 16;
  b.writeBigUInt64LE(1_800n, o); // jump_cooldown_slots
  o += 8;
  b.writeUInt32LE(1_000, o); // vol_spread_coeff_bps
  o += 4;
  b.writeUInt32LE(2_000, o); // vol_depth_coeff_bps
  o += 4;
  b.writeBigUInt64LE(BigInt(overrides.maxObservationAgeSlots ?? 100), o);
  o += 8;
  b.writeUInt8(overrides.enabled === false ? 0 : 1, o); // enabled
  o += 1;
  b.writeUInt8(255, o); // bump
  return b;
}

const vault = new PublicKey(new Uint8Array(32).fill(9));

describe('decodeVolatilityState', () => {
  it('decodes a well-formed account', () => {
    const state = decodeVolatilityState(encodeVolatility(vault));
    expect(state).not.toBeNull();
    expect(state!.vault).toBe(vault.toBase58());
    expect(state!.shortEwmaQ64).toBe(Q64);
    expect(state!.lastPublishTime).toBe(1_700_000_000);
    expect(state!.observationNonce).toBe(7);
    expect(state!.jumpDetected).toBe(false);
    expect(state!.jumpMultiple).toBe(4);
    expect(state!.enabled).toBe(true);
    expect(state!.bump).toBe(255);
  });

  it('returns null for a truncated buffer instead of throwing', () => {
    expect(decodeVolatilityState(Buffer.alloc(VOLATILITY_ACCOUNT_LEN - 1))).toBeNull();
    expect(decodeVolatilityState(Buffer.alloc(0))).toBeNull();
  });
});

describe('sigma + volatility view', () => {
  it('sqrt of a Q64 variance is exact at perfect squares', () => {
    expect(bigintSqrt(0n)).toBe(0n);
    expect(bigintSqrt(16n)).toBe(4n);
    expect(bigintSqrt(1n << 64n)).toBe(1n << 32n);
  });

  it('derives sigma bps from the stored variance', () => {
    // variance = 1.0 -> sigma = 1.0 -> 10_000 bps
    expect(sigmaBpsOf(Q64)).toBe(10_000);
    expect(sigmaBpsOf(0n)).toBe(0);
  });

  it('a fresh, enabled observation is verified with floor and cap', () => {
    const state = decodeVolatilityState(encodeVolatility(vault))!;
    const view = volatilityView(state, 1_050, 2);
    expect(view.verified).toBe(true);
    expect(view.stale).toBe(false);
    expect(view.sigmaBps).toBe(10_000);
    expect(view.spreadFloorBps).toBe(1_000);
    expect(view.depthCapBps).toBe(8_000);
    expect(view.jumpActive).toBe(false);
  });

  it('a stale observation is not verified (fail closed)', () => {
    const state = decodeVolatilityState(encodeVolatility(vault))!;
    const view = volatilityView(state, 1_200, 2);
    expect(view.stale).toBe(true);
    expect(view.verified).toBe(false);
  });

  it('a disabled account is never marked verified even when fresh', () => {
    const state = decodeVolatilityState(encodeVolatility(vault, { enabled: false }))!;
    const view = volatilityView(state, 1_050, 2);
    expect(view.stale).toBe(false);
    expect(view.verified).toBe(false);
  });

  it('an unknown slot feed is not treated as a fresh observation', () => {
    const state = decodeVolatilityState(encodeVolatility(vault))!;
    const view = volatilityView(state, 0, 2);
    expect(view.verified).toBe(false);
    expect(view.stale).toBe(true);
  });

  it('an active jump multiplies effective sigma before the coefficients', () => {
    const state = decodeVolatilityState(encodeVolatility(vault, { jumpDetected: true }))!;
    const view = volatilityView(state, 1_050, 2);
    expect(view.jumpActive).toBe(true);
    expect(view.spreadFloorBps).toBe(4_000);
    expect(view.depthCapBps).toBe(2_000);
  });
});
