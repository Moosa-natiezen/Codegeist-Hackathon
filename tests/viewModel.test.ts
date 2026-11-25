import { describe, expect, it } from 'vitest';
import {
  absoluteUrl,
  governedChipLabel,
  graphDiagnosticNote,
  readIssueKey,
  readPageId,
  shortVerdictLabel,
  unverifiedHint,
} from '../src/frontend/viewModel';

describe('surface context paths', () => {
  it('reads the Jira issue key from the extension payload', () => {
    expect(readIssueKey({ extension: { issue: { key: 'PAY-412' } } })).toBe('PAY-412');
    expect(readIssueKey({ extension: { content: { id: '1001' } } })).toBeNull();
  });

  it('reads the Confluence page id from the extension payload', () => {
    expect(readPageId({ extension: { content: { id: '1001' } } })).toBe('1001');
    expect(readPageId({ extension: { issue: { key: 'PAY-412' } } })).toBeNull();
  });

  it('returns null instead of throwing for unresolved or malformed contexts', () => {
    expect(readIssueKey(undefined)).toBeNull();
    expect(readIssueKey(null)).toBeNull();
    expect(readIssueKey({})).toBeNull();
    expect(readIssueKey({ extension: {} })).toBeNull();
    expect(readIssueKey({ extension: { issue: {} } })).toBeNull();
    expect(readIssueKey({ extension: { issue: { key: '  ' } } })).toBeNull();
    expect(readPageId({ extension: { content: 'not-an-object' } })).toBeNull();
  });
});

describe('link building', () => {
  it('absolutises product-relative paths against the site URL', () => {
    expect(absoluteUrl('https://one-atlas-deuz.atlassian.net', '/browse/PAY-412')).toBe(
      'https://one-atlas-deuz.atlassian.net/browse/PAY-412',
    );
    expect(absoluteUrl('https://one-atlas-deuz.atlassian.net/', 'browse/PAY-412')).toBe(
      'https://one-atlas-deuz.atlassian.net/browse/PAY-412',
    );
  });

  it('falls back to the relative path when the site URL is unknown', () => {
    expect(absoluteUrl(null, '/browse/PAY-412')).toBe('/browse/PAY-412');
    expect(absoluteUrl(undefined, '/wiki/pages/viewpage.action?pageId=1001')).toBe(
      '/wiki/pages/viewpage.action?pageId=1001',
    );
  });

  it('leaves absolute URLs untouched', () => {
    expect(absoluteUrl('https://one-atlas-deuz.atlassian.net', 'https://x.test/a')).toBe(
      'https://x.test/a',
    );
  });
});

describe('byline chip empty state', () => {
  it('still renders a chip for an ADR with no governed issues', () => {
    expect(governedChipLabel({ governedCount: 0, driftCount: 0 })).toBe('0 governed issues');
  });

  it('uses singular wording and appends the drift count', () => {
    expect(governedChipLabel({ governedCount: 1, driftCount: 0 })).toBe('1 governed issue · 0 drift');
    expect(governedChipLabel({ governedCount: 3, driftCount: 2 })).toBe('3 governed issues · 2 drift');
  });
});

describe('verdict and diagnostic copy', () => {
  it('shortens verdicts for the narrow audit table', () => {
    expect(shortVerdictLabel('ALIGNED')).toBe('Aligned');
    expect(shortVerdictLabel('DRIFT_DETECTED')).toBe('Drift');
    expect(shortVerdictLabel('BLOCKED_OR_VIOLATION')).toBe('Blocked');
  });

  it('explains a skipped graph query', () => {
    expect(
      graphDiagnosticNote({ attempted: false, cloudIdSource: 'missing', reason: 'no cloud ID' }),
    ).toBe('Teamwork Graph not queried: no cloud ID.');
    expect(graphDiagnosticNote({ attempted: false, cloudIdSource: 'missing' })).toContain(
      'no cloud ID was available',
    );
  });

  it('explains a degraded and a connected graph query', () => {
    expect(
      graphDiagnosticNote({
        attempted: true,
        cloudIdSource: 'tenant-info',
        reason: 'request failed with HTTP 403',
      }),
    ).toBe('Teamwork Graph degraded: request failed with HTTP 403.');
    expect(graphDiagnosticNote({ attempted: true, cloudIdSource: 'tenant-info' })).toBe(
      'Teamwork Graph connected (cloud ID from tenant-info).',
    );
    expect(graphDiagnosticNote(undefined)).toBeNull();
  });

  it('guides an unverified issue towards the next action', () => {
    expect(unverifiedHint(false)).toContain('Get context');
    expect(unverifiedHint(true)).toContain('Context is loaded');
  });
});
