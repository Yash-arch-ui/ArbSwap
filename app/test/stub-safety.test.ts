import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { BorshCoder } from '@coral-xyz/anchor';
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

// Fixture bytes are emitted by the Rust program test
// `vault/program/tests/frontend_fixtures.rs` (the program's own
// `AccountSerialize` layout), never hand-written. Regenerate with
// `scripts/gen_frontend_fixtures.sh`.
interface AccountFixtures {
  programId: string;
  vault: string;
  config: string;
  quoteState: string;
}
const fixtures: AccountFixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/accounts.json', import.meta.url)), 'utf8'),
);

const wallet = {
  publicKey: PublicKey.default,
  signTransaction: async (t: unknown) => t,
  signAllTransactions: async (t: unknown[]) => t,
};

function mockConnection(byKey: Record<string, Buffer>) {
  const info = (data?: Buffer) =>
    data ? { data, owner: PROGRAM, executable: false, lamports: 1, rentEpoch: 0 } : null;
  return {
    getAccountInfo: vi.fn(async (key: PublicKey) => info(byKey[key.toBase58()])),
    // The Anchor provider's account.fetch uses getAccountInfoAndContext.
    getAccountInfoAndContext: vi.fn(async (key: PublicKey) => ({
      context: { slot: 1 },
      value: info(byKey[key.toBase58()]),
    })),
    getBalance: vi.fn(async () => 0),
    getParsedTokenAccountsByOwner: vi.fn(async () => ({ value: [] })),
  } as never;
}

/** BN | bigint | number -> number; BN/bigint stringify exactly, so numeric. */
const n = (v: unknown): number => Number((v as { toString(): string }).toString());
const buf = (hex: string) => Buffer.from(hex, 'hex');

describe('toml stub safety', () => {
  it('(i) the stub throws a clear error when called, and counts the call', () => {
    const before = toml.calls();
    expect(() => (toml as { parse: (s: string) => unknown }).parse('x = 1')).toThrow(
      /not available in the browser build/,
    );
    expect(toml.calls()).toBe(before + 1);
  });

  it('(ii) client functions run with the stub active and never invoke it', async () => {
    const connection = mockConnection({}); // no vault -> decode skipped, builders early-exit
    const before = toml.calls();

    const state = await fetchProtocolState(connection);
    expect(state.exists).toBe(false);

    // Each builder runs its code path and fails on the missing vault, not on toml.
    await expect(deposit(connection, wallet, 1n, 1n)).rejects.toThrow(/vault not initialized/);
    await expect(swap(connection, wallet, { buyBase: {} }, 1n, 0n, 0n)).rejects.toThrow(/vault not initialized/);
    await expect(requestWithdraw(connection, wallet, 1n)).rejects.toThrow(/vault not initialized/);
    await expect(claimWithdraw(connection, wallet)).rejects.toThrow(/vault not initialized/);
    await expect(crankEpoch(connection, wallet)).rejects.toBeDefined();

    // The parser was never invoked on any of these code paths.
    expect(toml.calls()).toBe(before);
  });

  it('(iii) decodes Vault, Config and QuoteState fixture bytes from the program build', async () => {
    expect(fixtures.programId).toBe(PROGRAM.toBase58());

    const vaultBytes = buf(fixtures.vault);
    const configBytes = buf(fixtures.config);
    const quoteBytes = buf(fixtures.quoteState);

    // Direct IDL decode against the Rust-produced bytes.
    const v = (await coder.accounts.decode('Vault', vaultBytes)) as Record<string, unknown>;
    expect(n(v.total_shares)).toBe(1_234_567_890);
    expect(n(v.epoch)).toBe(42);
    expect(v.status).toBe(1);

    const c = (await coder.accounts.decode('Config', configBytes)) as Record<string, unknown>;
    expect(c.fee_bps).toBe(100);
    expect(c.min_spread_bps).toBe(2);
    expect(c.max_spread_bps).toBe(50);

    const q = (await coder.accounts.decode('QuoteState', quoteBytes)) as Record<string, unknown>;
    expect(n(q.version)).toBe(7);
    expect(q.half_spread_bps).toBe(5);
    expect(n(q.flow_n)).toBe(7);
    const asks = q.ask_levels as Array<Record<string, unknown>>;
    expect(asks).toHaveLength(6);
    expect(asks[0].offset_bps).toBe(0);
    // S2-25: the appended `keeper` field (QuoteState 897-byte layout) must decode
    // through the committed IDL.
    expect(q.keeper).toBeDefined();

    // The client decodes the vault + quote-state through fetchProtocolState.
    // This is the regression guard for the snake_case -> camelCase mapping
    // (reading camelCase off the snake_case IDL left these `undefined`).
    const connection = mockConnection({
      [vault.toBase58()]: vaultBytes,
      [quoteState.toBase58()]: quoteBytes,
    });
    const state = await fetchProtocolState(connection);
    expect(state.exists).toBe(true);
    expect(state.vaultData?.totalShares.toNumber()).toBe(1_234_567_890);
    expect(state.vaultData?.epoch.toNumber()).toBe(42);
    expect(state.vaultData?.status).toBe(1);
    expect(state.quoteData?.version.toNumber()).toBe(7);
    expect(state.quoteData?.askLevels).toHaveLength(6);
    expect(state.quoteData?.keeper).toBeDefined();
  });
});
