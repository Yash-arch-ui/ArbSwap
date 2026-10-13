import React from 'react';
import { READ_ONLY_MODE } from '../chain/config';

/** The single, explicit read-only marker used across every action surface. */
export const READ_ONLY_NOTICE = 'Transactions disabled in read-only integration mode';

/**
 * S2-32: this build connects the frontend to real on-chain and artifact data but
 * must not submit transactions. A single banner makes the mode explicit; action
 * buttons are disabled and labelled rather than wired to a wallet signature.
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
      <strong>Read-only integration mode.</strong> {detail ?? 'Live protocol data is shown, but no transactions can be submitted from this build.'}
    </div>
  );
};
