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
  const client = () => ({ requestJira, requestConfluence: vi.fn() });
  const api = { asUser: client, asApp: client };
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

/** An issue that has no authored spec: no criteria, no ADR guardrails. */
const emptySpec = vi.hoisted(() => ({
  bundle: {
    issueKey: 'PAY-412',
    issue: {
      key: 'PAY-412',
      summary: 'Add retry handling',
      descriptionText: '',
      status: 'In Progress',
      issueType: 'Story',
      webLinks: [],
    },
    criteria: [],
    adrs: [],
    dependencies: [],
    warnings: ['No acceptance criteria were found in the issue description or subtasks.'],
    fetchedAt: '2026-11-25T10:00:00.000Z',
    graphSource: 'unavailable',
  } satisfies SpecContextBundle,
}));

const contextMocks = vi.hoisted(() => ({
  fetchContextBundle: vi.fn(async () => emptySpec.bundle),
}));

vi.mock('../src/backend/contextFetcher', () => ({
  fetchContextBundle: contextMocks.fetchContextBundle,
  fetchAdrRulesForPage: vi.fn(),
  dependenciesFromIssueLinks: vi.fn(() => []),
}));

const { runGuardrailCheck } = await import('../src/backend/index');
const { getContext, verifyImplementation } = await import('../src/backend/actions');
const { hasScorableSpec, NO_SPECS_ERROR_CODE, NO_SPECS_MESSAGE } = await import(
  '../src/backend/scoringEngine'
);

const issueContext = { extension: { issue: { key: 'PAY-412' } } };
const criteria = [{ id: 'AC-1', text: 'Retry on HTTP 429', source: 'description' as const }];

describe('empty-spec guard', () => {
  beforeEach(() => {
    forgeMocks.store.clear();
    contextMocks.fetchContextBundle.mockClear();
  });

  it('treats criteria or ADR rules as scorable and an empty spec as not', () => {
    expect(hasScorableSpec(emptySpec.bundle)).toBe(false);
    expect(hasScorableSpec({ criteria, adrs: [] })).toBe(true);
    expect(
      hasScorableSpec({
        criteria: [],
        adrs: [
          {
            pageId: '1001',
            pageTitle: 'ADR-014',
            kind: 'Must',
            text: 'Validate payloads before publish',
          },
        ],
      }),
    ).toBe(true);
  });

  it('refuses to score an issue with no criteria and no ADRs', async () => {
    const result = await verifyImplementation({
      issueKey: 'PAY-412',
      implementationSummary: 'Implemented the thing.',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: NO_SPECS_ERROR_CODE,
      message: NO_SPECS_MESSAGE,
    });
    expect(forgeMocks.store.has('specguard:issue:PAY-412:latest')).toBe(false);
  });

  it('returns an empty bundle from getContext instead of throwing', async () => {
    const result = await getContext({ issueKey: 'PAY-412' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.bundle.criteria).toEqual([]);
    expect(result.data.bundle.adrs).toEqual([]);
    expect(result.data.instructions).toContain('definition of done');
  });

  it('rejects the panel drift check instead of reporting 0% BLOCKED_OR_VIOLATION', async () => {
    await expect(
      runGuardrailCheck({
        context: issueContext,
        payload: { mode: 'verify', implementationSummary: 'Implemented the thing.' },
      }),
    ).rejects.toThrow(NO_SPECS_MESSAGE);
  });

  it('still loads context for an issue without a spec', async () => {
    const response = await runGuardrailCheck({
      context: issueContext,
      payload: { mode: 'context' },
    });

    expect(response.result).toBeNull();
    expect(response.bundle.criteria).toEqual([]);
    expect(response.bundleHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('forwards the panel cloudId into the context fetch', async () => {
    await runGuardrailCheck({
      context: issueContext,
      payload: { mode: 'context', cloudId: 'panel-cloud' },
    });

    expect(contextMocks.fetchContextBundle).toHaveBeenCalledWith('PAY-412', {
      cloudId: 'panel-cloud',
    });
  });
});
