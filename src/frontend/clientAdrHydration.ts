/**
 * Browser-session ADR fallback.
 *
 * The Forge backend reads Confluence as the app installation. On sites whose space
 * settings refuse that identity (HTTP 401 even with `read:confluence-content.all`), a
 * linked ADR page is invisible to `discoverAdrRules` — but the person looking at the
 * panel can read it. This module reads the page with the viewer's own session through
 * `requestConfluence` from `@forge/bridge`, then hands the storage-format body to the
 * `ingestClientAdrPage` resolver, which extracts the rules, caches them in KVS and
 * returns the refreshed panel state.
 */
import { requestConfluence } from '@forge/bridge';
import { callResolver } from './resolverClient';
import type { ClientAdrPagePayload, PanelIssueState } from '../backend/viewTypes';

/** One page body read in the browser, plus what the panel knows about it. */
export interface ClientAdrPageBody {
  pageId: string;
  title?: string;
  url?: string;
  storageHtml: string;
}

/** `ADR page 5603635 could not be read: …` → `5603635` (also `Confluence page 5603635`). */
const PAGE_ID_IN_WARNING = /(?:adr|confluence)\s+page\s+(\d+)/gi;

/**
 * Page IDs worth hydrating: the linked IDs the resolver reported, plus any numeric page
 * named in an ADR warning (older cached bundles carry the warning but no ID list).
 */
export function adrCandidatePageIds(state: {
  resolvedPageIds?: readonly string[];
  warnings?: readonly string[];
}): string[] {
  const ids = new Set<string>();

  for (const id of state.resolvedPageIds ?? []) {
    const value = String(id ?? '').trim();
    if (/^\d+$/.test(value)) ids.add(value);
  }

  for (const warning of state.warnings ?? []) {
    if (typeof warning !== 'string') continue;
    PAGE_ID_IN_WARNING.lastIndex = 0;
    let match: RegExpExecArray | null = PAGE_ID_IN_WARNING.exec(warning);
    while (match !== null) {
      ids.add(match[1]);
      match = PAGE_ID_IN_WARNING.exec(warning);
    }
  }

  // A handful of pages at most: the panel hydrates one request per linked ADR.
  return [...ids].slice(0, 5);
}

function webUiPath(pageId: string, json: Record<string, unknown>): string {
  const links = json._links;
  if (links && typeof links === 'object') {
    const webui = (links as Record<string, unknown>).webui;
    if (typeof webui === 'string' && webui.trim().length > 0) return webui;
  }
  return `/wiki/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
}

/**
 * Reads a page's storage-format body as the signed-in user: v2 first, then the v1
 * endpoint (sites on older Confluence still answer only v1).
 */
export async function readClientAdrPage(pageId: string): Promise<ClientAdrPageBody> {
  const encoded = encodeURIComponent(pageId);
  const endpoints = [
    `/wiki/api/v2/pages/${encoded}?body-format=storage`,
    `/wiki/rest/api/content/${encoded}?expand=body.storage`,
  ];

  let lastError = 'the request failed';
  for (const endpoint of endpoints) {
    try {
      const response = await requestConfluence(endpoint);
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const json = (await response.json()) as Record<string, unknown>;
      const body = json.body as { storage?: { value?: unknown } } | undefined;
      const storageHtml = body?.storage?.value;
      if (typeof storageHtml === 'string' && storageHtml.trim().length > 0) {
        return {
          pageId,
          title: typeof json.title === 'string' ? json.title : undefined,
          url: webUiPath(pageId, json),
          storageHtml,
        };
      }
      lastError = 'the page body was empty';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(
    `Confluence page ${pageId} could not be read in your browser session (${lastError}).`,
  );
}

/**
 * Reads each page in the browser and ingests it, stopping as soon as the panel state
 * carries ADR rules. `readPage`/`ingest` are injectable so the flow is unit-testable.
 */
export async function hydrateAdrRulesFromBrowser(options: {
  issueKey: string;
  pageIds: readonly string[];
  cloudId?: string;
  readPage?: (pageId: string) => Promise<ClientAdrPageBody>;
  ingest?: (payload: ClientAdrPagePayload) => Promise<PanelIssueState>;
}): Promise<PanelIssueState | null> {
  const readPage = options.readPage ?? readClientAdrPage;
  const ingest =
    options.ingest ??
    ((payload: ClientAdrPagePayload) =>
      callResolver<PanelIssueState>('ingestClientAdrPage', payload));

  let updated: PanelIssueState | null = null;
  for (const pageId of options.pageIds) {
    const body = await readPage(pageId);
    updated = await ingest({
      issueKey: options.issueKey,
      pageId,
      title: body.title,
      url: body.url,
      storageHtml: body.storageHtml,
      cloudId: options.cloudId,
    });
    if ((updated.result?.adrs.length ?? 0) > 0 || (updated.bundle?.adrs.length ?? 0) > 0) break;
  }

  return updated;
}
