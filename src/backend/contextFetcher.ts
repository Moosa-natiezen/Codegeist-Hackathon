/**
 * Context assembly: Jira issue + acceptance criteria, Confluence ADRs,
 * and Teamwork Graph dependency impact — with graceful degradation at every step.
 */
import api, { route } from '@forge/api';
import type { RequestInit as ForgeRequestInit, Route } from '@forge/api';
import { resolveCloudId } from './cloudId';
import type { CloudIdResolution } from './cloudId';
import { descriptionToText, extractAcceptanceCriteria, extractAdrRules } from './extract';
import type {
  ConfluenceAdrRule,
  GraphDependency,
  GraphDiagnostics,
  JiraIssueSummary,
  SpecContextBundle,
} from './types';

interface JiraIssuePayload {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    issuetype?: { name?: string };
    parent?: { key?: string; fields?: { summary?: string } };
    subtasks?: Array<{
      key: string;
      fields?: { summary?: string; description?: unknown; status?: { name?: string } };
    }>;
    issuelinks?: Array<{
      type?: { name?: string; inward?: string; outward?: string };
      inwardIssue?: { key?: string; fields?: { summary?: string; status?: { name?: string } } };
      outwardIssue?: { key?: string; fields?: { summary?: string; status?: { name?: string } } };
    }>;
  };
}

interface RemoteLinkPayload {
  object?: { url?: string; title?: string; globalId?: string };
}

/** A Jira remote link reduced to the fields that can identify a Confluence page. */
export interface RemoteLinkRef {
  url?: string;
  title?: string;
  /** Jira stores the Confluence page ID here, e.g. `appId=...&pageId=123` or a page ARI. */
  globalId?: string;
}

export interface ConfluencePagePayload {
  id: string;
  title: string;
  body?: { storage?: { value?: string } };
  _links?: { webui?: string; base?: string };
}

/** Runs a Jira request as the user, falling back to the app identity when user auth is unavailable. */
async function requestJiraJson<T>(path: Route, init?: ForgeRequestInit): Promise<T> {
  try {
    const response = await api.asUser().requestJira(path, init);
    if (response.ok) return (await response.json()) as T;
    throw new Error(`Jira ${response.status}`);
  } catch (userError) {
    const response = await api.asApp().requestJira(path, init);
    if (!response.ok) {
      throw new Error(
        `Jira request failed (${path}): user=${(userError as Error).message} app=${response.status}`,
      );
    }
    return (await response.json()) as T;
  }
}

async function requestConfluenceJson<T>(path: Route): Promise<T> {
  try {
    const response = await api.asUser().requestConfluence(path);
    if (response.ok) return (await response.json()) as T;
    throw new Error(`Confluence ${response.status}`);
  } catch (userError) {
    const response = await api.asApp().requestConfluence(path);
    if (!response.ok) {
      throw new Error(
        `Confluence request failed (${path}): user=${(userError as Error).message} app=${response.status}`,
      );
    }
    return (await response.json()) as T;
  }
}

function mapIssue(payload: JiraIssuePayload): JiraIssueSummary {
  return {
    key: payload.key,
    summary: payload.fields.summary ?? '',
    descriptionText: descriptionToText(payload.fields.description),
    status: payload.fields.status?.name ?? 'Unknown',
    issueType: payload.fields.issuetype?.name ?? 'Task',
    parentKey: payload.fields.parent?.key,
    parentSummary: payload.fields.parent?.fields?.summary,
    webLinks: [],
  };
}

/** Maps Jira issuelinks into graph-style dependency records (degraded graph source). */
export function dependenciesFromIssueLinks(payload: JiraIssuePayload): GraphDependency[] {
  const links = payload.fields.issuelinks ?? [];
  const dependencies: GraphDependency[] = [];

  for (const link of links) {
    const typeName = link.type?.name ?? 'relates to';
    if (link.inwardIssue?.key) {
      const status = link.inwardIssue.fields?.status?.name;
      dependencies.push({
        key: link.inwardIssue.key,
        relationship: link.type?.inward ?? typeName,
        summary: link.inwardIssue.fields?.summary ?? '',
        status,
        resolved: isResolvedStatus(status),
      });
    }
    if (link.outwardIssue?.key) {
      const status = link.outwardIssue.fields?.status?.name;
      dependencies.push({
        key: link.outwardIssue.key,
        relationship: link.type?.outward ?? typeName,
        summary: link.outwardIssue.fields?.summary ?? '',
        status,
        resolved: isResolvedStatus(status),
      });
    }
  }

  return dependencies;
}

