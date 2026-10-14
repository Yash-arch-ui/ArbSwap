import React, { useCallback, useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { APP_RPC_FAILOVER } from '../chain/rpcFailover';
import { fetchKeeperReward, claimKeeperReward } from '../chain/program';
import { useProtocol } from '../context/ProtocolContext';
import { TRANSACTIONS_ENABLED, TRANSACTION_DISABLED_REASON } from '../chain/config';

/**
 * S2-24: keeper reward surface. Shows the *connected* wallet's own claimable
 * `KeeperReward` (per-keeper PDA) and lets it claim. Entitlement comes from
 * on-chain state only; a wallet that is not a keeper (or authored no committed
 * quote) shows "nothing to claim" and is never assigned another keeper's reward.
 */
export const KeeperRewards: React.FC = () => {
  const connection = APP_RPC_FAILOVER.connection;
  const { publicKey, connected, wallet } = useWallet();
  const { refreshBalances } = useProtocol();
  const [reward, setReward] = useState<{ base: bigint; quote: bigint } | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    if (!publicKey) {
      setReward(null);
      return;
    }
    try {
      setReward(await fetchKeeperReward(connection, publicKey));
    } catch {
      setReward(null); // RPC failure: render as unavailable, never fabricate.
    }
  }, [connection, publicKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const claim = async () => {
    if (!TRANSACTIONS_ENABLED) { setNote({ text: TRANSACTION_DISABLED_REASON ?? 'Transactions are disabled in this build.', ok: false }); return; }
    if (!connected || !wallet) return;
    setLoading(true);
    setNote(null);
    try {
      const sig = await claimKeeperReward(connection, wallet);
      setNote({ text: `Claimed: ${sig.slice(0, 8)}…`, ok: true });
      await load();
      await refreshBalances();
    } catch (error) {
      setNote({ text: `Claim failed: ${(error as Error).message?.slice(0, 120) ?? 'unknown error'}`, ok: false });
    } finally {
      setLoading(false);
    }
  };

  const hasReward = !!reward && (reward.base > 0n || reward.quote > 0n);
  const summary = !connected
    ? 'Connect the keeper wallet to view claimable rewards.'
    : reward === null
      ? 'No keeper-reward account for this wallet (not a keeper, or no committed quote).'
      : `Claimable: ${Number(reward.base) / 1e9} WSOL + ${Number(reward.quote) / 1e6} USDC`;

  return (
    <div className="glass-card" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <strong>Keeper rewards</strong>
          <p className="mono" style={{ fontSize: 12, margin: '4px 0 0', color: 'var(--uni-neutral2)' }}>
            {summary}
          </p>
        </div>
        <button
          type="button"
          className="uni-main-button"
          style={{ width: 'auto', padding: '8px 16px' }}
          disabled={!TRANSACTIONS_ENABLED || !connected || !hasReward || loading}
          onClick={claim}
        >
          {!TRANSACTIONS_ENABLED ? 'Transactions disabled' : loading ? 'Claiming…' : hasReward ? 'Claim keeper reward' : 'Nothing to claim'}
        </button>
      </div>
      {note && (
        <p className="mono" style={{ fontSize: 12, margin: '8px 0 0', color: note.ok ? 'var(--uni-success)' : 'var(--uni-warning)' }} role={note.ok ? 'status' : 'alert'}>
          {note.ok ? '✓' : '⚠'} {note.text}
        </p>
      )}
    </div>
  );
};
