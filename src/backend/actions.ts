/**
 * Tool handlers shared by the Rovo agent actions and the rovo:mcp server.
 * Input validation and error shaping live here so both surfaces behave identically.
 */
import { fetchContextBundle } from './contextFetcher';
import { scoreImplementation } from './scoringEngine';
import {
  appendAudit,
  hashBundle,
  indexAdrGovernance,
  loadBundle,
  loadLatest,
  saveBundle,
  saveLatest,
} from './storage';
import { syncVerification } from './syncEngine';
import type {
  AlignmentVerdict,
  SpecContextBundle,
  SyncResult,
  ToolResult,
  VerificationResult,
  VerificationRequest,
} from './types';

export interface GetContextInput {
  issueKey?: unknown;
  agentSource?: unknown;
}

export interface VerifyInput {
  issueKey?: unknown;
  implementationSummary?: unknown;
  changedFiles?: unknown;
  agentSource?: unknown;
  bundleId?: unknown;
}

export interface SyncInput {
  issueKey?: unknown;
  postComment?: unknown;
  addDriftLabel?: unknown;
  agentSource?: unknown;
}

export interface GetContextOutput {
  issueKey: string;
  bundleId: string;
  bundleHash: string;
  bundle: SpecContextBundle;
  instructions: string;
}

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;

function readIssueKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  return ISSUE_KEY_PATTERN.test(trimmed) ? trimmed : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function buildInstructions(bundle: SpecContextBundle): string {
  const lines = [
    `Treat the ${bundle.criteria.length} acceptance criteria below as the definition of done.`,
    bundle.adrs.length > 0
      ? `Respect the ${bundle.adrs.length} ADR guardrails; violations block merge.`
      : 'No ADR guardrails were resolved — confirm with the architect before changing design.',
    bundle.dependencies.some((dependency) => !dependency.resolved)
      ? 'Unresolved dependencies exist; naming them in your implementation summary is required.'
      : 'No unresolved dependencies were detected.',
  ];
  if (bundle.warnings.length > 0) {
    lines.push(`Warnings to surface to the user: ${bundle.warnings.join(' | ')}`);
  }
  return lines.join(' ');
}

/** specguard_get_context */
export async function getContext(input: GetContextInput): Promise<ToolResult<GetContextOutput>> {
  const issueKey = readIssueKey(input.issueKey);
  if (!issueKey) {
    return {
      ok: false,
      errorCode: 'INVALID_INPUT',
      message: 'issueKey must look like "PROJ-123".',
    };
  }

  try {
    const bundle = await fetchContextBundle(issueKey);
    const { bundleId, bundleHash } = await saveBundle(bundle);
    const actor = readString(input.agentSource) ?? 'specguard-mcp';

    await appendAudit({
      id: `${Date.now()}-get_context`,
      issueKey,
      action: 'get_context',
      actor,
      detail: `${bundle.criteria.length} criteria · ${bundle.adrs.length} ADR rules · ${bundle.dependencies.length} dependencies`,
      timestamp: new Date().toISOString(),
    });

    return {
      ok: true,
      data: { issueKey, bundleId, bundleHash, bundle, instructions: buildInstructions(bundle) },
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: 'CONTEXT_FETCH_FAILED',
      message: (error as Error).message,
    };
  }
}

/** specguard_verify_implementation */
export async function verifyImplementation(
  input: VerifyInput,
): Promise<ToolResult<VerificationResult>> {
  const issueKey = readIssueKey(input.issueKey);
  const summary = readString(input.implementationSummary);
  if (!issueKey) {
    return { ok: false, errorCode: 'INVALID_INPUT', message: 'issueKey must look like "PROJ-123".' };
  }
  if (!summary) {
    return {
      ok: false,
      errorCode: 'INVALID_INPUT',
      message: 'implementationSummary is required so the plan can be scored.',
    };
  }

  const changedFiles = Array.isArray(input.changedFiles)
    ? input.changedFiles.filter((file): file is string => typeof file === 'string')
    : [];

  const request: VerificationRequest = {
    issueKey,
    implementationSummary: summary,
    changedFiles,
    agentSource: readString(input.agentSource) ?? undefined,
  };

  try {
    let bundle: SpecContextBundle;
    let bundleId = readString(input.bundleId) ?? undefined;
    let bundleHash: string;

    if (bundleId) {
      const stored = await loadBundle(issueKey, bundleId);
      if (!stored) {
        return {
          ok: false,
          errorCode: 'BUNDLE_NOT_FOUND',
          message: `No stored bundle ${bundleId} for ${issueKey}; call specguard_get_context first.`,
        };
      }
      bundle = stored.bundle;
      bundleHash = stored.bundleHash;
    } else {
      bundle = await fetchContextBundle(issueKey);
      const saved = await saveBundle(bundle);
      bundleId = saved.bundleId;
      bundleHash = saved.bundleHash;
    }

    const result = scoreImplementation(bundle, request);

    await saveLatest(issueKey, { result, bundleId, bundleHash });
    await indexAdrGovernance(bundle.adrs, issueKey, result.verdict);
    await appendAudit({
      id: `${Date.now()}-verify`,
      issueKey,
      action: 'verify',
      actor: request.agentSource ?? 'specguard-mcp',
      verdict: result.verdict,
      score: result.score,
      detail: `bundle ${bundleHash} · ${result.findings.length} findings`,
      timestamp: result.evaluatedAt,
    });

    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, errorCode: 'VERIFICATION_FAILED', message: (error as Error).message };
  }
}

/** specguard_sync_status */
export async function syncStatus(input: SyncInput): Promise<ToolResult<SyncResult>> {
  const issueKey = readIssueKey(input.issueKey);
  if (!issueKey) {
    return { ok: false, errorCode: 'INVALID_INPUT', message: 'issueKey must look like "PROJ-123".' };
  }

  try {
    const latest = await loadLatest(issueKey);
    if (!latest) {
      return {
        ok: false,
        errorCode: 'NO_VERIFICATION',
        message: `No verification stored for ${issueKey}; run specguard_verify_implementation first.`,
      };
    }

    const result = await syncVerification(
      {
        issueKey,
        postComment: input.postComment !== false,
        addDriftLabel: input.addDriftLabel !== false,
      },
      latest.result,
    );

    await appendAudit({
      id: `${Date.now()}-sync`,
      issueKey,
      action: 'sync',
      actor: readString(input.agentSource) ?? 'specguard-mcp',
      verdict: latest.result.verdict as AlignmentVerdict,
      score: latest.result.score,
      detail: `comment=${result.commentPosted} label=${result.labelled}`,
      timestamp: result.syncedAt,
    });

    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, errorCode: 'SYNC_FAILED', message: (error as Error).message };
  }
}

export { hashBundle };