function isResolvedStatus(status?: string): boolean {
  if (!status) return false;
  return /done|closed|resolved|complete|cancelled/i.test(status);
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Decodes URL-safe base64 into bytes without depending on a global `atob`. */
export function decodeBase64Url(value: string): number[] {
  const characters = value.trim().replace(/=+$/, '').split('');
  if (characters.length === 0 || characters.length % 4 === 1) return [];

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of characters) {
    const index = BASE64URL_ALPHABET.indexOf(character);
    if (index < 0) return [];
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return bytes;
}

/**
 * Confluence tiny links (`/wiki/x/<key>`) encode the numeric page ID as 64-bit
 * little-endian bytes in URL-safe base64. Decoding it recovers the page ID, so a
 * short ADR link still resolves without an extra search round trip.
 */
export function decodeConfluenceTinyKey(key: string): string | null {
  const bytes = decodeBase64Url(key);
  if (bytes.length === 0 || bytes.length > 8) return null;

  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index]);
  }

  return value > 0n ? value.toString() : null;
}

/** Reads a Confluence page ID from a canonical, query-string, or tiny page URL. */
export function pageIdFromUrl(url: string): string | null {
  const byPath = /\/pages\/(\d+)/.exec(url);
  if (byPath) return byPath[1];
  const byQuery = /[?&]pageId=(\d+)/.exec(url);
  if (byQuery) return byQuery[1];
  const byTiny = /\/x\/([A-Za-z0-9_-]+)/.exec(url);
  if (byTiny) return decodeConfluenceTinyKey(byTiny[1]);
  return null;
}

/** Reads a Confluence page ID from a Jira remote link (globalId first, then URL). */
export function pageIdFromRemoteLink(link: RemoteLinkRef): string | null {
  const globalId = typeof link.globalId === 'string' ? link.globalId : '';
  const fromGlobalId = /(?:^|[?&;,\s])pageId=(\d+)/.exec(globalId);
  if (fromGlobalId) return fromGlobalId[1];
  const fromAri = /:page\/(\d+)/.exec(globalId);
  if (fromAri) return fromAri[1];
  return typeof link.url === 'string' ? pageIdFromUrl(link.url) : null;
}

