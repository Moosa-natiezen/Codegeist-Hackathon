import { describe, expect, it } from 'vitest';
import {
  adfToText,
  descriptionToText,
  extractAcceptanceCriteria,
  extractAdrRules,
  tokenize,
} from '../src/backend/extract';

const adfDoc = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Acceptance Criteria' }],
    },
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { state: 'TODO' },
          content: [{ type: 'text', text: 'Retry the sync on HTTP 429' }],
        },
        {
          type: 'taskItem',
          attrs: { state: 'DONE' },
          content: [{ type: 'text', text: 'Emit an audit log entry for every sync' }],
        },
      ],
    },
    { type: 'paragraph', content: [{ type: 'text', text: 'Ship behind a feature flag.' }] },
  ],
};

describe('adfToText', () => {
  it('flattens nested ADF into readable lines', () => {
    const text = adfToText(adfDoc);
    expect(text).toContain('Acceptance Criteria');
    expect(text).toContain('Retry the sync on HTTP 429');
    expect(text).toContain('Ship behind a feature flag.');
  });

  it('accepts plain strings unchanged', () => {
    expect(descriptionToText('  plain description  ')).toBe('plain description');
    expect(descriptionToText(null)).toBe('');
  });
});

describe('extractAcceptanceCriteria', () => {
  it('parses checkbox lists and keeps Jira checkbox state', () => {
    const criteria = extractAcceptanceCriteria(
      ['Acceptance Criteria:', '- [ ] Retry the sync on HTTP 429', '- [x] Emit an audit log entry'].join(
        '\n',
      ),
    );
    expect(criteria).toHaveLength(2);
    expect(criteria[0]).toMatchObject({ id: 'AC-1', checkedInJira: false });
    expect(criteria[0].text).toBe('Retry the sync on HTTP 429');
    expect(criteria[1]).toMatchObject({ id: 'AC-2', checkedInJira: true });
  });

  it('splits a single-line checklist into one criterion per item', () => {
    const criteria = extractAcceptanceCriteria(
      'Acceptance Criteria: - [ ] Item 1 - [ ] Item 2 - [ ] Item 3',
    );

    expect(criteria.map((criterion) => criterion.text)).toEqual(['Item 1', 'Item 2', 'Item 3']);
    expect(criteria.map((criterion) => criterion.id)).toEqual(['AC-1', 'AC-2', 'AC-3']);
    expect(criteria.every((criterion) => criterion.checkedInJira === false)).toBe(true);
  });

  it('keeps checkbox state when inline items mix done and open markers', () => {
    const criteria = extractAcceptanceCriteria('- [x] Ship the migration * [ ] Drop the old table');

    expect(criteria.map((criterion) => criterion.text)).toEqual([
      'Ship the migration',
      'Drop the old table',
    ]);
    expect(criteria.map((criterion) => criterion.checkedInJira)).toEqual([true, false]);
  });

  it('reads bullets nested under an acceptance criteria heading', () => {
    const criteria = extractAcceptanceCriteria(
      ['## Acceptance Criteria', '- panel shows the score', '- sync is idempotent'].join('\n'),
    );
    expect(criteria.map((criterion) => criterion.text)).toEqual([
      'panel shows the score',
      'sync is idempotent',
    ]);
  });

  it('falls back to all bullets when no heading is present', () => {
    const criteria = extractAcceptanceCriteria('- first item\n- second item');
    expect(criteria).toHaveLength(2);
  });

  it('returns nothing for empty text', () => {
    expect(extractAcceptanceCriteria('')).toEqual([]);
  });

  it('tags subtask origin', () => {
    const criteria = extractAcceptanceCriteria('- [ ] subtask criterion', {
      source: 'subtask',
      subtaskKey: 'PAY-2',
    });
    expect(criteria[0]).toMatchObject({ source: 'subtask', subtaskKey: 'PAY-2' });
  });
});

describe('extractAdrRules', () => {
  const page = { pageId: '1001', pageTitle: 'ADR-014 Event Contracts' };

  it('extracts Must / Must Not / Constraints rules from storage HTML', () => {
    const html = [
      '<h2>Decision</h2>',
      '<p>We will use schema-registry validation for every published event.</p>',
      '<h2>Must</h2>',
      '<ul><li>Validate payloads before publish</li><li>Version every schema change</li></ul>',
      '<h2>Must Not</h2>',
      '<ul><li>Break the consumer contract without a major version bump</li></ul>',
      '<h2>Constraints</h2>',
      '<ul><li>No synchronous calls between domains</li></ul>',
    ].join('');

    const rules = extractAdrRules(html, page);
    expect(rules.length).toBeGreaterThanOrEqual(5);
    expect(rules.filter((rule) => rule.kind === 'Must')).toHaveLength(2);
    expect(rules.some((rule) => rule.kind === 'Must Not')).toBe(true);
    expect(rules.some((rule) => rule.kind === 'Constraints')).toBe(true);
    expect(rules.every((rule) => rule.pageId === '1001')).toBe(true);
  });

  it('returns nothing for an empty body', () => {
    expect(extractAdrRules('', page)).toEqual([]);
  });
});

describe('Jira checklist ADF', () => {
  it('parses taskList / taskItem nodes into acceptance criteria with checkbox state', () => {
    const criteria = extractAcceptanceCriteria(descriptionToText(adfDoc));

    expect(criteria.map((criterion) => criterion.text)).toEqual([
      'Retry the sync on HTTP 429',
      'Emit an audit log entry for every sync',
    ]);
    expect(criteria[0].checkedInJira).toBe(false);
    expect(criteria[1].checkedInJira).toBe(true);
  });
});

describe('tokenize', () => {
  it('drops stop words and short tokens', () => {
    expect(tokenize('The panel must show an alignment score')).toEqual([
      'panel',
      'show',
      'alignment',
      'score',
    ]);
  });
});
