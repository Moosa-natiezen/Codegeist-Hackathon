/**
 * Forge KVS persistence: latest verification, bounded audit history, ADR governance index.
 */
import storage from '@forge/kvs';
import type {
  AuditLogEntry,
  ConfluenceAdrRule,
  SpecContextBundle,
  VerificationResult,
} from './types';

export const HISTORY_LIMIT = 20;

export const keys = {
  latest: (issueKey: string) => `specguard:issue:${issueKey}:latest`,
  history: (issueKey: string) => `specguard:issue:${issueKey}:history`,
  bundle: (issueKey: string, bundleId: string) => `specguard:issue:${issueKey}:bundle:${bundleId}`,
  lastBundle: (issueKey: string) => `specguard:issue:${issueKey}:last-bundle`,
  adr: (pageId: string) => `specguard:adr:${pageId}:issues`,
  /** Parsed ADR rules written by the Confluence byline and read by the Jira panel. */
  cachedRule: (pageId: string) => `specguard:adr:${pageId}:cached_rule`,
  /** Page IDs whose rules the byline cached for one governed Jira issue. */
  cachedAdrs: (issueKey: string) => `specguard:issue:${issueKey}:cached_adrs`,
} as const;

export interface LatestState {
  result: VerificationResult;
  bundleId: string;
  bundleHash: string;
}

/** One page's parsed ADR rules, cached so a refused live read is not fatal. */
export interface CachedAdrPage {
  pageId: string;
  pageTitle: string;
  pageUrl?: string;
  rules: ConfluenceAdrRule[];
  /** Jira issues the rules were cached for (linked keys plus keys mentioned in the text). */
  issueKeys: string[];
  cachedAt: string;
}

/** Issue → cached ADR page IDs, so the panel can find rules no live link resolves. */
export interface CachedIssueAdrs {
  issueKeys: string[];
  pageIds: string[];
  updatedAt: string;
}

export interface AdrGovernanceIndex {
  pageId: string;
  pageTitle: string;
  issueKeys: string[];
  lastVerdict?: VerificationResult['verdict'];
  needsReReview: boolean;
  updatedAt: string;
}

