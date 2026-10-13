import { describe, it, expect } from 'vitest';
import { resolveFrontendRpc, redactRpcUrl } from '../src/chain/rpcConfig';

describe('frontend RPC configuration', () => {
  it('defaults to devnet with the public endpoint', () => {
    const r = resolveFrontendRpc({});
    expect(r.cluster).toBe('devnet');
    expect(r.endpoints[0]).toBe('https://api.devnet.solana.com');
  });

  it('reads a primary and fallbacks from env', () => {
    const r = resolveFrontendRpc({
      VITE_SOLANA_RPC_URL: 'https://x.example/rpc?k=1',
      VITE_SOLANA_RPC_FALLBACKS: 'https://y.example/rpc, https://z.example/rpc',
    });
    expect(r.endpoints).toEqual([
      'https://x.example/rpc?k=1',
      'https://y.example/rpc',
      'https://z.example/rpc',
    ]);
  });

  it('selects mainnet when configured', () => {
    const r = resolveFrontendRpc({ VITE_ARBSWAP_CLUSTER: 'mainnet' });
    expect(r.cluster).toBe('mainnet-beta');
    expect(r.endpoints[0]).toBe('https://api.mainnet-beta.solana.com');
  });

  it('rejects a cross-cluster public endpoint', () => {
    expect(() =>
      resolveFrontendRpc({
        VITE_ARBSWAP_CLUSTER: 'devnet',
        VITE_SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
      }),
    ).toThrow(/belongs to/);
  });

  it('redacts credentials and query strings', () => {
    expect(redactRpcUrl('https://user:pass@rpc.example/rpc?key=SECRET')).toBe(
      'https://rpc.example/rpc',
    );
  });
});
