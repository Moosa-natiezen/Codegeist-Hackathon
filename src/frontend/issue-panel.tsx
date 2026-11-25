/**
 * jira:issuePanel — "SpecGuard Status".
 *
 * Seven blocks, top to bottom (docs/DESIGN.md §3):
 *   1. Header + verdict banner (score, band, last verified, refresh)
 *   2. On-demand drift check form
 *   3. Acceptance criteria checklist
 *   4. Linked Confluence ADR guardrails
 *   5. Teamwork Graph dependency impact
 *   6. Agent audit log
 *   7. One-click sync to Jira
 *
 * Status is always word + colour (WCAG 1.4.1); every colour is an Atlassian token
 * resolved by UI Kit — there are no hard-coded values in this file.
 */
import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  DynamicTable,
  Heading,
  Inline,
  Link,
  List,
  ListItem,
  Lozenge,
  ProgressBar,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  TextArea,
  Textfield,
} from '@forge/react';
import type { LozengeProps } from '@forge/react';
import { callResolver, errorMessage } from './resolverClient';
import type {
  GuardrailCheckResponse,
  PanelIssueState,
  SyncPayload,
} from '../backend/viewTypes';
import type {
  AdrConformance,
  AdrEvaluation,
  AlignmentVerdict,
  CriterionEvaluation,
  CriterionStatus,
  DependencyEvaluation,
  SyncResult,
} from '../backend/types';

type LozengeAppearance = NonNullable<LozengeProps['appearance']>;

const VERDICT_STYLE: Record<AlignmentVerdict, { label: string; appearance: LozengeAppearance }> = {
  ALIGNED: { label: 'ALIGNED', appearance: 'success' },
  DRIFT_DETECTED: { label: 'DRIFT_DETECTED', appearance: 'warning' },
  BLOCKED_OR_VIOLATION: { label: 'BLOCKED_OR_VIOLATION', appearance: 'danger' },
};

const UNVERIFIED_STYLE = { label: 'UNVERIFIED', appearance: 'default' as LozengeAppearance };

const CRITERION_STYLE: Record<
  CriterionStatus,
  { label: string; appearance: LozengeAppearance }
> = {
  met: { label: 'PASS', appearance: 'success' },
  partially_met: { label: 'PARTIAL', appearance: 'warning' },
  not_met: { label: 'MISSING', appearance: 'danger' },
  not_verifiable: { label: 'NOT_VERIFIABLE', appearance: 'default' },
};

const ADR_STYLE: Record<AdrConformance, { label: string; appearance: LozengeAppearance }> = {
  respected: { label: 'COMPLIANT', appearance: 'success' },
  violated: { label: 'VIOLATION', appearance: 'danger' },
  not_applicable: { label: 'NOT_APPLICABLE', appearance: 'default' },
  not_verifiable: { label: 'NOT_VERIFIABLE', appearance: 'default' },
};

const AUDIT_ROWS = 5;

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

function verdictLabel(verdict: AlignmentVerdict): string {
  if (verdict === 'ALIGNED') return 'Aligned';
  if (verdict === 'DRIFT_DETECTED') return 'Drift Detected';
  return 'Blocked or in violation';
}

