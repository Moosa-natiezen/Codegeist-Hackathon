/**
 * Forge function entry points for rovo:agent / rovo:mcp actions.
 * Each exported function is referenced by a manifest `action` module handler.
 *
 * Forge invokes these as `(payload, context)`; the context is where the cloud ID
 * lives for Rovo and MCP calls, so it is threaded into the tool handlers.
 */
import { getContext, syncStatus, verifyImplementation } from './backend/actions';
import { readCloudId } from './backend/cloudId';

function cloudIdFrom(context: unknown): string | undefined {
  return readCloudId(context) ?? undefined;
}

export const specguardGetContext = async (payload: unknown, context?: unknown) =>
  getContext((payload ?? {}) as never, cloudIdFrom(context));

export const specguardVerifyImplementation = async (payload: unknown, context?: unknown) =>
  verifyImplementation((payload ?? {}) as never, cloudIdFrom(context));

export const specguardSyncStatus = async (payload: unknown) => syncStatus((payload ?? {}) as never);
