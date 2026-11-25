import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpecContextBundle } from '../src/backend/types';

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
  adrs: [
    {
      pageId: '1001',
      pageTitle: 'ADR-014 Event Contracts',
      kind: 'Must',
      text: 'Validate payloads before publish',
    },
  ],
  dependencies: [],
  warnings: [],
  fetchedAt: '2026-11-25T10:00:00.000Z',
  graphSource: 'teamwork-graph',
};

vi.mock('../src/backend/contextFetcher', () => ({
  fetchContextBundle: vi.fn(async () => fixtureBundle),
  dependenciesFromIssueLinks: vi.fn(() => []),
}));

const { getContext, syncStatus, verifyImplementation } = await import('../src/backend/actions');

describe('tool handlers', () => {
  beforeEach(() => {
    forgeMocks.store.clear();
  });

  it('rejects a malformed issue key', async () => {
    const result = await getContext({ issueKey: 'not-a-key' });
    expect(result).toEqual({
      ok: false,
      errorCode: 'INVALID_INPUT',
      message: 'issueKey must look like "PROJ-123".',
    });
  });

  it('returns a bundle with id, hash, and instructions', async () => {
    const result = await getContext({ issueKey: 'pay-412', agentSource: 'cursor' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.issueKey).toBe('PAY-412');
    expect(result.data.bundleHash).toMatch(/^[0-9a-f]{8}$/);
    expect(result.data.bundleId).toContain(result.data.bundleHash);
    expect(result.data.instructions).toContain('definition of done');
  });

  it('requires an implementation summary before verifying', async () => {
    const result = await verifyImplementation({ issueKey: 'PAY-412' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('INVALID_INPUT');
  });

  it('scores an implementation and persists the latest state', async () => {
    const result = await verifyImplementation({
      issueKey: 'PAY-412',
      implementationSummary:
        'Retry the sync on HTTP 429 with backoff and validate payloads before publish.',
      changedFiles: ['src/payments/sync.ts'],
      agentSource: 'freebuff',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.issueKey).toBe('PAY-412');
    expect(result.data.score).toBeGreaterThan(0);
    expect(['ALIGNED', 'DRIFT_DETECTED', 'BLOCKED_OR_VIOLATION']).toContain(result.data.verdict);
    expect(forgeMocks.store.has('specguard:issue:PAY-412:latest')).toBe(true);
    expect(forgeMocks.store.has('specguard:issue:PAY-412:history')).toBe(true);
  });

  it('refuses to sync without a stored verification', async () => {
    const result = await syncStatus({ issueKey: 'PAY-999' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('NO_VERIFICATION');
  });

  it('syncs a stored verification to Jira', async () => {
    await verifyImplementation({
      issueKey: 'PAY-412',
      implementationSummary:
        'Retry the sync on HTTP 429 with backoff; validate payloads before publish.',
    });

    const result = await syncStatus({ issueKey: 'PAY-412', postComment: true, addDriftLabel: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.commentPosted).toBe(true);
    expect(result.data.commentId).toBe('comment-1');
    expect(result.data.labelled).toBe(true);
  });
});
