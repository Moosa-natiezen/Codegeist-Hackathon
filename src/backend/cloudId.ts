/**
 * `cloudId` resolution for Teamwork Graph calls.
 *
 * Forge invocations do not all carry the cloud ID on the same path: the UI Kit
 * resolver receives it on `context.cloudId`, while Rovo action / MCP handlers get
 * a context object that may nest it. When no invocation context supplies it, the
 * product's `/_edge/tenant_info` endpoint is the documented fallback. The value is
 * cached per runtime instance so a panel interaction does not repeat the lookup.
 */
import api, { route } from '@forge/api';
import type { CloudIdSource } from './types';

export interface CloudIdResolution {
  cloudId: string | null;
  source: CloudIdSource;
  /** Human-readable note explaining a missing cloud ID (never contains secrets). */
  detail?: string;
}

let cachedCloudId: string | null = null;

/** Clears the per-instance cache. Test seam only. */
export function resetCloudIdCache(): void {
  cachedCloudId = null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Reads `cloudId` from an invocation context. Handles `{ cloudId }`, the resolver
 * shape, and contexts that nest the Forge context one level down (`{ context }`).
 */
export function readCloudId(value: unknown, depth = 0): string | null {
  if (depth > 3) return null;
  const record = asRecord(value);
  if (!record) return null;

  const direct = nonEmptyString(record.cloudId);
  if (direct) return direct;

  const nested = record.context;
  if (nested !== undefined && nested !== value) return readCloudId(nested, depth + 1);
  return null;
}

async function requestTenantCloudId(identity: 'app' | 'user'): Promise<string | null> {
  const client = identity === 'app' ? api.asApp() : api.asUser();
  const response = await client.requestJira(route`/_edge/tenant_info`);
  if (!response.ok) throw new Error(`tenant_info ${response.status}`);
  const payload = (await response.json()) as { cloudId?: unknown };
  return nonEmptyString(payload.cloudId);
}

/**
 * Resolves the cloud ID from the first candidate that carries one, then the
 * instance cache, then `/_edge/tenant_info` (app identity first, user second).
 */
export async function resolveCloudId(...candidates: unknown[]): Promise<CloudIdResolution> {
  for (const candidate of candidates) {
    const fromContext = readCloudId(candidate);
    if (fromContext) {
      cachedCloudId = fromContext;
      return { cloudId: fromContext, source: 'context' };
    }
  }

  if (cachedCloudId) return { cloudId: cachedCloudId, source: 'cache' };

  const failures: string[] = [];
  for (const identity of ['app', 'user'] as const) {
    try {
      const fromTenantInfo = await requestTenantCloudId(identity);
      if (fromTenantInfo) {
        cachedCloudId = fromTenantInfo;
        return { cloudId: fromTenantInfo, source: 'tenant-info' };
      }
      failures.push(`${identity}: tenant_info returned no cloudId`);
    } catch (error) {
      failures.push(`${identity}: ${(error as Error).message}`);
    }
  }

  return {
    cloudId: null,
    source: 'missing',
    detail: failures.join('; ') || 'no cloud ID was supplied by the invocation context',
  };
}