function escapeCqlTerm(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** CQL search limited to page IDs; callers degrade to a warning on failure. */
async function searchConfluencePageIds(cql: string): Promise<string[]> {
  const search = await requestConfluenceJson<{ results?: Array<{ content?: { id?: string } }> }>(
    route`/wiki/rest/api/search?cql=${cql}&limit=5`,
  );
  return (search.results ?? [])
    .map((result) => result.content?.id)
    .filter((id): id is string => typeof id === 'string');
}

function looksLikeConfluenceLink(link: RemoteLinkRef): boolean {
  return /\/wiki\b|\/confluence\b|confluence/i.test(`${link.url ?? ''} ${link.globalId ?? ''}`);
}

interface AdrDiscovery {
  rules: ConfluenceAdrRule[];
  warnings: string[];
}

/**
 * Re-reads one ADR page and re-extracts its guardrail rules.
 * Used by the Confluence byline's "Re-evaluate" action to detect ADR edits made
 * after the governed issues were last verified.
 */
export async function fetchAdrRulesForPage(
  pageId: string,
): Promise<{ pageId: string; pageTitle: string; rules: ConfluenceAdrRule[] }> {
  const page = await requestConfluenceJson<ConfluencePagePayload>(
    route`/wiki/api/v2/pages/${pageId}?body-format=storage`,
  );
  const pageTitle = page.title ?? `Page ${pageId}`;
  const pageUrl = page._links?.webui ? `${page._links.base ?? ''}${page._links.webui}` : undefined;

  return {
    pageId,
    pageTitle,
    rules: extractAdrRules(page.body?.storage?.value ?? '', { pageId, pageTitle, pageUrl }),
  };
}

async function discoverAdrRules(
  issueKey: string,
  remoteLinks: RemoteLinkRef[],
): Promise<AdrDiscovery> {
  const warnings: string[] = [];
  const rules: ConfluenceAdrRule[] = [];
  const pageIds = new Set<string>();
  const unresolvedTitles: string[] = [];

  for (const link of remoteLinks) {
    const id = pageIdFromRemoteLink(link);
    if (id) {
      pageIds.add(id);
      continue;
    }
    // A Confluence link whose URL carries no recoverable page ID is resolved by title.
    const title = typeof link.title === 'string' ? link.title.trim() : '';
    if (title.length > 0 && looksLikeConfluenceLink(link)) unresolvedTitles.push(title);
  }

  for (const title of unresolvedTitles) {
    try {
      for (const id of await searchConfluencePageIds(`title = "${escapeCqlTerm(title)}"`)) {
        pageIds.add(id);
      }
    } catch (error) {
      warnings.push(`Confluence title search unavailable: ${(error as Error).message}`);
    }
  }

  // CQL fallback: pages mentioning the issue key (label/space convention per PRD).
  if (pageIds.size === 0) {
    try {
      for (const id of await searchConfluencePageIds(`text ~ "${escapeCqlTerm(issueKey)}"`)) {
        pageIds.add(id);
      }
    } catch (error) {
      warnings.push(`Confluence ADR search unavailable: ${(error as Error).message}`);
    }
  }

  for (const pageId of pageIds) {
    try {
      const page = await requestConfluenceJson<ConfluencePagePayload>(
        route`/wiki/api/v2/pages/${pageId}?body-format=storage`,
      );
      const pageUrl = page._links?.webui
        ? `${page._links.base ?? ''}${page._links.webui}`
        : undefined;
      rules.push(
        ...extractAdrRules(page.body?.storage?.value ?? '', {
          pageId: page.id ?? pageId,
          pageTitle: page.title ?? `Page ${pageId}`,
          pageUrl,
        }),
      );
    } catch (error) {
      warnings.push(`ADR page ${pageId} could not be read: ${(error as Error).message}`);
    }
  }

  if (rules.length === 0) {
    warnings.push('No Confluence ADR guardrails were resolved for this issue.');
  }

  return { rules, warnings };
}

export interface GraphTraversal {
  connected: boolean;
  linkedPullRequests?: number;
  diagnostics: GraphDiagnostics;
}

/**
 * Builds the work-item ARI the graph query expects, or `null` when either half is
 * missing — an ARI with an empty cloud ID or issue ID is rejected by the graph and
 * would otherwise look like a real, empty result.
 */
export function buildIssueAri(
  cloudId: string | null | undefined,
  issueId: string | null | undefined,
): string | null {
  const trimmedCloudId = typeof cloudId === 'string' ? cloudId.trim() : '';
  const trimmedIssueId = typeof issueId === 'string' ? issueId.trim() : '';
  if (trimmedCloudId.length === 0 || trimmedIssueId.length === 0) return null;
  return `ari:cloud:jira:${trimmedCloudId}:issue/${trimmedIssueId}`;
}

/**
 * Teamwork Graph impact evidence.
 *
 * Teamwork Graph has no curated query for issue-to-issue links (that needs a registered
 * Cypher query), so issue dependencies come from Jira issue links and the graph contributes
 * the blast-radius signal it does expose: pull requests linked to this work item.
 *
 * The query selects only `__typename` so it stays valid regardless of the concrete union
 * member. Every failure path returns structured diagnostics instead of throwing, so the
 * panel can explain why impact is degraded.
 */
export async function traverseGraph(
  issueId: string | null | undefined,
  resolution: CloudIdResolution,
): Promise<GraphTraversal> {
  const diagnostics: GraphDiagnostics = {
    attempted: false,
    cloudIdSource: resolution.source,
  };

  if (!resolution.cloudId) {
    return {
      connected: false,
      diagnostics: {
        ...diagnostics,
        reason: 'cloud ID is unavailable, so the work-item ARI cannot be built',
      },
    };
  }

  const ari = buildIssueAri(resolution.cloudId, issueId);
  if (!ari) {
    return {
      connected: false,
      diagnostics: {
        ...diagnostics,
        reason: 'issue ID is unavailable, so the work-item ARI cannot be built',
      },
    };
  }

  diagnostics.attempted = true;
  diagnostics.ari = ari;

  const query = `query SpecGuardImpact($id: ID!) {
    jiraWorkItemLinkedExternalPullRequests(id: $id, first: 25) {
      edges { node { __typename } }
      pageInfo { hasNextPage }
    }
  }`;

  try {
    const response = await api.asUser().requestTeamworkGraph(query, { id: ari });

    if (!response.ok) {
      return {
        connected: false,
        diagnostics: { ...diagnostics, reason: `request failed with HTTP ${response.status}` },
      };
    }

    const payload = (await response.json()) as {
      data?: { jiraWorkItemLinkedExternalPullRequests?: { edges?: unknown[] } | null };
      errors?: Array<{ message?: string }>;
    };

    const connection = payload.data?.jiraWorkItemLinkedExternalPullRequests;
    if (!connection) {
      return {
        connected: false,
        diagnostics: {
          ...diagnostics,
          reason: payload.errors?.[0]?.message ?? 'no impact data was returned',
        },
      };
    }

    return {
      connected: true,
      linkedPullRequests: connection.edges?.length ?? 0,
      diagnostics,
    };
  } catch (error) {
    return {
      connected: false,
      diagnostics: { ...diagnostics, reason: (error as Error).message },
    };
  }
}

/**
 * Builds the Pre-Flight Context Bundle for an issue: criteria, ADR rules, dependencies.
 * `cloudId` (from the Forge invocation context) enables the Teamwork Graph call.
 */
export async function fetchContextBundle(
  issueKey: string,
  options: { cloudId?: string } = {},
): Promise<SpecContextBundle> {
  const warnings: string[] = [];
  const fields = [
    'summary',
    'description',
    'status',
    'issuetype',
    'parent',
    'subtasks',
    'issuelinks',
  ].join(',');

  const issue = await requestJiraJson<JiraIssuePayload>(
    route`/rest/api/3/issue/${issueKey}?fields=${fields}`,
  );

  const issueSummary = mapIssue(issue);

  const criteria = [...extractAcceptanceCriteria(issueSummary.descriptionText)];
  for (const subtask of issue.fields.subtasks ?? []) {
    const subtaskText = descriptionToText(subtask.fields?.description);
    const subtaskCriteria = extractAcceptanceCriteria(subtaskText, {
      source: 'subtask',
      subtaskKey: subtask.key,
    });
    criteria.push(...subtaskCriteria);
  }

  // Re-number criteria deterministically across description + subtasks.
  const renumbered = criteria.map((criterion, index) => ({ ...criterion, id: `AC-${index + 1}` }));

  if (renumbered.length === 0) {
    warnings.push('No acceptance criteria were found in the issue description or subtasks.');
  }

  let remoteLinks: RemoteLinkRef[] = [];
  try {
    const links = await requestJiraJson<RemoteLinkPayload[]>(
      route`/rest/api/3/issue/${issueKey}/remotelink`,
    );
    remoteLinks = links.map((link) => ({
      url: link.object?.url,
      title: link.object?.title,
      globalId: link.object?.globalId,
    }));
    issueSummary.webLinks = remoteLinks
      .map((link) => link.url)
      .filter((url): url is string => typeof url === 'string');
  } catch (error) {
    warnings.push(`Remote links unavailable: ${(error as Error).message}`);
  }

  const adrDiscovery = await discoverAdrRules(issueKey, remoteLinks);
  warnings.push(...adrDiscovery.warnings);

  const resolution = await resolveCloudId(options.cloudId);
  const graph = await traverseGraph(issue.id, resolution);
  if (!graph.connected) {
    warnings.push(
      `Teamwork Graph unavailable (${graph.diagnostics.reason ?? 'unknown reason'}); dependency impact comes from Jira issue links.`,
    );
  }

  const dependencies = dependenciesFromIssueLinks(issue);

  const graphSource: SpecContextBundle['graphSource'] = graph.connected
    ? 'teamwork-graph'
    : dependencies.length > 0
      ? 'jira-links'
      : 'unavailable';

  return {
    issueKey,
    issue: issueSummary,
    criteria: renumbered,
    adrs: adrDiscovery.rules,
    dependencies,
    warnings,
    fetchedAt: new Date().toISOString(),
    graphSource,
    linkedPullRequests: graph.linkedPullRequests,
    graphDiagnostics: graph.diagnostics,
  };
}