const IssuePanel = (): React.ReactElement => {
  const [panel, setPanel] = useState<PanelIssueState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [showCheck, setShowCheck] = useState<boolean>(false);
  const [summary, setSummary] = useState<string>('');
  const [files, setFiles] = useState<string>('');

  const [syncPreview, setSyncPreview] = useState<boolean>(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [showAllAudit, setShowAllAudit] = useState<boolean>(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setPanel(await callResolver<PanelIssueState>('getIssueSpecState'));
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runCheck = useCallback(
    async (mode: 'context' | 'verify'): Promise<void> => {
      setBusy(mode);
      setError(null);
      setSyncResult(null);
      try {
        await callResolver<GuardrailCheckResponse>('runGuardrailCheck', {
          mode,
          implementationSummary: mode === 'verify' ? summary : '',
          changedFiles:
            mode === 'verify'
              ? files
                  .split(',')
                  .map((file) => file.trim())
                  .filter((file) => file.length > 0)
              : [],
        });
        if (mode === 'verify') {
          setShowCheck(false);
          setSummary('');
          setFiles('');
        }
        await load();
      } catch (runError) {
        setError(errorMessage(runError));
      } finally {
        setBusy(null);
      }
    },
    [files, load, summary],
  );

  const applySync = useCallback(async (): Promise<void> => {
    setBusy('sync');
    setError(null);
    try {
      const payload: SyncPayload = { postComment: true, addDriftLabel: true };
      setSyncResult(await callResolver<SyncResult>('syncVerificationToJira', payload));
      setSyncPreview(false);
      await load();
    } catch (syncError) {
      setError(errorMessage(syncError));
    } finally {
      setBusy(null);
    }
  }, [load]);

  const result = panel?.result ?? null;
  const bundle = panel?.bundle ?? null;
  const history = panel?.history ?? [];

  const verdictStyle = result ? VERDICT_STYLE[result.verdict] : UNVERIFIED_STYLE;

  const criteria: CriterionEvaluation[] = result
    ? result.criteria
    : (bundle?.criteria ?? []).map((criterion) => ({
        id: criterion.id,
        text: criterion.text,
        status: 'not_verifiable' as CriterionStatus,
        evidence: 'Not evaluated yet — run a guardrail check.',
      }));

  const adrs: AdrEvaluation[] = result
    ? result.adrs
    : (bundle?.adrs ?? []).map((rule) => ({
        pageId: rule.pageId,
        pageTitle: rule.pageTitle,
        pageUrl: rule.pageUrl,
        kind: rule.kind,
        text: rule.text,
        status: 'not_verifiable' as AdrConformance,
        evidence: 'Not evaluated yet — run a guardrail check.',
      }));

  const dependencies: DependencyEvaluation[] = result
    ? result.dependencies
    : (bundle?.dependencies ?? []).map((dependency) => ({
        key: dependency.key,
        relationship: dependency.relationship,
        resolved: dependency.resolved,
        mentioned: false,
        message: dependency.resolved
          ? `${dependency.key} is already resolved.`
          : `${dependency.relationship}: ${dependency.summary}`,
      }));

  const metCount = criteria.filter((criterion) => criterion.status === 'met').length;
  const consideredCount = criteria.filter(
    (criterion) => criterion.status !== 'not_verifiable',
  ).length;
  const unresolvedCount = dependencies.filter((dependency) => !dependency.resolved).length;
  const auditRows = showAllAudit ? history : history.slice(0, AUDIT_ROWS);

  const metaLine = result
    ? `Verified ${relativeTime(panel?.verifiedAt ?? null)} · bundle ${panel?.bundleHash ?? 'n/a'} · by ${panel?.agentSource ?? 'unknown client'}`
    : 'No verification recorded for this issue yet.';

  return (
    <Box padding="space.200">
      <Stack space="space.200">
        {/* 1 — Header */}
        <Inline space="space.100" alignBlock="center" spread="space-between">
          <Heading size="small">SpecGuard Status</Heading>
          <Button appearance="subtle" onClick={() => void load()} isDisabled={loading}>
            Refresh
          </Button>
        </Inline>

        {loading ? (
          <Box padding="space.400">
            <Inline alignBlock="center" alignInline="center" grow="fill">
              <Spinner size="medium" label="Loading SpecGuard status" />
            </Inline>
          </Box>
        ) : error ? (
          <SectionMessage appearance="error" title="SpecGuard could not load this issue">
            <Stack space="space.100">
              <Text size="small">{error}</Text>
              <Inline>
                <Button appearance="primary" onClick={() => void load()}>
                  Retry
                </Button>
              </Inline>
            </Stack>
          </SectionMessage>
        ) : (
          <>
            {/* 1 — Verdict banner */}
            <Stack space="space.075">
              <Inline space="space.100" alignBlock="center">
                <Heading size="medium">{result ? `${result.score}%` : '—'}</Heading>
                <Lozenge appearance={verdictStyle.appearance} isBold>
                  {verdictStyle.label}
                </Lozenge>
              </Inline>
              <ProgressBar
                value={result ? Math.min(Math.max(result.score, 0), 100) / 100 : 0}
                appearance={result && result.verdict === 'ALIGNED' ? 'success' : 'default'}
                ariaLabel={`Spec alignment, ${result ? result.score : 0} percent`}
              />
              <Text size="small" color="color.text.subtlest">
                {metaLine}
              </Text>
              {result ? (
                <Text size="small" color="color.text.subtlest">
                  {`Weights: criteria ${result.weights.criteria}% · ADR ${result.weights.adrs}% · impact ${result.weights.impact}%`}
                </Text>
              ) : null}
            </Stack>

            {/* 2 — Drift check form */}
            <Stack space="space.100">
              {showCheck ? (
                <>
                  <TextArea
                    placeholder="Paste the PR summary, implementation plan, or commit notes…"
                    value={summary}
                    minimumRows={4}
                    onChange={(event) => setSummary(String(event.target.value ?? ''))}
                  />
                  <Textfield
                    placeholder="Changed files, comma separated (optional)"
                    value={files}
                    onChange={(event) => setFiles(String(event.target.value ?? ''))}
                  />
                  <Inline space="space.100">
                    <Button
                      appearance="primary"
                      isDisabled={busy !== null || summary.trim().length === 0}
                      onClick={() => void runCheck('verify')}
                    >
                      Run guardrail check
                    </Button>
                    <Button
                      appearance="subtle"
                      isDisabled={busy !== null}
                      onClick={() => setShowCheck(false)}
                    >
                      Cancel
                    </Button>
                  </Inline>
                </>
              ) : (
                <Inline space="space.100">
                  <Button
                    appearance="subtle"
                    isDisabled={busy !== null}
                    onClick={() => setShowCheck(true)}
                  >
                    Run a drift check…
                  </Button>
                  <Button
                    appearance="subtle"
                    isDisabled={busy !== null}
                    onClick={() => void runCheck('context')}
                  >
                    Get context
                  </Button>
                </Inline>
              )}
            </Stack>

            {/* 3 — Acceptance criteria */}
            <Stack space="space.075">
              <Heading size="xxsmall">Acceptance criteria</Heading>
              {criteria.length === 0 ? (
                <Text size="small" color="color.text.subtlest">
                  No acceptance criteria were found in the issue description or subtasks. Add a
                  checklist to the description, then press Get context.
                </Text>
              ) : (
                <List type="unordered">
                  {criteria.map((criterion) => {
                    const style = CRITERION_STYLE[criterion.status];
                    return (
                      <ListItem key={criterion.id}>
                        <Stack space="space.025">
                          <Inline space="space.075" alignBlock="center">
                            <Lozenge appearance={style.appearance}>{style.label}</Lozenge>
                            <Text size="small" weight="medium">
                              {criterion.id}
                            </Text>
                          </Inline>
                          <Text size="small">{criterion.text}</Text>
                          <Text size="small" color="color.text.subtlest">
                            {criterion.evidence}
                          </Text>
                        </Stack>
                      </ListItem>
                    );
                  })}
                </List>
              )}
              <Text size="small" color="color.text.subtlest">
                {`${metCount} of ${consideredCount} criteria met (50% of score)`}
              </Text>
            </Stack>

            {/* 4 — ADR guardrails */}
            <Stack space="space.075">
              <Heading size="xxsmall">Linked Confluence ADRs</Heading>
              {adrs.length === 0 ? (
                <Text size="small" color="color.text.subtlest">
                  No ADR guardrails were resolved for this issue. Link the governing Confluence
                  page to the issue, or mention the issue key on the ADR page.
                </Text>
              ) : (
                adrs.map((rule) => {
                  const style = ADR_STYLE[rule.status];
                  const pageHref =
                    rule.pageUrl ??
                    `/wiki/pages/viewpage.action?pageId=${encodeURIComponent(rule.pageId)}`;
                  return (
                    <Stack key={`${rule.pageId}-${rule.kind}-${rule.text}`} space="space.025">
                      <Inline space="space.075" alignBlock="center">
                        <Lozenge appearance={style.appearance}>{style.label}</Lozenge>
                        <Link href={pageHref} openNewTab>
                          {rule.pageTitle}
                        </Link>
                      </Inline>
                      <Text size="small">{`${rule.kind}: ${rule.text}`}</Text>
                      <Text size="small" color="color.text.subtlest">
                        {rule.evidence}
                      </Text>
                    </Stack>
                  );
                })
              )}
              <Text size="small" color="color.text.subtlest">
                35% of score
              </Text>
            </Stack>

            {/* 5 — Dependency impact */}
            <Stack space="space.075">
              <Heading size="xxsmall">Dependency impact</Heading>
              {bundle && bundle.graphSource !== 'teamwork-graph' ? (
                <SectionMessage appearance="warning" title="Dependency impact degraded">
                  <Text size="small">
                    Teamwork Graph did not return impact data, so dependencies were inferred from
                    Jira issue links. Coverage may be incomplete.
                  </Text>
                </SectionMessage>
              ) : null}
              {bundle && bundle.linkedPullRequests !== undefined ? (
                <Text size="small" color="color.text.subtlest">
                  {`Teamwork Graph: ${bundle.linkedPullRequests} linked pull request${bundle.linkedPullRequests === 1 ? '' : 's'}`}
                </Text>
              ) : null}
              {dependencies.length === 0 ? (
                <Text size="small" color="color.text.subtlest">
                  No upstream blockers or downstream dependents were found for this issue.
                </Text>
              ) : (
                dependencies.map((dependency) => (
                  <Stack key={`${dependency.key}-${dependency.relationship}`} space="space.025">
                    <Inline space="space.075" alignBlock="center">
                      <Lozenge appearance={dependency.resolved ? 'success' : 'warning'}>
                        {dependency.resolved ? 'RESOLVED' : 'OPEN'}
                      </Lozenge>
                      <Link href={`/browse/${dependency.key}`} openNewTab>
                        {dependency.key}
                      </Link>
                      <Text size="small" color="color.text.subtlest">
                        {dependency.relationship}
                      </Text>
                    </Inline>
                    <Text size="small">{dependency.message}</Text>
                  </Stack>
                ))
              )}
              <Text size="small" color="color.text.subtlest">
                {`${unresolvedCount} unresolved · 15% of score`}
              </Text>
            </Stack>

            {/* 6 — Agent audit log */}
            <Stack space="space.075">
              <Heading size="xxsmall">Agent audit log</Heading>
              {history.length === 0 ? (
                <Text size="small" color="color.text.subtlest">
                  No agent activity recorded for this issue yet.
                </Text>
              ) : (
                <>
                  <DynamicTable
                    head={{
                      cells: [
                        { key: 'time', content: 'Time', width: 25 },
                        { key: 'tool', content: 'Tool', width: 25 },
                        { key: 'verdict', content: 'Verdict', width: 50 },
                      ],
                    }}
                    rows={auditRows.map((entry) => ({
                      key: entry.id,
                      cells: [
                        {
                          key: 'time',
                          content: (
                            <Text size="small" color="color.text.subtlest">
                              {relativeTime(entry.timestamp)}
                            </Text>
                          ),
                        },
                        {
                          key: 'tool',
                          content: <Text size="small">{entry.action}</Text>,
                        },
                        {
                          key: 'verdict',
                          content: entry.verdict ? (
                            <Lozenge appearance={VERDICT_STYLE[entry.verdict].appearance}>
                              {VERDICT_STYLE[entry.verdict].label}
                            </Lozenge>
                          ) : (
                            <Text size="small" color="color.text.subtlest">
                              {entry.actor}
                            </Text>
                          ),
                        },
                      ],
                    }))}
                    isFixedSize={false}
                  />
                  {history.length > AUDIT_ROWS ? (
                    <Inline>
                      <Button
                        appearance="subtle"
                        onClick={() => setShowAllAudit((current) => !current)}
                      >
                        {showAllAudit
                          ? 'Show recent only'
                          : `View all (${history.length})`}
                      </Button>
                    </Inline>
                  ) : null}
                </>
              )}
            </Stack>

            {/* 7 — Sync controls */}
            {result ? (
              <Stack space="space.100">
                {!syncPreview && !syncResult ? (
                  <Inline>
                    <Button
                      appearance="primary"
                      isDisabled={busy !== null}
                      onClick={() => setSyncPreview(true)}
                    >
                      Sync verification to Jira
                    </Button>
                  </Inline>
                ) : null}

                {syncPreview ? (
                  <SectionMessage appearance="information" title="Sync preview">
                    <Stack space="space.100">
                      <Text size="small">
                        {`SpecGuard will write the following for ${result.issueKey}:`}
                      </Text>
                      <List type="unordered">
                        <ListItem>
                          {`Comment: SpecGuard verdict — ${result.score}% ${verdictLabel(result.verdict)}`}
                        </ListItem>
                        <ListItem>
                          {result.verdict === 'ALIGNED'
                            ? 'Remove the spec-drift label'
                            : 'Apply the spec-drift label'}
                        </ListItem>
                      </List>
                      <Inline space="space.100">
                        <Button
                          appearance="primary"
                          isDisabled={busy !== null}
                          onClick={() => void applySync()}
                        >
                          Apply
                        </Button>
                        <Button
                          appearance="subtle"
                          isDisabled={busy !== null}
                          onClick={() => setSyncPreview(false)}
                        >
                          Cancel
                        </Button>
                      </Inline>
                    </Stack>
                  </SectionMessage>
                ) : null}

                {syncResult ? (
                  <SectionMessage
                    appearance={syncResult.warnings.length > 0 ? 'warning' : 'success'}
                    title="Synced to Jira"
                  >
                    <Stack space="space.050">
                      <Text size="small">
                        {syncResult.commentPosted
                          ? `Audit comment posted (id ${syncResult.commentId ?? 'unknown'}).`
                          : 'No comment was posted.'}
                      </Text>
                      <Text size="small">
                        {syncResult.labelled
                          ? 'Drift label updated.'
                          : 'Drift label was not updated.'}
                      </Text>
                      {syncResult.warnings.map((warning) => (
                        <Text key={warning} size="small" color="color.text.subtlest">
                          {warning}
                        </Text>
                      ))}
                    </Stack>
                  </SectionMessage>
                ) : null}
              </Stack>
            ) : (
              <SectionMessage appearance="information" title="No verification yet">
                <Stack space="space.050">
                  <Text size="small">
                    Press Get context to load the acceptance criteria and ADRs, then run a drift
                    check with your implementation summary. Your coding agent can also call
                    specguard_verify_implementation through MCP.
                  </Text>
                  <Text size="small" color="color.text.subtlest">
                    Sync stays disabled until a verification exists.
                  </Text>
                </Stack>
              </SectionMessage>
            )}
          </>
        )}
      </Stack>
    </Box>
  );
};

ForgeReconciler.render(<IssuePanel />);

export default IssuePanel;
