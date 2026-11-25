/**
 * State sync: posts a formatted ADF audit comment to Jira and toggles the drift label.
 */
import api, { route } from '@forge/api';
import type { SyncRequest, SyncResult, VerificationResult } from './types';

export const DRIFT_LABEL = 'spec-drift';

interface AdfDocument {
  type: 'doc';
  version: 1;
  content: unknown[];
}

const paragraph = (text: string): unknown => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

/** Builds the Jira comment body for a verification result (pure, unit-testable). */
export function buildAdfComment(result: VerificationResult): AdfDocument {
  const content: unknown[] = [
    {
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: `SpecGuard verification — ${result.score}% ${result.verdict}` }],
    },
    paragraph(
      `Weights: acceptance criteria ${result.weights.criteria}% · ADR guardrails ${result.weights.adrs}% · dependency impact ${result.weights.impact}%.`,
    ),
  ];

  if (result.findings.length > 0) {
    content.push({
      type: 'bulletList',
      content: result.findings.slice(0, 10).map((finding) => ({
        type: 'listItem',
        content: [paragraph(`[${finding.severity}] ${finding.source}: ${finding.message}`)],
      })),
    });
  } else {
    content.push(paragraph('No drift findings were recorded.'));
  }

  if (result.suggestions.length > 0) {
    content.push({
      type: 'heading',
      attrs: { level: 4 },
      content: [{ type: 'text', text: 'Remediation' }],
    });
    content.push({
      type: 'bulletList',
      content: result.suggestions.slice(0, 10).map((suggestion) => ({
        type: 'listItem',
        content: [paragraph(suggestion)],
      })),
    });
  }

  if (result.agentSource) {
    content.push(paragraph(`Submitted by agent: ${result.agentSource}.`));
  }

  return { type: 'doc', version: 1, content };
}

async function postComment(issueKey: string, result: VerificationResult): Promise<string | undefined> {
  const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body: buildAdfComment(result) }),
  });

  if (!response.ok) {
    throw new Error(`Failed to post Jira comment (${response.status})`);
  }

  const payload = (await response.json()) as { id?: string };
  return payload.id;
}

async function setDriftLabel(issueKey: string, add: boolean): Promise<void> {
  const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      update: { labels: [add ? { add: DRIFT_LABEL } : { remove: DRIFT_LABEL }] },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to update labels (${response.status})`);
  }
}

/** Applies a verification result to Jira state, reporting per-target outcomes. */
export async function syncVerification(
  request: SyncRequest,
  result: VerificationResult,
): Promise<SyncResult> {
  const warnings: string[] = [];
  let commentId: string | undefined;
  let commentPosted = false;
  let labelled = false;

  if (request.postComment) {
    try {
      commentId = await postComment(request.issueKey, result);
      commentPosted = true;
    } catch (error) {
      warnings.push(`Comment not posted: ${(error as Error).message}`);
    }
  }

  if (request.addDriftLabel) {
    try {
      await setDriftLabel(request.issueKey, result.verdict !== 'ALIGNED');
      labelled = true;
    } catch (error) {
      warnings.push(`Drift label not updated: ${(error as Error).message}`);
    }
  }

  return {
    issueKey: request.issueKey,
    commentId,
    labelled,
    commentPosted,
    warnings,
    syncedAt: new Date().toISOString(),
  };
}
