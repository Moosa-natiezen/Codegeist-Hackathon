/**
 * Pure view helpers shared by the UI Kit surfaces.
 *
 * No React and no `@forge/react` imports: this module is what the UI-state unit
 * tests exercise, so it stays free of runtime dependencies.
 */
import type { AlignmentVerdict, GraphDiagnostics } from '../backend/types';
import type { AdrBylineState } from '../backend/viewTypes';

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Reads a string from the product context's `extension` payload by path, e.g.
 * `['issue', 'key']` for Jira or `['content', 'id']` for Confluence.
 */
export function readExtensionPath(context: unknown, path: string[]): string | null {
  let current: unknown = asRecord(context)?.extension;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record) return null;
    current = record[segment];
  }
  return nonEmptyString(current);
}

export function readIssueKey(context: unknown): string | null {
  return readExtensionPath(context, ['issue', 'key']);
}

export function readPageId(context: unknown): string | null {
  return readExtensionPath(context, ['content', 'id']);
}

/**
 * Turns a product-relative path into an absolute URL when the site URL is known.
 * `Link` accepts relative paths, but a Confluence byline must link across products.
 */
export function absoluteUrl(siteUrl: string | null | undefined, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = nonEmptyString(siteUrl);
  if (!base) return path;
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Compact byline chip text: an ADR with no governed issues still shows a chip. */
export function governedChipLabel(
  state: Pick<AdrBylineState, 'governedCount' | 'driftCount'>,
): string {
  const governed = `${state.governedCount} governed issue${state.governedCount === 1 ? '' : 's'}`;
  if (state.governedCount === 0) return governed;
  return `${governed} · ${state.driftCount} drift`;
}

/** Short verdict labels keep the ~360px audit table from overflowing. */
export function shortVerdictLabel(verdict: AlignmentVerdict): string {
  if (verdict === 'ALIGNED') return 'Aligned';
  if (verdict === 'DRIFT_DETECTED') return 'Drift';
  return 'Blocked';
}

/** One-line explanation of the Teamwork Graph outcome for the Dependency Impact block. */
export function graphDiagnosticNote(diagnostics: GraphDiagnostics | undefined): string | null {
  if (!diagnostics) return null;
  if (!diagnostics.attempted) {
    return `Teamwork Graph not queried: ${diagnostics.reason ?? 'no cloud ID was available'}.`;
  }
  if (diagnostics.reason) {
    return `Teamwork Graph degraded: ${diagnostics.reason}.`;
  }
  return `Teamwork Graph connected (cloud ID from ${diagnostics.cloudIdSource}).`;
}

/** Guidance shown when no verification exists yet for the open issue. */
export function unverifiedHint(bundleLoaded: boolean): string {
  return bundleLoaded
    ? 'Context is loaded. Paste your implementation summary to score it against the criteria and ADRs.'
    : 'Press Get context to load the acceptance criteria and ADRs, then run a drift check with your implementation summary. Your coding agent can also call specguard_verify_implementation through MCP.';
}
