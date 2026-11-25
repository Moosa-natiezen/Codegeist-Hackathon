/**
 * Context assembly: Jira issue + acceptance criteria, Confluence ADRs,
 * and Teamwork Graph dependency impact — with graceful degradation at every step.
 */
import api, { route } from '@forge/api';
import type { RequestInit as ForgeRequestInit, Route } from '@forge/api';
import { descriptionToText, extractAcceptanceCriteria, extractAdrRules } from './extract';
import type {
  ConfluenceAdrRule,
  GraphDependency,
  JiraIssueSummary,
  SpecContextBundle,
} from './types';

interface JiraIssuePayload {
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
  object?: { url?: string; title?: string };
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

function pageIdFromUrl(url: string): string | null {
  const byPath = /\/pages\/(\d+)/.exec(url);
  if (byPath) return byPath[1];
  const byQuery = /[?&]pageId=(\d+)/.exec(url);
  if (byQuery) return byQuery[1];
  return null;
}

interface AdrDiscovery {
  rules: ConfluenceAdrRule[];
  warnings: string[];
}

async function discoverAdrRules(issueKey: string, remoteLinks: string[]): Promise<AdrDiscovery> {
  const warnings: string[] = [];
  const rules: ConfluenceAdrRule[] = [];
  const pageIds = new Set<string>();

  for (const url of remoteLinks) {
    const id = pageIdFromUrl(url);
    if (id) pageIds.add(id);
  }

  // CQL fallback: pages mentioning the issue key (label/space convention per PRD).
  if (pageIds.size === 0) {
    try {
      const search = await requestConfluenceJson<{ results?: Array<{ content?: { id?: string } }> }>(
        route`/wiki/rest/api/search?cql=${`text ~ "${issueKey}"`}&limit=5`,
      );
      for (const result of search.results ?? []) {
        if (result.content?.id) pageIds.add(result.content.id);
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

interface GraphTraversal {
  dependencies: GraphDependency[];
  source: SpecContextBundle['graphSource'];
  warning?: string;
}

/**
 * Teamwork Graph traversal. The graph gateway is queried optimistically; on any failure we
 * degrade to Jira issue links and record a warning rather than failing the bundle.
 */
async function traverseGraph(issueKey: string): Promise<GraphTraversal> {
  const query = {
    query: `query SpecGuardDependencies($key: String!) {
      jira { issue(key: $key) { key links { relationship relatedIssue { key summary status } } } }
    }`,
    variables: { key: issueKey },
  };

  try {
    const data = await requestJiraJson<{
      data?: {
        jira?: {
          issue?: {
            links?: Array<{
              relationship?: string;
              relatedIssue?: { key?: string; summary?: string; status?: string };
            }>;
          };
        };
      };
    }>(route`/gateway/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
    });

    const links = data.data?.jira?.issue?.links ?? [];
    const dependencies: GraphDependency[] = links
      .filter((link) => Boolean(link.relatedIssue?.key))
      .map((link) => ({
        key: link.relatedIssue?.key as string,
        relationship: link.relationship ?? 'relates to',
        summary: link.relatedIssue?.summary ?? '',
        status: link.relatedIssue?.status,
        resolved: isResolvedStatus(link.relatedIssue?.status),
      }));

    if (dependencies.length > 0) {
      return { dependencies, source: 'teamwork-graph' };
    }
    return {
      dependencies: [],
      source: 'teamwork-graph',
      warning: 'Teamwork Graph returned no dependency edges for this issue.',
    };
  } catch (error) {
    return {
      dependencies: [],
      source: 'jira-links',
      warning: `Teamwork Graph traversal degraded to Jira issue links: ${(error as Error).message}`,
    };
  }
}

/**
 * Builds the Pre-Flight Context Bundle for an issue: criteria, ADR rules, dependencies.
 */
export async function fetchContextBundle(issueKey: string): Promise<SpecContextBundle> {
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

  let remoteLinks: string[] = [];
  try {
    const links = await requestJiraJson<RemoteLinkPayload[]>(
      route`/rest/api/3/issue/${issueKey}/remotelink`,
    );
    remoteLinks = links
      .map((link) => link.object?.url)
      .filter((url): url is string => typeof url === 'string');
    issueSummary.webLinks = remoteLinks;
  } catch (error) {
    warnings.push(`Remote links unavailable: ${(error as Error).message}`);
  }

  const adrDiscovery = await discoverAdrRules(issueKey, remoteLinks);
  warnings.push(...adrDiscovery.warnings);

  const graph = await traverseGraph(issueKey);
  if (graph.warning) warnings.push(graph.warning);

  const dependencies =
    graph.source === 'teamwork-graph' && graph.dependencies.length > 0
      ? graph.dependencies
      : dependenciesFromIssueLinks(issue);

  return {
    issueKey,
    issue: issueSummary,
    criteria: renumbered,
    adrs: adrDiscovery.rules,
    dependencies,
    warnings,
    fetchedAt: new Date().toISOString(),
    graphSource: graph.source,
  };
}