/** Cheap content hash (FNV-1a) — stable across identical input, no crypto dependency. */
export function hashText(payload: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function hashBundle(bundle: SpecContextBundle): string {
  return hashText(
    JSON.stringify({
      issueKey: bundle.issueKey,
      criteria: bundle.criteria.map((criterion) => criterion.text),
      adrs: bundle.adrs.map((rule) => rule.text),
      dependencies: bundle.dependencies.map((dependency) => dependency.key),
    }),
  );
}

export async function saveBundle(
  bundle: SpecContextBundle,
): Promise<{ bundleId: string; bundleHash: string }> {
  const bundleHash = hashBundle(bundle);
  const bundleId = `${Date.parse(bundle.fetchedAt) || Date.now()}-${bundleHash}`;
  await storage.set(keys.bundle(bundle.issueKey, bundleId), { bundle, bundleHash });
  // Pointer so the panel can paint criteria/ADRs before any verification exists.
  await storage.set(keys.lastBundle(bundle.issueKey), bundleId);
  return { bundleId, bundleHash };
}

export async function loadLastBundleId(issueKey: string): Promise<string | null> {
  return (await storage.get<string>(keys.lastBundle(issueKey))) ?? null;
}

export async function loadBundle(
  issueKey: string,
  bundleId: string,
): Promise<{ bundle: SpecContextBundle; bundleHash: string } | null> {
  const stored = await storage.get<{ bundle: SpecContextBundle; bundleHash: string }>(
    keys.bundle(issueKey, bundleId),
  );
  return stored ?? null;
}

export async function saveLatest(issueKey: string, state: LatestState): Promise<void> {
  await storage.set(keys.latest(issueKey), state);
}

export async function loadLatest(issueKey: string): Promise<LatestState | null> {
  return (await storage.get<LatestState>(keys.latest(issueKey))) ?? null;
}

export async function appendAudit(entry: AuditLogEntry): Promise<AuditLogEntry[]> {
  const key = keys.history(entry.issueKey);
  const existing = (await storage.get<AuditLogEntry[]>(key)) ?? [];
  const next = [entry, ...existing].slice(0, HISTORY_LIMIT);
  await storage.set(key, next);
  return next;
}

export async function loadHistory(issueKey: string): Promise<AuditLogEntry[]> {
  return (await storage.get<AuditLogEntry[]>(keys.history(issueKey))) ?? [];
}

/** Maintains the ADR → governed issues index used by the Confluence byline. */
export async function indexAdrGovernance(
  rules: ConfluenceAdrRule[],
  issueKey: string,
  verdict: VerificationResult['verdict'],
): Promise<AdrGovernanceIndex[]> {
  const updated: AdrGovernanceIndex[] = [];
  const pageIds = new Set(rules.map((rule) => rule.pageId));

  for (const pageId of pageIds) {
    const pageTitle = rules.find((rule) => rule.pageId === pageId)?.pageTitle ?? pageId;
    const key = keys.adr(pageId);
    const existing = (await storage.get<AdrGovernanceIndex>(key)) ?? {
      pageId,
      pageTitle,
      issueKeys: [],
      needsReReview: false,
      updatedAt: new Date().toISOString(),
    };

    const issueKeys = existing.issueKeys.includes(issueKey)
      ? existing.issueKeys
      : [...existing.issueKeys, issueKey].slice(0, 100);

    const next: AdrGovernanceIndex = {
      ...existing,
      pageTitle,
      issueKeys,
      lastVerdict: verdict,
      updatedAt: new Date().toISOString(),
    };

    await storage.set(key, next);
    updated.push(next);
  }

  return updated;
}

export async function loadAdrGovernance(pageId: string): Promise<AdrGovernanceIndex | null> {
  return (await storage.get<AdrGovernanceIndex>(keys.adr(pageId))) ?? null;
}

export async function saveAdrGovernance(index: AdrGovernanceIndex): Promise<void> {
  await storage.set(keys.adr(index.pageId), index);
}

const ISSUE_KEY_PATTERN = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;

/** Jira issue keys named in rule text/title, plus the ones the caller already knows. */
export function issueKeysInAdrRules(
  rules: ConfluenceAdrRule[],
  known: string[] = [],
): string[] {
  const found = new Set(known.filter((key) => typeof key === 'string' && key.trim().length > 0));
  for (const rule of rules) {
    // Rule text only: ADR page titles carry doc ids like `ADR-014`, which are not issues.
    for (const match of rule.text.match(ISSUE_KEY_PATTERN) ?? []) found.add(match);
  }
  return [...found].slice(0, 50);
}

/**
 * Confluence → Jira bridge: stores a page's parsed ADR rules under
 * `specguard:adr:<pageId>:cached_rule` and links them to every referenced issue key
 * under `specguard:issue:<issueKey>:cached_adrs`. Returns `null` when there is nothing
 * worth caching, so an unreadable page never overwrites good rules with an empty list.
 */
export async function cacheAdrRules(
  pageId: string,
  pageTitle: string,
  rules: ConfluenceAdrRule[],
  knownIssueKeys: string[] = [],
  pageUrl?: string,
): Promise<CachedAdrPage | null> {
  if (rules.length === 0) return null;

  const issueKeys = issueKeysInAdrRules(rules, knownIssueKeys);
  const cached: CachedAdrPage = {
    pageId,
    pageTitle,
    pageUrl: pageUrl ?? rules[0]?.pageUrl,
    rules,
    issueKeys,
    cachedAt: new Date().toISOString(),
  };
  await storage.set(keys.cachedRule(pageId), cached);

  for (const issueKey of issueKeys) {
    const key = keys.cachedAdrs(issueKey);
    const existing = (await storage.get<CachedIssueAdrs>(key)) ?? {
      issueKeys: [],
      pageIds: [],
      updatedAt: cached.cachedAt,
    };
    await storage.set(key, {
      issueKeys: existing.issueKeys,
      pageIds: [...new Set([...existing.pageIds, pageId])].slice(0, 50),
      updatedAt: cached.cachedAt,
    });
  }

  return cached;
}

export async function loadCachedAdrPage(pageId: string): Promise<CachedAdrPage | null> {
  return (await storage.get<CachedAdrPage>(keys.cachedRule(pageId))) ?? null;
}

export async function loadCachedAdrPageIds(issueKey: string): Promise<string[]> {
  const cached = await storage.get<CachedIssueAdrs>(keys.cachedAdrs(issueKey));
  return (cached?.pageIds ?? []).filter((id): id is string => typeof id === 'string');
}
