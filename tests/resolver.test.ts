import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfluenceAdrRule, SpecContextBundle } from '../src/backend/types';

const forgeMocks = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  const requestJira = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'comment-1' }) }));
  const requestConfluence = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  const api = {
    asUser: () => ({ requestJira, requestConfluence }),
    asApp: () => ({ requestJira, requestConfluence }),
  };
  const route = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (acc, part, index) => acc + part + (index < values.length ? String(values[index]) : ''),
      '',
    );
  return { store, storage, api, route };
});

vi.mock('@forge/kvs', () => ({
  default: forgeMocks.storage,
  storage: forgeMocks.storage,
}));

vi.mock('@forge/api', () => ({
  default: forgeMocks.api,
  api: forgeMocks.api,
  route: forgeMocks.route,
}));

const adrRule: ConfluenceAdrRule = {
  pageId: '1001',
  pageTitle: 'ADR-014 Event Contracts',
  pageUrl: '/wiki/spaces/ARCH/pages/1001',
  kind: 'Must',
  text: 'Validate payloads before publish',
};

const fixtureBundle: SpecContextBundle = {
  issueKey: 'PAY-412',
  issue: {
    key: 'PAY-412',
    summary: 'Add retry handling',
    descriptionText: '',
    status: 'In Progress',
    issueType: 'Story',
    webLinks: [],
  },
  criteria: [
    { id: 'AC-1', text: 'Retry the sync on HTTP 429 with backoff', source: 'description' },
  ],
  adrs: [adrRule],
  dependencies: [],
  warnings: [],
  fetchedAt: '2026-11-25T10:00:00.000Z',
  graphSource: 'teamwork-graph',
  resolvedPageIds: ['1001'],
};

const adrStorageHtml = [
  '<h2>Decision</h2>',
  '<p>Decision: Adopt stateless JWTs with a 15 minute TTL.</p>',
  '<h2>Must Not</h2>',
  '<ul><li>Must Not: Store refresh tokens in localStorage.</li></ul>',
].join('');

const contextMocks = vi.hoisted(() => ({
  fetchContextBundle: vi.fn(),
  fetchAdrRulesForPage: vi.fn(),
}));

vi.mock('../src/backend/contextFetcher', () => ({
  fetchContextBundle: contextMocks.fetchContextBundle,
  fetchAdrRulesForPage: contextMocks.fetchAdrRulesForPage,
  dependenciesFromIssueLinks: vi.fn(() => []),
}));

const {
  cacheClientAdrPage,
  getAdrGovernanceState,
  getIssueSpecState,
  ingestClientAdrPage,
  reevaluateGovernedIssues,
  runGuardrailCheck,
  syncVerificationToJira,
} = await import('../src/backend/index');

const issueContext = { extension: { issue: { key: 'PAY-412' } } };
const pageContext = { extension: { content: { id: '1001' } } };

const implementationSummary =
  'Retry the sync on HTTP 429 with backoff; validate payloads before publish.';

