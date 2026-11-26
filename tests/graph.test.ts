import { beforeEach, describe, expect, it, vi } from 'vitest';

const forgeMocks = vi.hoisted(() => {
  const requestJira = vi.fn();
  const requestTeamworkGraph = vi.fn();
  const api = {
    asApp: () => ({ requestJira }),
    asUser: () => ({ requestJira, requestTeamworkGraph }),
  };
  const route = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (acc, part, index) => acc + part + (index < values.length ? String(values[index]) : ''),
      '',
    );
  return { api, route, requestJira, requestTeamworkGraph };
});

vi.mock('@forge/api', () => ({
  default: forgeMocks.api,
  api: forgeMocks.api,
  route: forgeMocks.route,
}));

const actionMocks = vi.hoisted(() => ({
  getContext: vi.fn(async () => ({ ok: true, data: {} })),
  verifyImplementation: vi.fn(async () => ({ ok: true, data: {} })),
  syncStatus: vi.fn(async () => ({ ok: true, data: {} })),
}));

vi.mock('../src/backend/actions', () => actionMocks);

const { readCloudId, resetCloudIdCache, resolveCloudId } = await import(
  '../src/backend/cloudId'
);
const { buildIssueAri, traverseGraph } = await import('../src/backend/contextFetcher');
const tools = await import('../src/tools');

const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('cloudId extraction', () => {
  beforeEach(() => {
    resetCloudIdCache();
    forgeMocks.requestJira.mockReset();
    forgeMocks.requestTeamworkGraph.mockReset();
  });

  it('reads cloudId from a resolver-style context', () => {
    expect(readCloudId({ cloudId: 'resolver-cloud', extension: { issue: { key: 'PAY-412' } } })).toBe(
      'resolver-cloud',
    );
  });

  it('reads cloudId from a Rovo/MCP context that nests the Forge context', () => {
    expect(readCloudId({ context: { cloudId: 'rovo-cloud' } })).toBe('rovo-cloud');
  });

  it('ignores blank or non-string cloudId values', () => {
    expect(readCloudId({ cloudId: '   ' })).toBeNull();
    expect(readCloudId({ cloudId: 42 })).toBeNull();
    expect(readCloudId(null)).toBeNull();
    expect(readCloudId('ari:cloud:jira::site/x')).toBeNull();
  });

  it('extracts the tenant UUID from a UI Kit 2 installContext ARI', () => {
    expect(
      readCloudId({ installContext: 'ari:cloud:jira::site/2dac9431-ae6d-461f-a35f-17b42a3b203e' }),
    ).toBe('2dac9431-ae6d-461f-a35f-17b42a3b203e');
    expect(
      readCloudId({
        installContext: 'ari:cloud:confluence::site/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0',
        siteUrl: 'https://one-atlas-deuz.atlassian.net',
      }),
    ).toBe('0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0');
    expect(readCloudId({ installContext: 'ari:cloud:jira::site/not-a-uuid' })).toBeNull();
  });

  it('reads extension.cloudId and a cloudId forwarded by the panel', async () => {
    expect(
      readCloudId({ extension: { cloudId: 'extension-cloud', issue: { key: 'PAY-412' } } }),
    ).toBe('extension-cloud');

    const resolution = await resolveCloudId('forwarded-cloud');

    expect(resolution).toMatchObject({ cloudId: 'forwarded-cloud', source: 'context' });
    expect(forgeMocks.requestJira).not.toHaveBeenCalled();
  });

  it('prefers the invocation context and never calls tenant_info when it is present', async () => {
    const resolution = await resolveCloudId({ cloudId: 'ctx-cloud' }, { cloudId: 'second-cloud' });

    expect(resolution).toMatchObject({ cloudId: 'ctx-cloud', source: 'context' });
    expect(forgeMocks.requestJira).not.toHaveBeenCalled();
  });

  it('never calls the non-existent tenant_info route when the context has no cloudId', async () => {
    const resolution = await resolveCloudId({});

    expect(resolution).toMatchObject({ cloudId: null, source: 'missing' });
    expect(resolution.detail).toContain('no cloud ID was supplied');
    expect(forgeMocks.requestJira).not.toHaveBeenCalled();
  });

  it('finds the tenant ARI anywhere in a Rovo/MCP context', async () => {
    const resolution = await resolveCloudId({
      accountId: '557058:8e1b',
      extension: { ari: 'ari:cloud:jira::site/2dac9431-ae6d-461f-a35f-17b42a3b203e' },
    });

    expect(resolution).toMatchObject({
      cloudId: '2dac9431-ae6d-461f-a35f-17b42a3b203e',
      source: 'context',
    });
    expect(forgeMocks.requestJira).not.toHaveBeenCalled();
  });

  it('caches a resolved cloudId for the rest of the runtime instance', async () => {
    await resolveCloudId({
      installContext: 'ari:cloud:jira::site/2dac9431-ae6d-461f-a35f-17b42a3b203e',
    });

    const second = await resolveCloudId({});

    expect(second).toMatchObject({
      cloudId: '2dac9431-ae6d-461f-a35f-17b42a3b203e',
      source: 'cache',
    });
    expect(forgeMocks.requestJira).not.toHaveBeenCalled();
  });

  it('threads the Rovo action context cloudId into the tool handlers', async () => {
    await tools.specguardGetContext({ issueKey: 'PAY-412' }, { cloudId: 'rovo-cloud' });
    expect(actionMocks.getContext).toHaveBeenCalledWith({ issueKey: 'PAY-412' }, 'rovo-cloud');

    await tools.specguardVerifyImplementation({ issueKey: 'PAY-412' }, { context: { cloudId: 'nested' } });
    expect(actionMocks.verifyImplementation).toHaveBeenCalledWith(
      { issueKey: 'PAY-412' },
      'nested',
    );
  });
});

