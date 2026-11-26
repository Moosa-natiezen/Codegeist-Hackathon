/**
 * @forge/resolver bridge for the UI Kit surfaces.
 *
 * Every endpoint is exported as a plain handler so it can be unit-tested without
 * the Forge runtime; `createResolver()` only wires those handlers to function keys.
 */
import Resolver from '@forge/resolver';
import { fetchAdrRulesForPage, fetchContextBundle } from './contextFetcher';
import { hasScorableSpec, NO_SPECS_MESSAGE, scoreImplementation } from './scoringEngine';
import {
  appendAudit,
  hashText,
  indexAdrGovernance,
  loadAdrGovernance,
  loadBundle,
  loadHistory,
  loadLastBundleId,
  loadLatest,
  saveAdrGovernance,
  saveBundle,
  saveLatest,
} from './storage';
import { syncVerification } from './syncEngine';
import type { AdrGovernanceIndex } from './storage';
import type {
  AlignmentVerdict,
  ConfluenceAdrRule,
  SyncResult,
} from './types';
import type {
  AdrAggregate,
  AdrBylineIssue,
  AdrBylineState,
  AdrReevaluation,
  GuardrailCheckPayload,
  GuardrailCheckResponse,
  PanelIssueState,
  SyncPayload,
} from './viewTypes';

export interface PanelContext {
  cloudId?: string;
  extension?: {
    issue?: { key?: string };
    content?: { id?: string };
  };
}

export interface ResolverRequest<TPayload> {
  context: PanelContext;
  payload?: TPayload;
}

const PANEL_ACTOR = 'jira-issue-panel';

function issueKeyFrom(context: PanelContext): string {
  const key = context.extension?.issue?.key;
  if (!key) throw new Error('SpecGuard must be opened from a Jira issue context.');
  return key;
}

function contentIdFrom(context: PanelContext): string {
  const pageId = context.extension?.content?.id;
  if (!pageId) throw new Error('SpecGuard byline requires a Confluence page context.');
  return pageId;
}

function rulesHash(rules: ConfluenceAdrRule[]): string {
  return hashText(rules.map((rule) => `${rule.kind}:${rule.text}`).sort().join('|'));
}

function aggregateFor(verdicts: Array<AlignmentVerdict | null>): AdrAggregate {
  const known = verdicts.filter((verdict): verdict is AlignmentVerdict => verdict !== null);
  if (known.some((verdict) => verdict === 'BLOCKED_OR_VIOLATION')) return 'danger';
  if (known.some((verdict) => verdict === 'DRIFT_DETECTED')) return 'warning';
  if (known.length > 0 && known.every((verdict) => verdict === 'ALIGNED')) return 'success';
  return 'default';
}

/**
 * Panel payload: cached verification first, then the last stored bundle so criteria
 * and ADRs are visible (as not-verifiable) before the first verification.
 */
export async function getIssueSpecState({
  context,
}: ResolverRequest<never>): Promise<PanelIssueState> {
  const issueKey = issueKeyFrom(context);
  const [latest, history] = await Promise.all([loadLatest(issueKey), loadHistory(issueKey)]);

  if (latest) {
    const stored = await loadBundle(issueKey, latest.bundleId);
    return {
      issueKey,
      state: latest.result.verdict === 'ALIGNED' ? 'aligned' : 'drift',
      result: latest.result,
      history,
      bundle: stored?.bundle ?? null,
      bundleHash: latest.bundleHash || (stored?.bundleHash ?? null),
      verifiedAt: latest.result.evaluatedAt,
      agentSource: latest.result.agentSource ?? null,
      warnings: stored?.bundle.warnings ?? [],
    };
  }

  const bundleId = await loadLastBundleId(issueKey);
  const stored = bundleId ? await loadBundle(issueKey, bundleId) : null;

  return {
    issueKey,
    state: 'unverified',
    result: null,
    history,
    bundle: stored?.bundle ?? null,
    bundleHash: stored?.bundleHash ?? null,
    verifiedAt: null,
    agentSource: null,
    warnings: stored?.bundle.warnings ?? [],
  };
}

/**
 * Fetches the Pre-Flight Context Bundle and, when an implementation summary is
 * supplied, scores it against that exact bundle snapshot.
 */
export async function runGuardrailCheck({
  context,
  payload,
}: ResolverRequest<GuardrailCheckPayload>): Promise<GuardrailCheckResponse> {
  const issueKey = issueKeyFrom(context);
  // Resolver contexts do not always carry a cloud ID; the panel forwards the one
  // it read from `useProductContext()`.
  const bundle = await fetchContextBundle(issueKey, {
    cloudId: payload?.cloudId ?? context.cloudId,
  });
  const saved = await saveBundle(bundle);
  const summary = (payload?.implementationSummary ?? '').trim();
  const mode = payload?.mode ?? 'verify';

  const recordContextFetch = async (): Promise<void> => {
    await appendAudit({
      id: `${Date.now()}-panel-context`,
      issueKey,
      action: 'get_context',
      actor: PANEL_ACTOR,
      detail: `${bundle.criteria.length} criteria · ${bundle.adrs.length} ADR rules · ${bundle.dependencies.length} dependencies`,
      timestamp: new Date().toISOString(),
    });
  };

  if (mode === 'context' || summary.length === 0) {
    await recordContextFetch();

    return {
      issueKey,
      bundleId: saved.bundleId,
      bundleHash: saved.bundleHash,
      bundle,
      result: null,
      warnings: bundle.warnings,
    };
  }

  // An issue with no criteria and no ADRs has nothing to score against: refuse
  // instead of reporting a misleading 0% BLOCKED_OR_VIOLATION.
  if (!hasScorableSpec(bundle)) {
    await recordContextFetch();
    throw new Error(NO_SPECS_MESSAGE);
  }

  const result = scoreImplementation(bundle, {
    issueKey,
    implementationSummary: summary,
    changedFiles: (payload?.changedFiles ?? []).filter(
      (file): file is string => typeof file === 'string',
    ),
    agentSource: PANEL_ACTOR,
  });

  await saveLatest(issueKey, {
    result,
    bundleId: saved.bundleId,
    bundleHash: saved.bundleHash,
  });
  await indexAdrGovernance(bundle.adrs, issueKey, result.verdict);
  await appendAudit({
    id: `${Date.now()}-panel-verify`,
    issueKey,
    action: 'verify',
    actor: PANEL_ACTOR,
    verdict: result.verdict,
    score: result.score,
    detail: `bundle ${saved.bundleHash} · ${result.findings.length} findings`,
    timestamp: result.evaluatedAt,
  });

  return {
    issueKey,
    bundleId: saved.bundleId,
    bundleHash: saved.bundleHash,
    bundle,
    result,
    warnings: bundle.warnings,
  };
}