describe('issue panel resolver', () => {
  beforeEach(() => {
    forgeMocks.store.clear();
    contextMocks.fetchContextBundle.mockClear();
    contextMocks.fetchContextBundle.mockResolvedValue(fixtureBundle);
    contextMocks.fetchAdrRulesForPage.mockResolvedValue({
      pageId: '1001',
      pageTitle: adrRule.pageTitle,
      rules: [adrRule],
    });
  });

  it('reports an empty unverified state before any bundle exists', async () => {
    const state = await getIssueSpecState({ context: issueContext });

    expect(state).toMatchObject({
      issueKey: 'PAY-412',
      state: 'unverified',
      result: null,
      bundle: null,
      bundleHash: null,
      history: [],
    });
  });

  it('threads the panel cloudId and refresh flag into the live context fetch', async () => {
    const state = await getIssueSpecState({
      context: {
        installContext: 'ari:cloud:jira::site/2dac9431-ae6d-461f-a35f-17b42a3b203e',
        extension: { issue: { key: 'PAY-412' } },
      },
      payload: { refreshContext: true },
    });

    // The resolver context only carries the site ARI; getContext gets its UUID.
    expect(contextMocks.fetchContextBundle).toHaveBeenCalledWith('PAY-412', {
      cloudId: '2dac9431-ae6d-461f-a35f-17b42a3b203e',
    });
    expect(state.bundle?.criteria[0].id).toBe('AC-1');
  });

  it('prefers the cloudId forwarded by useProductContext over the context ARI', async () => {
    await getIssueSpecState({
      context: {
        installContext: 'ari:cloud:jira::site/2dac9431-ae6d-461f-a35f-17b42a3b203e',
        extension: { issue: { key: 'PAY-412' } },
      },
      payload: { cloudId: 'panel-cloud', refreshContext: true },
    });

    expect(contextMocks.fetchContextBundle).toHaveBeenCalledWith('PAY-412', {
      cloudId: 'panel-cloud',
    });
  });

  it('keeps the stored state when a live refresh fails', async () => {
    contextMocks.fetchContextBundle.mockRejectedValueOnce(new Error('Jira HTTP 502'));

    const state = await getIssueSpecState({
      context: issueContext,
      payload: { refreshContext: true },
    });

    expect(state.state).toBe('unverified');
    expect(state.bundle).toBeNull();
    expect(state.warnings.join(' ')).toContain('Jira HTTP 502');
  });

  it('renders an empty spec without throwing when an issue has no criteria and no ADRs', async () => {
    contextMocks.fetchContextBundle.mockResolvedValueOnce({
      ...fixtureBundle,
      criteria: [],
      adrs: [],
      warnings: ['No acceptance criteria were found in the issue description or subtasks.'],
    });

    const state = await getIssueSpecState({
      context: issueContext,
      payload: { refreshContext: true },
    });

    expect(state.state).toBe('unverified');
    expect(state.result).toBeNull();
    expect(state.bundle?.criteria).toEqual([]);
    expect(state.bundle?.adrs).toEqual([]);
    expect(state.warnings.join(' ')).toContain('No acceptance criteria');
  });

  it('rejects when the panel is opened without a Jira issue context', async () => {
    await expect(getIssueSpecState({ context: {} })).rejects.toThrow(
      'SpecGuard must be opened from a Jira issue context.',
    );
  });

  it('loads the context bundle without scoring when no summary is supplied', async () => {
    const response = await runGuardrailCheck({
      context: issueContext,
      payload: { mode: 'context' },
    });

    expect(response.result).toBeNull();
    expect(response.bundle.criteria).toHaveLength(1);
    expect(response.bundleHash).toMatch(/^[0-9a-f]{8}$/);

    const state = await getIssueSpecState({ context: issueContext });
    expect(state.state).toBe('unverified');
    expect(state.bundle?.criteria[0].id).toBe('AC-1');
    expect(state.history[0].action).toBe('get_context');
    // The panel needs the linked page IDs to know what it can hydrate in the browser.
    expect(state.resolvedPageIds).toEqual(['1001']);
  });

  it('scores an implementation and exposes it to the panel', async () => {
    const response = await runGuardrailCheck({
      context: issueContext,
      payload: { mode: 'verify', implementationSummary },
    });

    expect(response.result).not.toBeNull();
    expect(response.result?.verdict).toBe('ALIGNED');
    expect(response.result?.score).toBe(100);
    expect(response.result?.adrs[0].pageUrl).toBe(adrRule.pageUrl);

    const state = await getIssueSpecState({ context: issueContext });
    expect(state.state).toBe('aligned');
    expect(state.result?.score).toBe(100);
    expect(state.bundleHash).toBe(response.bundleHash);
    expect(state.agentSource).toBe('jira-issue-panel');
    expect(state.history.map((entry) => entry.action)).toContain('verify');
  });

  it('refuses to sync before a verification exists', async () => {
    await expect(syncVerificationToJira({ context: issueContext })).rejects.toThrow(
      'Run a guardrail check before syncing.',
    );
  });

  it('syncs a stored verification to Jira and records the audit entry', async () => {
    await runGuardrailCheck({
      context: issueContext,
      payload: { mode: 'verify', implementationSummary },
    });

    const syncResult = await syncVerificationToJira({ context: issueContext });
    expect(syncResult.commentPosted).toBe(true);
    expect(syncResult.commentId).toBe('comment-1');
    expect(syncResult.labelled).toBe(true);

    const state = await getIssueSpecState({ context: issueContext });
    expect(state.history[0].action).toBe('sync');
  });
});

