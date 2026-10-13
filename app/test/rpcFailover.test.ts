import { describe, it, expect } from 'vitest';
import {
  RpcFailover,
  classifyRpcError,
  isRetryable,
  createRpcFailover,
} from '../src/chain/rpcFailover';

const mk = (url: string) => ({ rpcEndpoint: url }) as never;

describe('browser RPC failover', () => {
  it('classifies transport vs program errors', () => {
    expect(classifyRpcError({ status: 429 })).toBe('rate_limited');
    expect(classifyRpcError({ code: 'ETIMEDOUT' })).toBe('timeout');
    expect(classifyRpcError({ response: { status: 503 } })).toBe('http');
    expect(classifyRpcError({ code: 'ECONNREFUSED' })).toBe('network');
    expect(classifyRpcError(new Error('custom program error: 0x1797'))).toBe('unknown');
    expect(isRetryable('rate_limited')).toBe(true);
    expect(isRetryable('unknown')).toBe(false);
  });

  it('falls back to the next endpoint on transport failure', async () => {
    const sleeps: number[] = [];
    const pool = new RpcFailover({
      endpoints: ['https://a.example', 'https://b.example'],
      makeConnection: mk,
      maxAttemptsPerEndpoint: 2,
      sleep: async (ms: number) => { sleeps.push(ms); },
    });
    let calls = 0;
    const result = await pool.run(async (conn) => {
      calls += 1;
      if ((conn as { rpcEndpoint: string }).rpcEndpoint === 'https://a.example') {
        throw { status: 429, message: '429' };
      }
      return 'b-ok';
    });
    expect(result).toBe('b-ok');
    expect(calls).toBe(3);
    expect(sleeps.length).toBe(2);
  });

  it('does not fail over on a program error', async () => {
    let switched = false;
    const pool = new RpcFailover({
      endpoints: ['https://a.example', 'https://b.example'],
      makeConnection: mk,
      sleep: async () => {},
    });
    await expect(
      pool.run(async (conn) => {
        if ((conn as { rpcEndpoint: string }).rpcEndpoint === 'https://b.example') switched = true;
        throw new Error('AnchorError: InvalidOracle');
      }),
    ).rejects.toThrow(/InvalidOracle/);
    expect(switched).toBe(false);
  });

  it('redacts the active endpoint', () => {
    const pool = new RpcFailover({
      endpoints: ['https://user:pass@rpc.example/rpc?key=SECRET'],
      makeConnection: mk,
    });
    expect(pool.activeEndpoint).toBe('https://rpc.example/rpc');
  });

  it('builds from env and defaults to devnet', () => {
    const pool = createRpcFailover({});
    expect(pool.activeEndpoint).toBe('https://api.devnet.solana.com/');
  });
});