describe('teamwork graph traversal', () => {
  beforeEach(() => {
    resetCloudIdCache();
    forgeMocks.requestJira.mockReset();
    forgeMocks.requestTeamworkGraph.mockReset();
  });

  it('builds an ARI only when both cloud ID and issue ID are present', () => {
    expect(buildIssueAri('cloud-1', '10001')).toBe('ari:cloud:jira:cloud-1:issue/10001');
    expect(buildIssueAri('  cloud-1  ', ' 10001 ')).toBe('ari:cloud:jira:cloud-1:issue/10001');
    expect(buildIssueAri('', '10001')).toBeNull();
    expect(buildIssueAri('cloud-1', '')).toBeNull();
    expect(buildIssueAri(null, null)).toBeNull();
  });

  it('queries the graph with the validated work-item ARI', async () => {
    forgeMocks.requestTeamworkGraph.mockResolvedValue(
      jsonResponse({
        data: {
          jiraWorkItemLinkedExternalPullRequests: {
            edges: [{ node: {} }, { node: {} }],
            pageInfo: { hasNextPage: false },
          },
        },
      }),
    );

    const traversal = await traverseGraph('10001', { cloudId: 'cloud-1', source: 'context' });

    expect(traversal.connected).toBe(true);
    expect(traversal.linkedPullRequests).toBe(2);
    expect(traversal.diagnostics).toMatchObject({
      attempted: true,
      cloudIdSource: 'context',
      ari: 'ari:cloud:jira:cloud-1:issue/10001',
    });
    expect(forgeMocks.requestTeamworkGraph).toHaveBeenCalledWith(expect.any(String), {
      id: 'ari:cloud:jira:cloud-1:issue/10001',
    });
  });

  it('skips the query when the cloud ID is missing and records why', async () => {
    const traversal = await traverseGraph('10001', {
      cloudId: null,
      source: 'missing',
      detail: 'HTTP 403',
    });

    expect(traversal.connected).toBe(false);
    expect(traversal.diagnostics).toMatchObject({ attempted: false, cloudIdSource: 'missing' });
    expect(traversal.diagnostics.reason).toContain('cloud ID');
    expect(forgeMocks.requestTeamworkGraph).not.toHaveBeenCalled();
  });

  it('skips the query when the issue ID is missing', async () => {
    const traversal = await traverseGraph(undefined, { cloudId: 'cloud-1', source: 'context' });

    expect(traversal.connected).toBe(false);
    expect(traversal.diagnostics.attempted).toBe(false);
    expect(traversal.diagnostics.reason).toContain('issue ID');
    expect(forgeMocks.requestTeamworkGraph).not.toHaveBeenCalled();
  });

  it('reports an HTTP failure as a diagnostic instead of throwing', async () => {
    forgeMocks.requestTeamworkGraph.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({}),
    });

    const traversal = await traverseGraph('10001', { cloudId: 'cloud-1', source: 'context' });

    expect(traversal.connected).toBe(false);
    expect(traversal.diagnostics).toMatchObject({ attempted: true, cloudIdSource: 'context' });
    expect(traversal.diagnostics.reason).toBe('request failed with HTTP 403');
  });

  it('reports an empty graph response with the API error message', async () => {
    forgeMocks.requestTeamworkGraph.mockResolvedValue(
      jsonResponse({
        data: { jiraWorkItemLinkedExternalPullRequests: null },
        errors: [{ message: 'Teamwork Graph preview is not enabled' }],
      }),
    );

    const traversal = await traverseGraph('10001', { cloudId: 'cloud-1', source: 'cache' });

    expect(traversal.connected).toBe(false);
    expect(traversal.diagnostics.reason).toBe('Teamwork Graph preview is not enabled');
    expect(traversal.diagnostics.ari).toBe('ari:cloud:jira:cloud-1:issue/10001');
  });

  it('reports a thrown client error without leaking a stack', async () => {
    forgeMocks.requestTeamworkGraph.mockRejectedValue(new Error('graph timeout'));

    const traversal = await traverseGraph('10001', { cloudId: 'cloud-1', source: 'context' });

    expect(traversal.connected).toBe(false);
    expect(traversal.diagnostics.reason).toBe('graph timeout');
  });
});
