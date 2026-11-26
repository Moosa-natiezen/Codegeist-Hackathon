/**
 * Pure extraction helpers: Jira ADF/markdown → plain text, acceptance criteria parsing,
 * and Confluence ADR rule parsing. Kept dependency-free so it is unit-testable.
 */
import type { AcceptanceCriterion, ConfluenceAdrRule, RuleKind } from './types';

/** Minimal ADF node shape (subset of Atlassian Document Format). */
export interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: string }>;
}

const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'listItem',
  'bulletList',
  'orderedList',
  'taskList',
  'taskItem',
  'blockquote',
  'codeBlock',
  'hardBreak',
  'rule',
  'table',
  'tableRow',
]);

/** Flattens ADF into newline-separated plain text, preserving list/paragraph boundaries. */
export function adfToText(node: unknown): string {
  const lines: string[] = [];

  const walk = (current: unknown, out: string[]): void => {
    if (!current || typeof current !== 'object') return;
    const n = current as AdfNode;
    if (n.type === 'text' && typeof n.text === 'string') {
      out.push(n.text);
      return;
    }
    if (!Array.isArray(n.content)) return;
    for (const child of n.content) {
      // Jira checklist items carry their state in `attrs.state`, not as text, so
      // render them as checkboxes — otherwise task lists are invisible to the
      // acceptance-criteria parser.
      if (child?.type === 'taskItem') {
        const buffer: string[] = [];
        walk(child, buffer);
        const itemText = buffer.join('').trim();
        if (itemText.length > 0) {
          const done = String(child.attrs?.state ?? '').toUpperCase() === 'DONE';
          lines.push(`- [${done ? 'x' : ' '}] ${itemText}`);
        }
        continue;
      }

      const isBlock = child?.type ? BLOCK_TYPES.has(child.type) : false;
      if (isBlock) {
        const buffer: string[] = [];
        walk(child, buffer);
        const line = buffer.join('').trim();
        if (line.length > 0) lines.push(line);
        else if (child.type === 'hardBreak') lines.push('');
      } else {
        walk(child, out);
      }
    }
  };

  if (typeof node === 'string') return node;
  walk(node, []);
  return lines.join('\n').trim();
}

/** Normalizes Jira description input that may be ADF, a string, or null. */
export function descriptionToText(description: unknown): string {
  if (typeof description === 'string') return description.trim();
  if (!description) return '';
  return adfToText(description);
}

const CHECKBOX_DONE = /^\s*(?:[-*]\s*)?\[(x|X)\]\s*/;
const CHECKBOX_OPEN = /^\s*(?:[-*]\s*)?\[\s?\]\s*/;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * Extracts acceptance criteria from description text.
 *
 * Recognised shapes:
 *  - checkbox lists: `- [ ] must retry on 429`
 *  - bullet/numbered lists nested under an "Acceptance Criteria" style heading
 *  - plain bullet lists when no heading is present (all bullets are criteria)
 */
export function extractAcceptanceCriteria(
  text: string,
  options: { source?: 'description' | 'subtask'; subtaskKey?: string } = {},
): AcceptanceCriterion[] {
  if (!text || text.trim().length === 0) return [];

  const lines = text.split(/\r?\n/);
  const criteria: AcceptanceCriterion[] = [];
  let inCriteriaSection = false;
  let sawHeading = false;
  const bulletsUnderHeading: string[] = [];
  const allBullets: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;

    const isHeading =
      /^#{1,6}\s+/.test(line) ||
      /^[A-Z][A-Za-z /&-]{2,40}:$/.test(line) ||
      /^(acceptance criteria|definition of done|ac)\b/i.test(line);

    if (isHeading) {
      sawHeading = true;
      inCriteriaSection = /acceptance criteria|definition of done|^\s*(ac|criteria)\b/i.test(line);
      continue;
    }

    const checkbox = CHECKBOX_DONE.exec(raw) ?? CHECKBOX_OPEN.exec(raw);
    if (checkbox) {
      const body = raw.replace(checkbox[0], '').trim();
      if (body.length > 0) {
        criteria.push({
          id: `AC-${criteria.length + 1}`,
          text: body,
          source: options.source ?? 'description',
          subtaskKey: options.subtaskKey,
          checkedInJira: CHECKBOX_DONE.test(raw),
        });
      }
      continue;
    }

    if (BULLET.test(raw)) {
      const body = raw.replace(BULLET, '').trim();
      if (body.length === 0) continue;
      allBullets.push(body);
      if (inCriteriaSection) bulletsUnderHeading.push(body);
    }
  }

  if (criteria.length > 0) return criteria;

  const chosen = sawHeading ? bulletsUnderHeading : allBullets;
  return chosen.map((body, index) => ({
    id: `AC-${index + 1}`,
    text: body,
    source: options.source ?? 'description',
    subtaskKey: options.subtaskKey,
  }));
}

