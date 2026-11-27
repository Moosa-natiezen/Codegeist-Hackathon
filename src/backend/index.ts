/**
 * @forge/resolver bridge for the UI Kit surfaces.
 *
 * Every endpoint is exported as a plain handler so it can be unit-tested without
 * the Forge runtime; `createResolver()` only wires those handlers to function keys.
 */
import Resolver from '@forge/resolver';
import { readCloudId } from './cloudId';
import { fetchAdrRulesForPage, fetchContextBundle } from './contextFetcher';
import { extractAdrRules } from './extract';
import { hasScorableSpec, NO_SPECS_MESSAGE, scoreImplementation } from './scoringEngine';
import {
  appendAudit,
  cacheAdrRules,
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
import type { AdrGovernanceIndex, LatestState } from './storage';
import type {
  AlignmentVerdict,
  AuditLogEntry,
  ConfluenceAdrRule,
  SpecContextBundle,
  SyncResult,
} from './types';
import type {
  AdrAggregate,
  AdrBylineIssue,
  AdrBylineState,
  AdrReevaluation,
  ClientAdrCacheResult,
  ClientAdrPagePayload,
  GuardrailCheckPayload,
  GuardrailCheckResponse,
  PanelContextPayload,
  PanelIssueState,
  SyncPayload,
} from './viewTypes';

export interface PanelContext {
  cloudId?: string;
  /** UI Kit 2 resolver contexts expose the tenant as `ari:cloud:jira::site/<uuid>`. */
  installContext?: string;
  accountId?: string;
  extension?: {
    issue?: { key?: string };
    content?: { id?: string };
    cloudId?: string;
    installContext?: string;
  };
}

export interface ResolverRequest<TPayload> {
  context: PanelContext;
  payload?: TPayload;
}

const PANEL_ACTOR = 'jira-issue-panel';

/**
 * The surface forwards `useProductContext().cloudId`; resolver contexts expose the same
 * tenant as a site ARI (`installContext`). Prefer the payload, then parse the context, so
 * the Teamwork Graph ARI is built from a real cloud ID.
 */
function cloudIdFor(context: PanelContext, payload?: { cloudId?: string }): string | undefined {
  return payload?.cloudId ?? readCloudId(context) ?? undefined;
}

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

/** Shared panel projection so every path returns the exact same shape (incl. page IDs). */
function panelStateFor(
  issueKey: string,
  bundle: SpecContextBundle | null,
  bundleHash: string | null,
  latest: LatestState | null,
  history: AuditLogEntry[],
  extraWarnings: string[] = [],
): PanelIssueState {
  return {
    issueKey,
    state: latest ? (latest.result.verdict === 'ALIGNED' ? 'aligned' : 'drift') : 'unverified',
    result: latest?.result ?? null,
    history,
    bundle,
    bundleHash,
    verifiedAt: latest?.result.evaluatedAt ?? null,
    agentSource: latest?.result.agentSource ?? null,
    warnings: [...(bundle?.warnings ?? []), ...extraWarnings],
    resolvedPageIds: bundle?.resolvedPageIds ?? [],
  };
}

/**
 * Panel payload: cached verification first, then the last stored bundle so criteria
 * and ADRs are visible (as not-verifiable) before the first verification.
 *
 * `refreshContext` (panel mount, Refresh, Retry) fetches live context so the criteria
 * appear without pressing "Get context"; a failed refresh degrades to the stored bundle
 * instead of blanking the panel.
 *
 * This handler never enforces `hasScorableSpec`: an issue with no criteria and no ADRs is
 * a normal, renderable state (the panel disables the drift check and shows the hint). Only
 * `runGuardrailCheck` and `specguard_verify_implementation` refuse to score.
 */
export async function getIssueSpecState({
  context,
  payload,
}: ResolverRequest<PanelContextPayload>): Promise<PanelIssueState> {
  const issueKey = issueKeyFrom(context);
  const refreshWarnings: string[] = [];
  let live: { bundle: SpecContextBundle; bundleHash: string } | null = null;

  if (payload?.refreshContext) {
    try {
      const bundle = await fetchContextBundle(issueKey, {
        cloudId: cloudIdFor(context, payload),
      });
      const saved = await saveBundle(bundle);
      live = { bundle, bundleHash: saved.bundleHash };
    } catch (error) {
      refreshWarnings.push(`Live context could not be refreshed: ${(error as Error).message}`);
    }
  }

  const [latest, history] = await Promise.all([loadLatest(issueKey), loadHistory(issueKey)]);

  if (latest) {
    const stored = await loadBundle(issueKey, latest.bundleId);
    return panelStateFor(
      issueKey,
      stored?.bundle ?? live?.bundle ?? null,
      latest.bundleHash || stored?.bundleHash || live?.bundleHash || null,
      latest,
      history,
      refreshWarnings,
    );
  }

  const bundleId = await loadLastBundleId(issueKey);
  const stored = bundleId ? await loadBundle(issueKey, bundleId) : null;

  return panelStateFor(
    issueKey,
    live?.bundle ?? stored?.bundle ?? null,
    live?.bundleHash ?? stored?.bundleHash ?? null,
    null,
    history,
    refreshWarnings,
  );
}

interface ClientAdrPage {
  pageId: string;
  pageTitle: string;
  pageUrl?: string;
  storageHtml: string;
  /** True when the body was pasted as text rather than read from a Confluence page. */
  manual: boolean;
}

const MANUAL_ADR_PAGE_ID = 'manual-adr';
const MANUAL_ADR_TITLE = 'Manually pasted ADR rules';

/** Escapes the characters that would otherwise be read as storage-format markup. */
function escapeStorageText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Turns pasted plain/markdown ADR text into storage-format paragraphs, so a page nobody
 * can read still goes through the same `extractAdrRules` path as a real page body.
 * One non-empty line per `<p>`, so `Decision: … / Must: … / Must Not: …` stays one rule each.
 */
function storageHtmlFromAdrText(rawText: string): string {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<p>${escapeStorageText(line)}</p>`)
    .join('\n');
}

/**
 * Validates a page body posted from the browser: numeric page ID, non-empty storage HTML.
 *
 * `rawText` (plain/markdown ADR rules pasted in the panel) is an accepted alternative to
 * `storageHtml` for issues whose linked page is unreadable. A pasted body may carry a
 * manual label instead of a page ID when the issue links no page at all — there is no
 * page to name — which keeps the KVS keys `specguard:adr:<label>:cached_rule` valid.
 */
function clientAdrPageFrom(payload: ClientAdrPagePayload | undefined): ClientAdrPage {
  const rawText = typeof payload?.rawText === 'string' ? payload.rawText : '';
  const manual = rawText.trim().length > 0;
  const requestedId = String(payload?.pageId ?? '').trim();

  let pageId = requestedId;
  if (manual && !/^\d+$/.test(requestedId)) {
    pageId = requestedId
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }
  if (pageId.length === 0) pageId = manual ? MANUAL_ADR_PAGE_ID : '';
  if (!/^\d+$/.test(pageId) && !manual) {
    throw new Error('A numeric Confluence page ID is required.');
  }

  const providedHtml = typeof payload?.storageHtml === 'string' ? payload.storageHtml : '';
  const storageHtml =
    providedHtml.trim().length > 0
      ? providedHtml
      : manual
        ? storageHtmlFromAdrText(rawText)
        : '';
  if (storageHtml.trim().length === 0) {
    throw new Error(
      `Confluence page ${pageId} returned an empty body, so no ADR rules could be extracted.`,
    );
  }

  return {
    pageId,
    pageTitle: payload?.title?.trim() || (manual ? MANUAL_ADR_TITLE : pageId),
    pageUrl: payload?.url?.trim() || undefined,
    storageHtml,
    manual,
  };
}

/**
 * Browser-session fallback for ADR resolution. When site/space settings refuse the
 * backend's `asApp()` read (HTTP 401 even with `read:confluence-content.all`), the panel
 * reads the page with the signed-in viewer's own session and posts the storage HTML here.
 * The panel may instead post `rawText` the viewer pasted, for a page nobody can read yet.
 *
 * The body is parsed with the same `extractAdrRules` the byline uses, cached in KVS
 * (`specguard:adr:<pageId>:cached_rule` + `specguard:issue:<issueKey>:cached_adrs`) so the
 * cache-aware `discoverAdrRules` also serves Rovo and the MCP tools, then the context is
 * re-fetched so the returned state already contains the hydrated rules.
 */
export async function ingestClientAdrPage({
  context,
  payload,
}: ResolverRequest<ClientAdrPagePayload>): Promise<PanelIssueState> {
  const { pageId, pageTitle, pageUrl, storageHtml, manual } = clientAdrPageFrom(payload);
  const issueKey = payload?.issueKey?.trim() || issueKeyFrom(context);

  const rules = extractAdrRules(storageHtml, { pageId, pageTitle, pageUrl });
  const cached = await cacheAdrRules(pageId, pageTitle, rules, [issueKey], pageUrl);
  console.log('[specguard] adr client ingest:', {
    issueKey,
    pageId,
    source: manual ? 'manual-text' : 'browser',
    ruleCount: rules.length,
    cachedIssueKeys: cached?.issueKeys ?? [],
  });

  const warnings: string[] = [];
  if (rules.length === 0) {
    warnings.push(
      `No Decision, Must or Must Not rules were found in ${
        manual ? 'the pasted ADR text' : `Confluence page ${pageId}`
      }, so nothing was cached.`,
    );
  }

  try {
    const bundle = await fetchContextBundle(issueKey, {
      cloudId: cloudIdFor(context, payload),
    });
    const saved = await saveBundle(bundle);
    const [latest, history] = await Promise.all([loadLatest(issueKey), loadHistory(issueKey)]);
    return panelStateFor(issueKey, bundle, saved.bundleHash, latest, history, warnings);
  } catch (error) {
    // The rules are cached already; degrade to the stored panel state rather than failing.
    warnings.push(
      `Context could not be refreshed after caching page ${pageId}: ${(error as Error).message}`,
    );
    const [latest, history] = await Promise.all([loadLatest(issueKey), loadHistory(issueKey)]);
    const bundleId = latest?.bundleId ?? (await loadLastBundleId(issueKey));
    const stored = bundleId ? await loadBundle(issueKey, bundleId) : null;
    return panelStateFor(
      issueKey,
      stored?.bundle ?? null,
      stored?.bundleHash ?? latest?.bundleHash ?? null,
      latest,
      history,
      warnings,
    );
  }
}

/**
 * Browser-session ADR cache for the Confluence byline: opening SpecGuard on an ADR page
 * guarantees its Decision / Must / Must Not rules reach KVS even when the page has no
 * governed Jira issue yet (the Jira panel path is `ingestClientAdrPage`).
 */
export async function cacheClientAdrPage({
  payload,
}: ResolverRequest<ClientAdrPagePayload>): Promise<ClientAdrCacheResult> {
  const page = clientAdrPageFrom(payload);
  const rules = extractAdrRules(page.storageHtml, {
    pageId: page.pageId,
    pageTitle: page.pageTitle,
    pageUrl: page.pageUrl,
  });
  const cached = await cacheAdrRules(page.pageId, page.pageTitle, rules, [], page.pageUrl);
  console.log('[specguard] adr client cache:', {
    pageId: page.pageId,
    ruleCount: rules.length,
    issueKeys: cached?.issueKeys ?? [],
  });

  return {
    pageId: page.pageId,
    pageTitle: page.pageTitle,
    ruleCount: rules.length,
    issueKeys: cached?.issueKeys ?? [],
    cachedAt: cached?.cachedAt ?? null,
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
  const bundle = await fetchContextBundle(issueKey, {
    cloudId: cloudIdFor(context, payload),
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

/**
 * Writes the page's parsed ADR rules to KVS so the Jira panel can still resolve
 * guardrails when Confluence refuses its own live read (this site does for 401/403).
 * Never throws: a caching failure must not break the byline.
 */
async function cachePageAdrRules(
  pageId: string,
  pageTitle: string,
  rules: ConfluenceAdrRule[],
  issueKeys: string[],
  pageUrl?: string,
): Promise<void> {
  try {
    const cached = await cacheAdrRules(pageId, pageTitle, rules, issueKeys, pageUrl);
    console.log('[specguard] adr cache write:', {
      pageId,
      ruleCount: cached?.rules.length ?? 0,
      issueKeys: cached?.issueKeys ?? [],
    });
  } catch (error) {
    console.warn('[specguard] adr cache write failed:', {
      pageId,
      reason: (error as Error).message,
    });
  }
}

/** Reads the byline's page and caches whatever rules it can extract; failures are logged only. */
async function refreshAdrRuleCache(pageId: string, issueKeys: string[]): Promise<void> {
  try {
    const fresh = await fetchAdrRulesForPage(pageId);
    await cachePageAdrRules(pageId, fresh.pageTitle, fresh.rules, issueKeys);
  } catch (error) {
    console.warn('[specguard] adr cache refresh skipped:', {
      pageId,
      reason: (error as Error).message,
    });
  }
}

/** Safe, secret-free diagnostic: the byline only reports where the cloud ID came from. */
function logBylineResolution(pageId: string, cloudId: string | undefined): void {
  console.log('[specguard] byline resolution:', { pageId, hasCloudId: Boolean(cloudId) });
}

/** Confluence byline state: governed issue count, drift status, per-issue scores. */
export async function getAdrGovernanceState({
  context,
  payload,
}: ResolverRequest<PanelContextPayload>): Promise<AdrBylineState> {
  const pageId = contentIdFrom(context);
  logBylineResolution(pageId, cloudIdFor(context, payload));
  const index = await loadAdrGovernance(pageId);
  // Bridge for the Jira panel: the byline holds (or can read) the ADR page body.
  await refreshAdrRuleCache(pageId, index?.issueKeys ?? []);
  return buildBylineState(pageId, index);
}

/**
 * Re-evaluate: re-reads the ADR page and flags every governed issue whose stored
 * governing rules no longer match the page, so the byline can show "needs re-review".
 * Scores are only refreshed by a new verification, which needs the implementation
 * summary the agent holds — this action never invents one.
 */
export async function reevaluateGovernedIssues({
  context,
  payload,
}: ResolverRequest<PanelContextPayload>): Promise<AdrReevaluation> {
  const pageId = contentIdFrom(context);
  logBylineResolution(pageId, cloudIdFor(context, payload));
  const index = await loadAdrGovernance(pageId);
  if (!index) {
    return { ...(await buildBylineState(pageId, null)), changedIssues: [] };
  }

  const fresh = await fetchAdrRulesForPage(pageId);
  // Re-evaluation already read the page: cache those rules for the Jira panel.
  await cachePageAdrRules(pageId, fresh.pageTitle, fresh.rules, index.issueKeys);
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
  resolver.define('ingestClientAdrPage', ingestClientAdrPage);
  resolver.define('cacheClientAdrPage', cacheClientAdrPage);
  resolver.define('runGuardrailCheck', runGuardrailCheck);
  resolver.define('syncVerificationToJira', syncVerificationToJira);
  resolver.define('getAdrGovernanceState', getAdrGovernanceState);
  resolver.define('reevaluateGovernedIssues', reevaluateGovernedIssues);

  return resolver;
}
