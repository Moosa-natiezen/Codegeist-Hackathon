/**
 * confluence:contentBylineItem — SpecGuard ADR byline.
 *
 * Collapsed: a status chip with the governed issue count and drift alert state.
 * Expanded: the governed issues with their latest alignment scores, plus a
 * re-evaluate action that flags ADR edits made after the last verification.
 *
 * Errors hide the chip (docs/DESIGN.md §4): a broken byline is worse than none.
 */
import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  DynamicTable,
  Heading,
  Inline,
  Link,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Text,
} from '@forge/react';
import type { LozengeProps } from '@forge/react';
import { callResolver, errorMessage } from './resolverClient';
import type { AdrBylineState, AdrReevaluation } from '../backend/viewTypes';

type LozengeAppearance = NonNullable<LozengeProps['appearance']>;

const AGGREGATE_APPEARANCE: Record<AdrBylineState['aggregate'], LozengeAppearance> = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  default: 'default',
};

const VERDICT_TEXT = {
  ALIGNED: 'ALIGNED',
  DRIFT_DETECTED: 'DRIFT_DETECTED',
  BLOCKED_OR_VIOLATION: 'BLOCKED_OR_VIOLATION',
} as const;

const VERDICT_APPEARANCE: Record<keyof typeof VERDICT_TEXT, LozengeAppearance> = {
  ALIGNED: 'success',
  DRIFT_DETECTED: 'warning',
  BLOCKED_OR_VIOLATION: 'danger',
};

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const elapsed = Date.now() - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return 'unknown time';
  if (elapsed < 0) return 'just now';

  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const ConfluenceByline = (): React.ReactElement => {
  const [state, setState] = useState<AdrBylineState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [failed, setFailed] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [reevaluation, setReevaluation] = useState<AdrReevaluation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setState(await callResolver<AdrBylineState>('getAdrGovernanceState'));
      setFailed(false);
    } catch {
      // A broken byline is never rendered; the failure is logged for forge logs.
      console.error('SpecGuard byline could not load ADR governance state.');
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reevaluate = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await callResolver<AdrReevaluation>('reevaluateGovernedIssues');
      setReevaluation(next);
      setState(next);
    } catch (reevaluateError) {
      setError(errorMessage(reevaluateError));
    } finally {
      setBusy(false);
    }
  }, []);

  if (failed) return <Inline space="space.050">{null}</Inline>;

  if (loading || !state) {
    return (
      <Inline space="space.050" alignBlock="center">
        <Text size="small" weight="medium">
          SpecGuard
        </Text>
        <Spinner size="small" label="Loading SpecGuard ADR status" />
      </Inline>
    );
  }

  const governedLabel =
    state.governedCount === 0
      ? 'not linked'
      : `${state.governedCount} issue${state.governedCount === 1 ? '' : 's'} governed · ${state.driftCount} drift`;

  return (
    <Stack space="space.075">
      <Inline space="space.050" alignBlock="center">
        <Text size="small" weight="medium">
          SpecGuard
        </Text>
        <Text size="small" color="color.text.subtlest">
          ·
        </Text>
        <Lozenge appearance={AGGREGATE_APPEARANCE[state.aggregate]}>{governedLabel}</Lozenge>
        <Button appearance="subtle" onClick={() => setExpanded((current) => !current)}>
          {expanded ? 'Hide' : 'Details'}
        </Button>
      </Inline>

      {expanded ? (
        <Box padding="space.100">
          <Stack space="space.100">
            <Heading size="xxsmall">Governed issues</Heading>

            {state.issues.length === 0 ? (
              <Text size="small" color="color.text.subtlest">
                No Jira issue is governed by this ADR yet. Link the page to an issue, or mention
                the issue key on this page, then verify from that issue.
              </Text>
            ) : (
              <DynamicTable
                head={{
                  cells: [
                    { key: 'issue', content: 'Issue', width: 35 },
                    { key: 'score', content: 'Score', width: 25 },
                    { key: 'verdict', content: 'Verdict', width: 40 },
                  ],
                }}
                rows={state.issues.map((issue) => ({
                  key: issue.key,
                  cells: [
                    {
                      key: 'issue',
                      content: (
                        <Link href={`/browse/${issue.key}`} openNewTab>
                          {issue.key}
                        </Link>
                      ),
                    },
                    {
                      key: 'score',
                      content: (
                        <Text size="small">
                          {issue.score === null ? '—' : `${issue.score}%`}
                        </Text>
                      ),
                    },
                    {
                      key: 'verdict',
                      content: issue.verdict ? (
                        <Lozenge appearance={VERDICT_APPEARANCE[issue.verdict]}>
                          {VERDICT_TEXT[issue.verdict]}
                        </Lozenge>
                      ) : (
                        <Lozenge appearance="default">UNVERIFIED</Lozenge>
                      ),
                    },
                  ],
                }))}
                isFixedSize={false}
              />
            )}

            {state.governedCount > state.issues.length ? (
              <Text size="small" color="color.text.subtlest">
                {`Showing the ${state.issues.length} most recent of ${state.governedCount} governed issues.`}
              </Text>
            ) : null}

            {state.needsReReview ? (
              <SectionMessage appearance="warning" title="ADR changed since last verification">
                <Text size="small">
                  This page was edited after the governed issues were verified. Re-run
                  verification from the agent to refresh their scores.
                </Text>
              </SectionMessage>
            ) : null}

            {reevaluation && reevaluation.changedIssues.length > 0 ? (
              <SectionMessage appearance="information" title="Re-evaluation complete">
                <Text size="small">
                  {`Changed ADR rules affect ${reevaluation.changedIssues.join(', ')}. Scores are unchanged until each issue is verified again.`}
                </Text>
              </SectionMessage>
            ) : null}

            {reevaluation && reevaluation.changedIssues.length === 0 ? (
              <SectionMessage appearance="success" title="Re-evaluation complete">
                <Text size="small">
                  The ADR rules match the ones used by every governed verification.
                </Text>
              </SectionMessage>
            ) : null}

            {error ? (
              <SectionMessage appearance="error" title="Re-evaluation failed">
                <Text size="small">{error}</Text>
              </SectionMessage>
            ) : null}

            <Inline space="space.100" alignBlock="center">
              <Button
                appearance="subtle"
                isDisabled={busy}
                onClick={() => void reevaluate()}
              >
                Re-evaluate governed issues
              </Button>
              <Text size="small" color="color.text.subtlest">
                {`Last evaluated ${relativeTime(state.lastEvaluatedAt)}`}
              </Text>
            </Inline>
          </Stack>
        </Box>
      ) : null}
    </Stack>
  );
};

ForgeReconciler.render(<ConfluenceByline />);

export default ConfluenceByline;
