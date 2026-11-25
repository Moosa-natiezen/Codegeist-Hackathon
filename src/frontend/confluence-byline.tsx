/**
 * confluence:contentBylineItem — SpecGuard ADR byline.
 *
 * Collapsed: a status chip with the governed issue count and drift alert state.
 * Expanded: the governed issues with their latest alignment scores, plus a
 * re-evaluate action that flags ADR edits made after the last verification.
 *
 * The chip always renders once the product context resolves — including for an ADR
 * with zero governed issues and when the resolver fails (the failure becomes a
 * "status unavailable" chip with Retry). It renders nothing only when the surface
 * is not attached to a Confluence page at all.
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
import PanelBoundary from './PanelBoundary';
import { callResolver, errorMessage } from './resolverClient';
import { useSurfaceContext } from './surfaceContext';
import { absoluteUrl, governedChipLabel, shortVerdictLabel } from './viewModel';
import type { AdrBylineState, AdrReevaluation } from '../backend/viewTypes';

type LozengeAppearance = NonNullable<LozengeProps['appearance']>;

const AGGREGATE_APPEARANCE: Record<AdrBylineState['aggregate'], LozengeAppearance> = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  default: 'default',
};

const VERDICT_APPEARANCE = {
  ALIGNED: 'success',
  DRIFT_DETECTED: 'warning',
  BLOCKED_OR_VIOLATION: 'danger',
} as const satisfies Record<NonNullable<AdrBylineState['issues'][number]['verdict']>, LozengeAppearance>;

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
  const surface = useSurfaceContext();

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
      // The failure is logged for forge logs; the chip stays visible but neutral.
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

  // The byline is only meaningful on a Confluence page; anything else stays empty.
  if (surface.contextLoaded && !surface.pageId) {
    return <Inline space="space.050">{null}</Inline>;
  }

  if (!surface.ready || loading) {
    return (
      <Inline space="space.050" alignBlock="center">
        <Text size="small" weight="medium">
          SpecGuard
        </Text>
        <Spinner size="small" label="Loading SpecGuard ADR status" />
      </Inline>
    );
  }

  if (failed || !state) {
    return (
      <Inline space="space.050" alignBlock="center" shouldWrap>
        <Text size="small" weight="medium">
          SpecGuard
        </Text>
        <Lozenge appearance="default">status unavailable</Lozenge>
        <Button appearance="subtle" onClick={() => void load()}>
          Retry
        </Button>
      </Inline>
    );
  }

  return (
    <Stack space="space.075">
      <Inline space="space.050" alignBlock="center" shouldWrap>
        <Text size="small" weight="medium">
          SpecGuard
        </Text>
        <Lozenge appearance={AGGREGATE_APPEARANCE[state.aggregate]}>
          {governedChipLabel(state)}
        </Lozenge>
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
                        <Link href={absoluteUrl(surface.siteUrl, `/browse/${issue.key}`)} openNewTab>
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
                          {shortVerdictLabel(issue.verdict)}
                        </Lozenge>
                      ) : (
                        <Lozenge appearance="default">Unverified</Lozenge>
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

            <Inline space="space.100" alignBlock="center" shouldWrap>
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

ForgeReconciler.render(
  <PanelBoundary surface="ADR byline">
    <ConfluenceByline />
  </PanelBoundary>,
);

export default ConfluenceByline;
