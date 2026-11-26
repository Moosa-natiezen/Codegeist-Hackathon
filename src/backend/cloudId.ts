/**
 * `cloudId` resolution for Teamwork Graph calls.
 *
 * Forge invocations do not all carry the cloud ID on the same path. UI Kit 2
 * resolvers receive a context whose tenant identity is exposed as `installContext`
 * (`ari:cloud:jira::site/<uuid>`) and/or `extension.cloudId` rather than a top-level
 * `cloudId`; Rovo action / MCP handlers get a context object that may nest it.
 *
 * There is deliberately no `/_edge/tenant_info` fallback: `requestJira` is scoped to
 * `/ex/jira/{cloudId}/...`, so that route does not exist and the lookup always failed.
 * The cloud ID has to come from the invocation context, or from a surface that forwards
 * `useProductContext().cloudId`. Resolution logs one secret-free diagnostic line and
 * caches the value per runtime instance.
 */
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

const SITE_ARI = /^ari:cloud:(?:jira|confluence)::site\/([0-9a-fA-F-]{8,})$/;

const CONTEXT_DEPTH_LIMIT = 3;

/**
 * Extracts the tenant UUID from a site-scoped ARI, the shape UI Kit 2 resolvers
 * expose as `context.installContext`: `ari:cloud:jira::site/<uuid>`.
 */
export function cloudIdFromSiteAri(value: unknown): string | null {
  const trimmed = nonEmptyString(value);
  if (!trimmed) return null;
  const match = SITE_ARI.exec(trimmed);
  return match ? match[1] : null;
}

/**
 * Normalizes a possible cloud ID value: a site ARI becomes its UUID, any other
 * non-empty string is already a cloud ID. Other ARIs carry no tenant identity.
 */
function normalizeCloudId(value: unknown): string | null {
  const trimmed = nonEmptyString(value);
  if (!trimmed) return null;
  if (/^ari:/i.test(trimmed)) return cloudIdFromSiteAri(trimmed);
  return trimmed;
}

/**
 * Finds the first site ARI anywhere in the context. `installContext` is the documented
 * path, but Rovo/MCP contexts have carried the tenant under `accountId` or a nested
 * `extension`, so the whole (small) context is scanned.
 */
function findSiteAri(value: unknown, depth = 0): string | null {
  if (depth > CONTEXT_DEPTH_LIMIT) return null;
  if (typeof value === 'string') return cloudIdFromSiteAri(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSiteAri(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) return null;
  for (const nested of Object.values(record)) {
    const found = findSiteAri(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Reads `cloudId` from an invocation context. Handles a raw cloud ID string, the
 * resolver shape (`cloudId`, `installContext`, `extension.cloudId`), contexts that
 * nest the Forge context one level down (`{ context }`), and any site ARI found
 * elsewhere in the context.
 */
export function readCloudId(value: unknown, depth = 0): string | null {
  if (depth > CONTEXT_DEPTH_LIMIT) return null;
  if (typeof value === 'string') return normalizeCloudId(value);

  const record = asRecord(value);
  if (!record) return null;

  const direct = normalizeCloudId(record.cloudId) ?? cloudIdFromSiteAri(record.installContext);
  if (direct) return direct;

  const extension = asRecord(record.extension);
  const fromExtension = extension
    ? (normalizeCloudId(extension.cloudId) ?? cloudIdFromSiteAri(extension.installContext))
    : null;
  if (fromExtension) return fromExtension;

  const nested = record.context;
  if (nested !== undefined && nested !== value) return readCloudId(nested, depth + 1);

  return findSiteAri(value, depth + 1);
}

function logResolution(resolution: CloudIdResolution): CloudIdResolution {
  // Safe to log: the value itself is never included, only where it came from.
  console.log('[specguard] cloudId resolution:', {
    source: resolution.source,
    hasCloudId: Boolean(resolution.cloudId),
  });
  return resolution;
}

/**
 * Resolves the cloud ID from the first candidate that carries one, then the instance
 * cache. Every candidate may be an ARI-carrying context or a raw cloud ID string.
 */
export async function resolveCloudId(...candidates: unknown[]): Promise<CloudIdResolution> {
  for (const candidate of candidates) {
    const fromContext = readCloudId(candidate);
    if (fromContext) {
      cachedCloudId = fromContext;
      return logResolution({ cloudId: fromContext, source: 'context' });
    }
  }

  if (cachedCloudId) return logResolution({ cloudId: cachedCloudId, source: 'cache' });

  return logResolution({
    cloudId: null,
    source: 'missing',
    detail:
      'no cloud ID was supplied by the invocation context; the panel forwards useProductContext().cloudId',
  });
}