describe('confluence byline resolver', () => {
  beforeEach(() => {
    forgeMocks.store.clear();
    contextMocks.fetchContextBundle.mockClear();
    contextMocks.fetchContextBundle.mockResolvedValue(fixtureBundle);
    contextMocks.fetchAdrRulesForPage.mockResolvedValue({
      pageId: '1001',
      pageTitle: adrRule.pageTitle,
      rules: [adrRule],
    });
  });

  it('rejects when the byline has no Confluence page context', async () => {
    await expect(getAdrGovernanceState({ context: {} })).rejects.toThrow(
      'SpecGuard byline requires a Confluence page context.',
    );
  });

  it('returns a not-linked state for an ADR with no governed issues', async () => {
    const state = await getAdrGovernanceState({ context: pageContext });

    expect(state).toMatchObject({
      pageId: '1001',
      pageTitle: null,
      governedCount: 0,
      driftCount: 0,
      issues: [],
      aggregate: 'default',
      needsReReview: false,
    });
  });

  it('lists governed issues with their latest scores', async () => {
    await runGuardrailCheck({
      context: issueContext,
      payload: { mode: 'verify', implementationSummary },
    });

    const state = await getAdrGovernanceState({ context: pageContext });
    expect(state.governedCount).toBe(1);
    expect(state.driftCount).toBe(0);
    expect(state.aggregate).toBe('success');
    expect(state.issues[0]).toMatchObject({ key: 'PAY-412', score: 100, verdict: 'ALIGNED' });
  });

  it('flags governed issues whose ADR rules changed since verification', async () => {
    await runGuardrailCheck({
      context: issueContext,
      payload: { mode: 'verify', implementationSummary },
    });

    contextMocks.fetchAdrRulesForPage.mockResolvedValueOnce({
      pageId: '1001',
      pageTitle: adrRule.pageTitle,
      rules: [{ ...adrRule, text: 'Publish events through the outbox table' }],
    });

    const reevaluated = await reevaluateGovernedIssues({ context: pageContext });
    expect(reevaluated.changedIssues).toEqual(['PAY-412']);
    expect(reevaluated.needsReReview).toBe(true);

    const state = await getAdrGovernanceState({ context: pageContext });
    expect(state.needsReReview).toBe(true);
  });

  it('caches the page ADR rules into KVS so the Jira panel can resolve them', async () => {
    await runGuardrailCheck({
      context: issueContext,
      payload: { mode: 'verify', implementationSummary },
    });

    await getAdrGovernanceState({ context: pageContext });

    expect(forgeMocks.store.get('specguard:adr:1001:cached_rule')).toMatchObject({
      pageId: '1001',
      pageTitle: adrRule.pageTitle,
      rules: [adrRule],
    });
    expect(forgeMocks.store.get('specguard:issue:PAY-412:cached_adrs')).toMatchObject({
      pageIds: ['1001'],
    });
  });

  it('caches the freshly read rules during re-evaluation', async () => {
    await runGuardrailCheck({
      context: issueContext,
      payload: { mode: 'verify', implementationSummary },
    });

    contextMocks.fetchAdrRulesForPage.mockResolvedValueOnce({
      pageId: '1001',
      pageTitle: adrRule.pageTitle,
      rules: [{ ...adrRule, text: 'Publish events through the outbox table' }],
    });
    await reevaluateGovernedIssues({ context: pageContext });

    const cached = forgeMocks.store.get('specguard:adr:1001:cached_rule') as {
      rules: Array<{ text: string }>;
    };
    expect(cached.rules[0].text).toBe('Publish events through the outbox table');
  });

  it('clears the re-review flag when ADR rules are unchanged', async () => {
    await runGuardrailCheck({
      context: issueContext,
      payload: { mode: 'verify', implementationSummary },
    });

    const reevaluated = await reevaluateGovernedIssues({ context: pageContext });
    expect(reevaluated.changedIssues).toEqual([]);
    expect(reevaluated.needsReReview).toBe(false);
  });
});

describe('client ADR cache resolver (Confluence byline)', () => {
  const bylinePage = {
    pageId: '5472258',
    title: 'Stateless JWT Auth & Edge Caching Policy',
    url: '/wiki/spaces/ARCH/pages/5472258',
    storageHtml: adrStorageHtml,
  };

  beforeEach(() => {
    forgeMocks.store.clear();
  });

  it('caches the byline page rules without a governed Jira issue', async () => {
    const result = await cacheClientAdrPage({ context: pageContext, payload: bylinePage });

    expect(result).toMatchObject({
      pageId: '5472258',
      pageTitle: bylinePage.title,
      ruleCount: 2,
    });
    const cached = forgeMocks.store.get('specguard:adr:5472258:cached_rule') as {
      rules: ConfluenceAdrRule[];
    };
    expect(cached.rules.map((rule) => rule.kind)).toEqual(['Decision', 'Must Not']);
    expect(cached.rules.map((rule) => rule.text)).toEqual([
      'Adopt stateless JWTs with a 15 minute TTL.',
      'Store refresh tokens in localStorage.',
    ]);
  });

  it('rejects a non-numeric page id and an empty page body', async () => {
    await expect(
      cacheClientAdrPage({ context: pageContext, payload: { ...bylinePage, pageId: 'ADR-014' } }),
    ).rejects.toThrow('A numeric Confluence page ID is required.');

    await expect(
      cacheClientAdrPage({ context: pageContext, payload: { ...bylinePage, storageHtml: ' ' } }),
    ).rejects.toThrow('returned an empty body');
  });

  it('reports zero rules and leaves the cache empty for a page with no rules', async () => {
    const result = await cacheClientAdrPage({
      context: pageContext,
      payload: { ...bylinePage, storageHtml: '<p>Just prose about edge caching.</p>' },
    });

    expect(result.ruleCount).toBe(0);
    expect(result.cachedAt).toBeNull();
    expect(forgeMocks.store.get('specguard:adr:5472258:cached_rule')).toBeUndefined();
  });
});

