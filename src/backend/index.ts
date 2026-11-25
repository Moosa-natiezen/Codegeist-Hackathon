/**
 * @forge/resolver bridge for the UI Kit panels.
 */
import Resolver from '@forge/resolver';
import { fetchContextBundle } from './contextFetcher';
import { scoreImplementation } from './scoringEngine';
import { appendAudit, loadAdrGovernance, loadHistory, loadLatest, saveLatest } from './storage';
import { syncVerification } from './syncEngine';
import type { VerificationResult } from './types';

interface IssuePanelContext {
  extension?: {
    issue?: { key?: string };
    content?: { id?: string };
  };
}

interface RunGuardrailCheckPayload {
  implementationSummary?: string;
  changedFiles?: string[];
}

interface SyncPayload {
  postComment?: boolean;
  addDriftLabel?: boolean;
}

function issueKeyFrom(context: IssuePanelContext): string {
  const key = context.extension?.issue?.key;
  if (!key) throw new Error('SpecGuard must be opened from a Jira issue context.');
  return key;
}

export function createResolver(): Resolver {
  const resolver = new Resolver();

  resolver.define('getIssueSpecState', async ({ context }: { context: IssuePanelContext }) => {
    const issueKey = issueKeyFrom(context);
    const latest = await loadLatest(issueKey);
    const history = await loadHistory(issueKey);

    if (!latest) {
      return {
        issueKey,
        state: 'unverified' as const,
        result: null,
        history,
      };
    }

    return {
      issueKey,
      state: latest.result.verdict === 'ALIGNED' ? ('aligned' as const) : ('drift' as const),
      result: latest.result,
      history,
    };
  });

  resolver.define(
    'runGuardrailCheck',
    async ({ context, payload }: { context: IssuePanelContext; payload?: RunGuardrailCheckPayload }) => {
      const issueKey = issueKeyFrom(context);
      const bundle = await fetchContextBundle(issueKey);
      const result: VerificationResult = scoreImplementation(bundle, {
        issueKey,
        implementationSummary: payload?.implementationSummary ?? '',
        changedFiles: payload?.changedFiles ?? [],
        agentSource: 'jira-issue-panel',
      });

      await saveLatest(issueKey, { result, bundleId: bundle.fetchedAt, bundleHash: '' });
      await appendAudit({
        id: `${Date.now()}-panel-verify`,
        issueKey,
        action: 'verify',
        actor: 'jira-issue-panel',
        verdict: result.verdict,
        score: result.score,
        timestamp: result.evaluatedAt,
      });

      return { issueKey, result };
    },
  );

  resolver.define(
    'syncVerificationToJira',
    async ({ context, payload }: { context: IssuePanelContext; payload?: SyncPayload }) => {
      const issueKey = issueKeyFrom(context);
      const latest = await loadLatest(issueKey);
      if (!latest) throw new Error('Run a guardrail check before syncing.');

      const syncResult = await syncVerification(
        {
          issueKey,
          postComment: payload?.postComment ?? true,
          addDriftLabel: payload?.addDriftLabel ?? true,
        },
        latest.result,
      );

      await appendAudit({
        id: `${Date.now()}-panel-sync`,
        issueKey,
        action: 'sync',
        actor: 'jira-issue-panel',
        verdict: latest.result.verdict,
        score: latest.result.score,
        timestamp: syncResult.syncedAt,
      });

      return syncResult;
    },
  );

  resolver.define(
    'getAdrGovernanceState',
    async ({ context }: { context: IssuePanelContext }) => {
      const pageId = context.extension?.content?.id;
      if (!pageId) throw new Error('SpecGuard byline requires a Confluence page context.');
      return loadAdrGovernance(pageId);
    },
  );

  return resolver;
}
