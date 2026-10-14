// S2-36: authoritative, classified vault read.
//
// The single most important integrity rule of this layer: a transport failure
// (HTTP 429, timeout, network error) must NEVER be interpreted as "the vault
// does not exist". Only a *successful* account lookup that returns nothing is
// `not_found`; a present account with the wrong owner/discriminator/layout is
// `invalid`; a present, valid account decodes to `ready`.
import type { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import {
  deriveVaultAddresses,
  fetchProtocolState,
  PROGRAM_ID,
  type OnChainProtocolState,
} from './program';
import { ACTIVE_VAULT } from './config';
import { isTransportError, sourceErrorFromException, type SourceError } from './dataState';

export type VaultReadResult =
  | { kind: 'ready'; state: OnChainProtocolState; info: AccountInfo<Buffer> }
  | { kind: 'not_found'; vault: PublicKey }
  | { kind: 'invalid'; vault: PublicKey; reason: string; errorKind: SourceError }
  | { kind: 'rpc_error'; vault: PublicKey; reason: string; errorKind: SourceError };

export async function readVault(
  connection: Connection,
  baseMint = ACTIVE_VAULT.baseMint,
  quoteMint = ACTIVE_VAULT.quoteMint,
): Promise<VaultReadResult> {
  const { vault } = deriveVaultAddresses(baseMint, quoteMint);

  let info: AccountInfo<Buffer> | null;
  try {
    info = await connection.getAccountInfo(vault);
  } catch (error) {
    const { kind, reason } = sourceErrorFromException(error);
    return { kind: 'rpc_error', vault, reason, errorKind: kind };
  }

  // A successful lookup that returned nothing is the ONLY authoritative proof
  // that the vault is uninitialized.
  if (!info) return { kind: 'not_found', vault };

  if (!info.owner.equals(PROGRAM_ID)) {
    return {
      kind: 'invalid',
      vault,
      reason: `Account is owned by ${info.owner.toBase58().slice(0, 6)}…, not the ArbSwap program.`,
      errorKind: 'invalid_owner',
    };
  }

  try {
    const state = await fetchProtocolState(connection, baseMint, quoteMint, info);
    if (!state.exists || !state.vaultData) {
      return {
        kind: 'invalid',
        vault,
        reason: 'Vault account could not be decoded with the deployed IDL layout.',
        errorKind: 'invalid_layout',
      };
    }
    return { kind: 'ready', state, info };
  } catch (error) {
    const { kind, reason } = sourceErrorFromException(error);
    // Reserves/config reads inside the decode may themselves be transport
    // failures — do not mislabel those as a bad layout.
    if (isTransportError(kind)) return { kind: 'rpc_error', vault, reason, errorKind: kind };
    return {
      kind: 'invalid',
      vault,
      reason: `Vault decode failed: ${reason}`,
      errorKind: 'invalid_layout',
    };
  }
}