describe('client ADR hydration resolver', () => {
  const restrictedContext = { extension: { issue: { key: 'CLSD-6' } } };

  beforeEach(() => {
    forgeMocks.store.clear();
    contextMocks.fetchContextBundle.mockReset();
    // Stands in for the cache-aware discoverAdrRules: the live page read is refused (401),
    // so the bundle carries exactly the rules the resolver just cached in KVS.
    contextMocks.fetchContextBundle.mockImplementation(async (issueKey: string) => {
      const cached = forgeMocks.store.get('specguard:adr:5603635:cached_rule') as
        | { rules: ConfluenceAdrRule[] }
        | undefined;
      const rules = cached?.rules ?? [];
      return {
        ...fixtureBundle,
        issueKey,
        criteria: [],
        adrs: rules,
        warnings:
          rules.length === 0
            ? ['No Confluence ADR guardrails were resolved for this issue.']
            : [],
        resolvedPageIds: ['5603635'],
      };
    });
  });

  it('extracts ADR rules from the browser page body, caches them, and returns them', async () => {
    const state = await ingestClientAdrPage({
      context: restrictedContext,
      payload: {
        issueKey: 'CLSD-6',
        pageId: '5603635',
        title: 'Stateless JWT Auth & Edge Caching Policy',
        url: '/wiki/spaces/ARCH/pages/5603635',
        storageHtml: adrStorageHtml,
      },
    });

    const cached = forgeMocks.store.get('specguard:adr:5603635:cached_rule') as {
      pageId: string;
      pageTitle: string;
      rules: ConfluenceAdrRule[];
      issueKeys: string[];
    };
    expect(cached).toMatchObject({
      pageId: '5603635',
      pageTitle: 'Stateless JWT Auth & Edge Caching Policy',
    });
    expect(cached.rules.map((rule) => rule.kind)).toEqual(['Decision', 'Must Not']);
    expect(cached.rules.map((rule) => rule.text)).toEqual([
      'Adopt stateless JWTs with a 15 minute TTL.',
      'Store refresh tokens in localStorage.',
    ]);
    expect(cached.issueKeys).toContain('CLSD-6');

    expect(forgeMocks.store.get('specguard:issue:CLSD-6:cached_adrs')).toMatchObject({
      pageIds: ['5603635'],
    });

    expect(state.issueKey).toBe('CLSD-6');
    expect(state.resolvedPageIds).toEqual(['5603635']);
    expect(state.bundle?.adrs.map((rule) => rule.text)).toEqual([
      'Adopt stateless JWTs with a 15 minute TTL.',
      'Store refresh tokens in localStorage.',
    ]);
  });

  it('takes the issue key from the resolver context when the payload omits it', async () => {
    await ingestClientAdrPage({
      context: restrictedContext,
      payload: { pageId: '5603635', storageHtml: adrStorageHtml },
    });

    const cached = forgeMocks.store.get('specguard:adr:5603635:cached_rule') as {
      issueKeys: string[];
    };
    expect(cached.issueKeys).toContain('CLSD-6');
    expect(forgeMocks.store.get('specguard:issue:CLSD-6:cached_adrs')).toBeTruthy();
  });

  it('rejects a non-numeric page id and an empty page body', async () => {
    await expect(
      ingestClientAdrPage({
        context: restrictedContext,
        payload: { pageId: 'not-a-page', storageHtml: adrStorageHtml },
      }),
    ).rejects.toThrow('A numeric Confluence page ID is required.');

    await expect(
      ingestClientAdrPage({
        context: restrictedContext,
        payload: { pageId: '5603635', storageHtml: '   ' },
      }),
    ).rejects.toThrow('returned an empty body');
  });

  it('keeps the cached rules when the ingested page carries no recognisable rules', async () => {
    await ingestClientAdrPage({
      context: restrictedContext,
      payload: { pageId: '5603635', storageHtml: adrStorageHtml },
    });

    const state = await ingestClientAdrPage({
      context: restrictedContext,
      payload: { pageId: '5603635', storageHtml: '<p>Just prose about edge caching.</p>' },
    });

    const cached = forgeMocks.store.get('specguard:adr:5603635:cached_rule') as {
      rules: ConfluenceAdrRule[];
    };
    expect(cached.rules).toHaveLength(2);
    expect(state.warnings.join(' ')).toContain('No Decision, Must or Must Not rules were found');
  });

});
