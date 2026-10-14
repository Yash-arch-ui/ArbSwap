import React from 'react';
import { READ_ONLY_MODE, TRANSACTIONS_ENABLED, CLUSTER } from '../chain/config';

/** The single, explicit read-only marker used across every action surface. */
export const READ_ONLY_NOTICE = 'Transactions disabled in read-only diagnostic mode';

/**
 * The read-only banner is shown ONLY in the deliberate diagnostic/demo mode
 * (`VITE_ARBSWAP_MODE=read-only`). The normal Devnet application is
 * transaction-enabled and never shows it; obsolete "integration mode" banners
 * are not rendered when trading is enabled.
 */
export const ReadOnlyBanner: React.FC<{ detail?: string }> = ({ detail }) => {
  if (!READ_ONLY_MODE) return null;
  return (
    <div
      className="uni-card"
      style={{ marginBottom: 12, borderColor: 'var(--uni-warning)' }}
      role="status"
      data-testid="read-only-banner"
    >
      <strong>Read-only diagnostic mode.</strong> {detail ?? 'Live protocol data is shown, but no transactions can be submitted from this build.'}
    </div>
  );
};

/**
 * Always-visible mode indicator so the resolved execution mode is explicit and
 * never implicit. `Trading enabled` on Devnet; otherwise the concrete reason.
 */
export const ModeBadge: React.FC = () => {
  const enabled = TRANSACTIONS_ENABLED;
  return (
    <span
      data-testid="mode-badge"
      data-mode={enabled ? 'trade' : 'read-only'}
      title={
        enabled
          ? `Trading enabled on ${CLUSTER}: the connected wallet signs and submits real transactions.`
          : 'Transactions are disabled in this build (read-only diagnostic mode or non-Devnet cluster).'
      }
      style={{
        color: enabled ? 'var(--uni-accent1)' : 'var(--uni-warning)',
        fontSize: 11,
        fontFamily: 'var(--uni-mono)',
      }}
    >
      {enabled ? 'trading' : 'read-only'}
    </span>
  );
};
