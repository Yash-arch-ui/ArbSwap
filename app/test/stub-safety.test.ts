import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { BorshCoder, BN } from '@coral-xyz/anchor';
import * as toml from 'toml';
import { Buffer } from 'buffer';
import idl from '../src/idl/arbswap.json';
import {
  fetchProtocolState,
  deriveVaultAddresses,
  deposit,
  swap,
  requestWithdraw,
  claimWithdraw,
  crankEpoch,
} from '../src/chain/program';

const PROGRAM = new PublicKey('2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm');
const coder = new BorshCoder(idl as never);
const { vault, quoteState } = deriveVaultAddresses();

const wallet = {
  publicKey: PublicKey.default,
  signTransaction: async (t: unknown) => t,
  signAllTransactions: async (t: unknown[]) => t,
};

function mockConnection(byKey: Record<string, Buffer>) {
  return {
    getAccountInfo: vi.fn(async (key: PublicKey) => {
      const data = byKey[key.toBase58()];
      return data ? { data, owner: PROGRAM, executable: false, lamports: 1, rentEpoch: 0 } : null;
    }),
    getBalance: vi.fn(async () => 0),
    getParsedTokenAccountsByOwner: vi.fn(async () => ({ value: [] })),
  } as never;
}

describe('toml stub safety', () => {
  it('(i) the stub throws a clear error when called', () => {
    expect(() => (toml as { parse: (s: string) => unknown }).parse('x = 1')).toThrow(
      /not available in the browser build/,
    );
  });

  it('(ii) client functions run with the stub active and never invoke it', async () => {
    const connection = mockConnection({}); // no vault -> decode skipped, builders early-exit
    const state = await fetchProtocolState(connection);
    expect(state.exists).toBe(false);

    // Each builder runs its code path and fails on the missing vault, not on toml.
    await expect(deposit(connection, wallet, 1n, 1n)).rejects.toThrow(/vault not initialized/);
    await expect(swap(connection, wallet, { buyBase: {} }, 1n, 0n, 0n)).rejects.toThrow(/vault not initialized/);
    await expect(requestWithdraw(connection, wallet, 1n)).rejects.toThrow(/vault not initialized/);
    await expect(claimWithdraw(connection, wallet)).rejects.toThrow(/vault not initialized/);
    await expect(crankEpoch(connection, wallet)).rejects.toBeDefined();
    // toml must never have been called (the stub would have thrown).
    expect((toml as { parse: unknown }).parse).not.toBe(undefined);
  });

  // TODO(item1-iii): generate fixture bytes from the Rust program build (litesvm
  // account serialization) and drop them in test/fixtures/. The JS BorshCoder needs
  // account field layouts, which this IDL does not carry, so IDL-only fixtures are
  // not authoritative. Skipped rather than faked.
  it.skip('(iii) decodes Vault, Config and QuoteState fixture bytes from the build', async () => {
    const vaultFixture = {
      admin: PublicKey.default, baseMint: PublicKey.default, quoteMint: PublicKey.default,
      baseReserve: PublicKey.default, quoteReserve: PublicKey.default,
      shareMint: PublicKey.default, shareLock: PublicKey.default,
      totalShares: new BN(1234), insuranceBase: new BN(0), insuranceQuote: new BN(0),
      keeperBase: new BN(0), keeperQuote: new BN(0), protocolBase: new BN(0), protocolQuote: new BN(0),
      epoch: new BN(0), epochStart: new BN(0), status: 0, bump: 255,
    };
    const vaultBytes = Buffer.from(await coder.accounts.encode('Vault', vaultFixture));
    const level = { offsetBps: 1, weightBps: 10_000, sqrtLo: new BN(1), sqrtHi: new BN(2), liquidity: new BN(3) };
    const quoteFixture = {
      version: new BN(7), updateSlot: new BN(10), expirySlot: new BN(20),
      anchorSqrtPrice: new BN(1), pResSqrt: new BN(1), halfSpreadBps: 5,
      askExtraBps: 0, bidExtraBps: 0, depthMultBps: 10_000,
      windowStartSlot: new BN(0), windowBaseSold: new BN(0), windowBaseBought: new BN(0),
      oraclePublishTime: new BN(0), oracleConfBps: 1, oraclePrice: new BN(1),
      edgeWindowStartSlot: new BN(0), realizedEdge: new BN(0), flowN: new BN(0),
      askLevels: [level, level, level, level, level, level],
      bidLevels: [level, level, level, level, level, level],
      bump: 254,
    };
    const quoteBytes = Buffer.from(await coder.accounts.encode('QuoteState', quoteFixture));
    const configFixture = {
      admin: PublicKey.default, keeper: PublicKey.default, treasury: PublicKey.default,
      pythFeedId: Array.from({ length: 32 }, () => 0),
      feeBps: 1, insuranceBps: 1, keeperBps: 1, protocolBps: 1,
      minLiquidity: new BN(1), warmupSlots: new BN(1), epochSlots: new BN(10),
      graceSlots: new BN(1), expirySlots: new BN(10), maxStalenessSeconds: new BN(30),
      maxConfBps: 10, maxAnchorStepBps: 100, maxSpreadStepBps: 10, minSpreadBps: 2, maxSpreadBps: 50,
      maxQuoteSize: new BN(1), maxInventoryBps: 2000, utilizationMaxBps: 5000,
      minBond: new BN(0), unbondCooldownSlots: new BN(100), maxUpdateSlotAge: 25,
      edgeWindowSlots: new BN(100), maxEdgeLossBps: 500, maxAnchorDevBps: 100,
      flowWindowSlots: new BN(100), maxWindowFlowBps: 10_000,
      pendingAdmin: PublicKey.default, adminActivateSlot: new BN(0), bump: 253,
    };
    const configBytes = Buffer.from(await coder.accounts.encode('Config', configFixture));

    // direct IDL decode
    expect(((await coder.accounts.decode('Vault', vaultBytes)) as { totalShares: BN }).totalShares.toNumber()).toBe(1234);
    expect(((await coder.accounts.decode('QuoteState', quoteBytes)) as { version: BN }).version.toNumber()).toBe(7);
    expect(((await coder.accounts.decode('Config', configBytes)) as { maxSpreadBps: number }).maxSpreadBps).toBe(50);

    // the client decodes the vault + quote-state through fetchProtocolState
    const connection = mockConnection({
      [vault.toBase58()]: vaultBytes,
      [quoteState.toBase58()]: quoteBytes,
    });
    const state = await fetchProtocolState(connection);
    expect(state.exists).toBe(true);
    expect(state.vaultData?.totalShares.toNumber()).toBe(1234);
    expect(state.quoteData?.version.toNumber()).toBe(7);
  });
});
