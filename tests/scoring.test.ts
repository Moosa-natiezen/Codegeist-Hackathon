import { describe, expect, it } from 'vitest';
import { scoreImplementation, WEIGHTS } from '../src/backend/scoringEngine';
import type { SpecContextBundle } from '../src/backend/types';

function bundle(overrides: Partial<SpecContextBundle> = {}): SpecContextBundle {
  return {
    issueKey: 'PAY-412',
    issue: {
      key: 'PAY-412',
      summary: 'Add retry handling to the payment sync',
      descriptionText: '',
      status: 'In Progress',
      issueType: 'Story',
      webLinks: [],
    },
    criteria: [
      { id: 'AC-1', text: 'Retry the sync on HTTP 429 with backoff', source: 'description' },
      { id: 'AC-2', text: 'Emit an audit log entry for every retry', source: 'description' },
      { id: 'AC-3', text: 'Document the retry policy in the runbook', source: 'description' },
    ],
    adrs: [
      {
        pageId: '1001',
        pageTitle: 'ADR-014 Event Contracts',
        kind: 'Must',
        text: 'Validate payloads before publish',
      },
      {
        pageId: '1001',
        pageTitle: 'ADR-014 Event Contracts',
        kind: 'Must Not',
        text: 'Break the consumer contract without a version bump',
      },
    ],
    dependencies: [
      {
        key: 'PAY-300',
        relationship: 'is blocked by',
        summary: 'Schema registry rollout',
        resolved: true,
        status: 'Done',
      },
    ],
    warnings: [],
    fetchedAt: '2026-11-25T10:00:00.000Z',
    graphSource: 'teamwork-graph',
    ...overrides,
  };
}

const EXCELLENT_SUMMARY = [
  'Retry the sync on HTTP 429 with exponential backoff.',
  'Emit an audit log entry for every retry attempt.',
  'Document the retry policy in the runbook.',
  'Validate payloads before publish in the schema registry; avoid breaking the consumer contract without a version bump.',
].join(' ');

describe('scoreImplementation', () => {
  it('scores a fully compliant implementation as ALIGNED', () => {
    const result = scoreImplementation(bundle(), {
      issueKey: 'PAY-412',
      implementationSummary: EXCELLENT_SUMMARY,
      changedFiles: ['src/payments/sync.ts', 'docs/runbook.md'],
    });

    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result.verdict).toBe('ALIGNED');
    expect(result.weights).toEqual({ criteria: 50, adrs: 35, impact: 15 });
    expect(result.criteria.every((entry) => entry.status === 'met')).toBe(true);
    expect(result.findings.filter((finding) => finding.severity === 'blocker')).toHaveLength(0);
  });

  it('scores partial coverage as DRIFT_DETECTED', () => {
    const result = scoreImplementation(bundle(), {
      issueKey: 'PAY-412',
      implementationSummary: 'Retry the sync on HTTP 429 with backoff and validate payloads before publish.',
    });

    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.score).toBeLessThan(85);
    expect(result.verdict).toBe('DRIFT_DETECTED');
    expect(result.criteria.some((entry) => entry.status !== 'met')).toBe(true);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('flags an ADR violation as BLOCKED_OR_VIOLATION', () => {
    const result = scoreImplementation(bundle(), {
      issueKey: 'PAY-412',
      implementationSummary:
        'Break the consumer contract and skip a version bump to simplify the payload.',
    });

    expect(result.verdict).toBe('BLOCKED_OR_VIOLATION');
    expect(result.score).toBeLessThan(50);
    expect(result.adrs.some((entry) => entry.status === 'violated')).toBe(true);
    expect(result.findings.some((finding) => finding.severity === 'blocker')).toBe(true);
  });

  it('flags an unresolved blocker dependency that the summary ignores', () => {
    const result = scoreImplementation(
      bundle({
        dependencies: [
          {
            key: 'PAY-300',
            relationship: 'is blocked by',
            summary: 'Schema registry rollout',
            resolved: false,
            status: 'In Progress',
          },
        ],
      }),
      {
        issueKey: 'PAY-412',
        implementationSummary:
          'Retry the sync on HTTP 429 with backoff. Emit an audit log entry. Document the retry policy.',
      },
    );

    expect(result.dependencies[0]).toMatchObject({ key: 'PAY-300', mentioned: false });
    expect(result.findings.some((finding) => finding.message.includes('PAY-300'))).toBe(true);
  });

  it('is deterministic for identical inputs', () => {
    const request = { issueKey: 'PAY-412', implementationSummary: EXCELLENT_SUMMARY };
    const first = scoreImplementation(bundle(), request);
    const second = scoreImplementation(bundle(), request);

    expect(first.score).toBe(second.score);
    expect(first.verdict).toBe(second.verdict);
    expect(first.findings.map((finding) => finding.message)).toEqual(
      second.findings.map((finding) => finding.message),
    );
  });

  it('excludes no-evidence components and renormalizes rather than failing silently', () => {
    const result = scoreImplementation(
      bundle({ adrs: [], dependencies: [], criteria: [] }),
      { issueKey: 'PAY-412', implementationSummary: 'anything at all' },
    );

    expect(result.score).toBe(0);
    expect(result.verdict).toBe('BLOCKED_OR_VIOLATION');
    expect(result.findings.some((finding) => finding.source === 'bundle')).toBe(true);
    expect(WEIGHTS.criteria).toBe(50);
  });
});
