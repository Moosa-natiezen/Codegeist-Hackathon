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
};

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
  getAdrGovernanceState,
  getIssueSpecState,
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