/** Applies the stored verification to Jira: audit comment plus drift label. */
export async function syncVerificationToJira({
  context,
  payload,
}: ResolverRequest<SyncPayload>): Promise<SyncResult> {
  const issueKey = issueKeyFrom(context);
  const latest = await loadLatest(issueKey);
  if (!latest) throw new Error('Run a guardrail check before syncing.');

  const syncResult = await syncVerification(
    {
      issueKey,
      postComment: payload?.postComment ?? true,
      addDriftLabel: payload?.addDriftLabel ?? true,
    },
    latest.result,
  );

  await appendAudit({
    id: `${Date.now()}-panel-sync`,
    issueKey,
    action: 'sync',
    actor: PANEL_ACTOR,
    verdict: latest.result.verdict,
    score: latest.result.score,
    detail: `comment=${syncResult.commentPosted} label=${syncResult.labelled}`,
    timestamp: syncResult.syncedAt,
  });

  return syncResult;
}

async function buildBylineState(
  pageId: string,
  index: AdrGovernanceIndex | null,
): Promise<AdrBylineState> {
  if (!index) {
    return {
      pageId,
      pageTitle: null,
      governedCount: 0,
      driftCount: 0,
      issues: [],
      aggregate: 'default',
      needsReReview: false,
      lastEvaluatedAt: null,
    };
  }

  // Newest governed issues first; the byline shows five rows and counts the rest.
  const recentKeys = index.issueKeys.slice(-5).reverse();
  const issues: AdrBylineIssue[] = [];
  for (const key of recentKeys) {
    const latest = await loadLatest(key);
    issues.push({
      key,
      score: latest?.result.score ?? null,
      verdict: latest?.result.verdict ?? null,
      evaluatedAt: latest?.result.evaluatedAt ?? null,
    });
  }

  const evaluatedTimes = issues
    .map((issue) => issue.evaluatedAt)
    .filter((value): value is string => typeof value === 'string')
    .sort();

  return {
    pageId,
    pageTitle: index.pageTitle,
    governedCount: index.issueKeys.length,
    driftCount: issues.filter((issue) => issue.verdict !== null && issue.verdict !== 'ALIGNED')
      .length,
    issues,
    aggregate: aggregateFor(issues.map((issue) => issue.verdict)),
    needsReReview: index.needsReReview,
    lastEvaluatedAt: evaluatedTimes.length > 0 ? evaluatedTimes[evaluatedTimes.length - 1] : index.updatedAt,
  };
}

/** Confluence byline state: governed issue count, drift status, per-issue scores. */
export async function getAdrGovernanceState({
  context,
}: ResolverRequest<never>): Promise<AdrBylineState> {
  const pageId = contentIdFrom(context);
  return buildBylineState(pageId, await loadAdrGovernance(pageId));
}

/**
 * Re-evaluate: re-reads the ADR page and flags every governed issue whose stored
 * governing rules no longer match the page, so the byline can show "needs re-review".
 * Scores are only refreshed by a new verification, which needs the implementation
 * summary the agent holds — this action never invents one.
 */
export async function reevaluateGovernedIssues({
  context,
}: ResolverRequest<never>): Promise<AdrReevaluation> {
  const pageId = contentIdFrom(context);
  const index = await loadAdrGovernance(pageId);
  if (!index) {
    return { ...(await buildBylineState(pageId, null)), changedIssues: [] };
  }

  const fresh = await fetchAdrRulesForPage(pageId);
  const freshHash = rulesHash(fresh.rules);
  const changedIssues: string[] = [];

  for (const key of index.issueKeys) {
    const bundleId = await loadLastBundleId(key);
    const stored = bundleId ? await loadBundle(key, bundleId) : null;
    if (!stored) continue;

    const governing = stored.bundle.adrs.filter((rule) => rule.pageId === pageId);
    if (governing.length === 0) continue;
    if (rulesHash(governing) !== freshHash) changedIssues.push(key);
  }

  const next: AdrGovernanceIndex = {
    ...index,
    pageTitle: fresh.pageTitle || index.pageTitle,
    needsReReview: changedIssues.length > 0,
    updatedAt: new Date().toISOString(),
  };
  await saveAdrGovernance(next);

  return { ...(await buildBylineState(pageId, next)), changedIssues };
}

export function createResolver(): Resolver {
  const resolver = new Resolver();

  resolver.define('getIssueSpecState', getIssueSpecState);
  resolver.define('runGuardrailCheck', runGuardrailCheck);
  resolver.define('syncVerificationToJira', syncVerificationToJira);
  resolver.define('getAdrGovernanceState', getAdrGovernanceState);
  resolver.define('reevaluateGovernedIssues', reevaluateGovernedIssues);

  return resolver;
}