const RULE_HEADING: Array<{ kind: RuleKind; pattern: RegExp }> = [
  { kind: 'Must Not', pattern: /^must\s+not\b|^mustn'?t\b|^prohibit/i },
  { kind: 'Must', pattern: /^must\b|^shall\b|^required\b/i },
  { kind: 'Constraints', pattern: /^constraints?\b|^limits?\b/i },
  { kind: 'Guardrails', pattern: /^guardrails?\b|^safeguards?\b/i },
  { kind: 'Decision', pattern: /^decision\b|^we\s+(?:will|decided)\b/i },
];

function classifyRule(line: string): RuleKind | null {
  const cleaned = line.replace(/^[-*•]\s+/, '').trim();
  for (const { kind, pattern } of RULE_HEADING) {
    if (pattern.test(cleaned)) return kind;
  }
  return null;
}

/**
 * Parses ADR rules from a page body (storage-format HTML already flattened, or markdown).
 * Recognises explicit `Decision`, `Must`, `Must Not`, `Constraints`, `Guardrails` statements;
 * bullets nested under such a heading inherit its kind.
 */
export function extractAdrRules(
  pageBody: string,
  page: { pageId: string; pageTitle: string; pageUrl?: string },
): ConfluenceAdrRule[] {
  if (!pageBody || pageBody.trim().length === 0) return [];

  const plain = pageBody
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(\/p|\/h[1-6]|br\s*\/?)>/gi, '\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');

  const rules: ConfluenceAdrRule[] = [];
  let currentKind: RuleKind | null = null;

  for (const raw of plain.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;

    const headingKind = classifyRule(line);
    if (headingKind) {
      currentKind = headingKind;
      // A statement that carries content ("Must: ..." or "Must not use X") is itself a rule;
      // a bare section label only sets the kind for the bullets that follow.
      const afterColon = line.split(':').slice(1).join(':').trim();
      const bareLabel = line
        .replace(/^[-*•]\s+/, '')
        .replace(/:$/, '')
        .trim()
        .split(/\s+/).length <= 3;
      const inline = afterColon.length >= 4 ? afterColon : bareLabel ? '' : line.replace(/^[-*•]\s+/, '').trim();
      if (inline.length >= 4) {
        rules.push({ ...page, kind: headingKind, text: inline });
      }
      continue;
    }

    if (BULLET.test(raw) && currentKind && !classifyRule(line)) {
      const body = raw.replace(BULLET, '').trim();
      if (body.length >= 4) rules.push({ ...page, kind: currentKind, text: body });
    }
  }

  return rules;
}

/** Lowercase word tokens, used by the deterministic scoring engine. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s._/-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'must',
  'should',
  'shall',
  'will',
  'are',
  'was',
  'were',
  'have',
  'has',
  'had',
  'not',
  'but',
  'all',
  'any',
  'can',
  'may',
  'when',
  'then',
  'than',
  'into',
  'out',
  'use',
  'used',
  'using',
  'add',
  'added',
  'new',
  'only',
  'each',
  'per',
]);
