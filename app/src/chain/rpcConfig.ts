// S2-22: frontend RPC configuration. Environment-driven, cluster-guarded, with
// an optional fallback list. No secrets are ever hardcoded or logged. On-chain
// state remains the source of truth; this only affects endpoint availability.

export type FrontendCluster = 'devnet' | 'mainnet-beta';

export interface FrontendRpc {
  cluster: FrontendCluster;
  endpoints: string[];
}

export const FRONTEND_DEFAULT_RPC: Record<FrontendCluster, string> = {
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};

/** Public endpoints whose cluster is unambiguous; custom URLs return null. */
function knownHostCluster(url: string): FrontendCluster | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (host === 'api.mainnet-beta.solana.com') return 'mainnet-beta';
  if (host === 'api.devnet.solana.com') return 'devnet';
  return null;
}

/** Strip credentials/query so a URL can be rendered or logged safely. */
export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

/**
 * Resolve the frontend RPC endpoints from environment configuration.
 * `VITE_ARBSWAP_CLUSTER` selects the cluster; `VITE_SOLANA_RPC_URL` is the
 * primary and `VITE_SOLANA_RPC_FALLBACKS` a comma-separated list. A known public
 * endpoint belonging to the wrong cluster is a hard error (never mix clusters).
 */
export function resolveFrontendRpc(
  env: Record<string, string | undefined>,
  fallbackCluster: FrontendCluster = 'devnet',
): FrontendRpc {
  const raw = (env.VITE_ARBSWAP_CLUSTER ?? '').toLowerCase();
  const cluster: FrontendCluster =
    raw === 'mainnet' || raw === 'mainnet-beta' ? 'mainnet-beta' : fallbackCluster;

  const primary = env.VITE_SOLANA_RPC_URL ?? FRONTEND_DEFAULT_RPC[cluster];
  const fallbacks = (env.VITE_SOLANA_RPC_FALLBACKS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const endpoints = [primary, ...fallbacks];

  for (const e of endpoints) {
    const hc = knownHostCluster(e);
    if (hc && hc !== cluster) {
      throw new Error(`RPC endpoint ${redactRpcUrl(e)} belongs to ${hc}, not ${cluster}`);
    }
  }
  return { cluster, endpoints };
}
