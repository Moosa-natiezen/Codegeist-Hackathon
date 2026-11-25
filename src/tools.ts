/**
 * Forge function entry points for rovo:agent / rovo:mcp actions.
 * Each exported function is referenced by a manifest `action` module handler.
 */
import { getContext, syncStatus, verifyImplementation } from './backend/actions';

export const specguardGetContext = async (payload: unknown) => getContext((payload ?? {}) as never);

export const specguardVerifyImplementation = async (payload: unknown) =>
  verifyImplementation((payload ?? {}) as never);

export const specguardSyncStatus = async (payload: unknown) => syncStatus((payload ?? {}) as never);
