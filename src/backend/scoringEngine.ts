/**
 * Deterministic Spec Alignment & Drift Scoring Engine.
 *
 * Weights (docs/PRD.md §5.2, docs/TECH_STACK.md §5):
 *   50% acceptance-criteria coverage
 *   35% Confluence ADR guardrail compliance
 *   15% dependency / scope safety
 *
 * The engine never samples a model: identical inputs always produce the same score.
 * Components without evidence are excluded and the remaining weights renormalized,
 * so missing data lowers confidence instead of silently producing drift.
 */
import { tokenize } from './extract';
import type {
  AcceptanceCriterion,
  AdrEvaluation,
  AdrConformance,
  AlignmentVerdict,
  ConfluenceAdrRule,
  CriterionEvaluation,
  CriterionStatus,
  DependencyEvaluation,
  DriftFinding,
  SpecContextBundle,
  VerificationRequest,
  VerificationResult,
} from './types';

export const WEIGHTS = { criteria: 50, adrs: 35, impact: 15 } as const;

export const ALIGNED_THRESHOLD = 85;
export const DRIFT_THRESHOLD = 50;

/** Error code returned when an issue has nothing to score against. */
export const NO_SPECS_ERROR_CODE = 'NO_SPECS_TO_VERIFY';

export const NO_SPECS_MESSAGE =
  'No acceptance criteria or linked Confluence ADRs found. Add a checklist to the issue description or link an ADR page, then press Get context.';

/**
 * Whether a bundle has anything worth scoring. An issue with no criteria and no
 * ADR rules would otherwise score a misleading `0% BLOCKED_OR_VIOLATION` merely
 * because the spec was never authored.
 */
export function hasScorableSpec(bundle: Pick<SpecContextBundle, 'criteria' | 'adrs'>): boolean {
  return bundle.criteria.length > 0 || bundle.adrs.length > 0;
}

/** Raised when scoring is attempted for an issue with no criteria and no ADRs. */
export class EmptySpecError extends Error {
  readonly errorCode = NO_SPECS_ERROR_CODE;

  constructor() {
    super(NO_SPECS_MESSAGE);
    this.name = 'EmptySpecError';
  }
}

const MET_RATIO = 0.6;
const PARTIAL_RATIO = 0.3;
const ADR_MATCH_RATIO = 0.5;
const DEP_MATCH_RATIO = 0.4;

const AVOIDANCE_TOKENS = new Set([
  'no',
  'not',
  'never',
  'avoid',
  'avoids',
  'avoided',
  'without',
  'instead',
  'removed',
  'remove',
  'deprecated',
]);

function overlapRatio(needle: string, haystackTokens: Set<string>): number {
  const tokens = tokenize(needle);
  if (tokens.length === 0) return 0;
  const matched = tokens.filter((token) => haystackTokens.has(token)).length;
  return matched / tokens.length;
}

function submissionTokens(request: VerificationRequest): Set<string> {
  const corpus = [request.implementationSummary, ...(request.changedFiles ?? [])].join(' ');
  return new Set(tokenize(corpus));
}

function evaluateCriterion(
  criterion: AcceptanceCriterion,
  tokens: Set<string>,
): CriterionEvaluation {
  if (criterion.checkedInJira) {
    return {
      id: criterion.id,
      text: criterion.text,
      status: 'met',
      evidence: 'Acceptance criterion is already ticked in Jira.',
    };
  }

  const ratio = overlapRatio(criterion.text, tokens);
  let status: CriterionStatus;
  if (ratio >= MET_RATIO) status = 'met';
  else if (ratio >= PARTIAL_RATIO) status = 'partially_met';
  else if (ratio > 0) status = 'partially_met';
  else status = tokenize(criterion.text).length === 0 ? 'not_verifiable' : 'not_met';

  return {
    id: criterion.id,
    text: criterion.text,
    status,
    evidence: `Token overlap with submitted implementation: ${(ratio * 100).toFixed(0)}%.`,
  };
}

function evaluateAdrRule(rule: ConfluenceAdrRule, tokens: Set<string>): AdrEvaluation {
  const ratio = overlapRatio(rule.text, tokens);
  const hasAvoidance = tokenize(rule.text).length
    ? [...tokens].some((token) => AVOIDANCE_TOKENS.has(token))
    : false;

  let status: AdrConformance;
  if (ratio >= ADR_MATCH_RATIO) {
    if (rule.kind === 'Must Not') {
      status = hasAvoidance ? 'respected' : 'violated';
    } else if (rule.kind === 'Must') {
      status = 'respected';
    } else {
      status = hasAvoidance ? 'violated' : 'respected';
    }
  } else if (ratio > 0) {
    status = 'not_verifiable';
  } else {
    status = 'not_verifiable';
  }

  return {
    pageId: rule.pageId,
    pageTitle: rule.pageTitle,
    pageUrl: rule.pageUrl,
    kind: rule.kind,
    text: rule.text,
    status,
    evidence: `Rule overlap with submitted implementation: ${(ratio * 100).toFixed(0)}%.`,
  };
}

function evaluateDependency(
  dependency: SpecContextBundle['dependencies'][number],
  request: VerificationRequest,
  tokens: Set<string>,
): DependencyEvaluation {
  const corpus = `${request.implementationSummary} ${(request.changedFiles ?? []).join(' ')}`.toLowerCase();
  const mentioned =
    corpus.includes(dependency.key.toLowerCase()) ||
    overlapRatio(dependency.summary, tokens) >= DEP_MATCH_RATIO;

  const message = dependency.resolved
    ? `${dependency.key} is already resolved.`
    : mentioned
      ? `Unresolved ${dependency.relationship} dependency ${dependency.key} is acknowledged in the implementation, but must be closed before merge.`
      : `Unresolved ${dependency.relationship} dependency ${dependency.key} is not addressed by the implementation.`;

  return {
    key: dependency.key,
    relationship: dependency.relationship,
    resolved: dependency.resolved,
    mentioned,
    message,
  };
}

function verdictFor(score: number): AlignmentVerdict {
  if (score >= ALIGNED_THRESHOLD) return 'ALIGNED';
  if (score >= DRIFT_THRESHOLD) return 'DRIFT_DETECTED';
  return 'BLOCKED_OR_VIOLATION';
}

/**
 * Scores a proposed implementation against a persisted SpecContextBundle.
 */
export function scoreImplementation(
  bundle: SpecContextBundle,
  request: VerificationRequest,
): VerificationResult {
  const tokens = submissionTokens(request);
  const findings: DriftFinding[] = [];
  const suggestions: string[] = [];

  const criteria = bundle.criteria.map((criterion) => evaluateCriterion(criterion, tokens));
  const adrs = bundle.adrs.map((rule) => evaluateAdrRule(rule, tokens));
  const dependencies = bundle.dependencies.map((dependency) =>
    evaluateDependency(dependency, request, tokens),
  );

  // --- Acceptance criteria (weight 50) ---
  const consideredCriteria = criteria.filter((entry) => entry.status !== 'not_verifiable');
  const criteriaScore =
    consideredCriteria.length === 0
      ? null
      : consideredCriteria.reduce((sum, entry) => {
          if (entry.status === 'met') return sum + 1;
          if (entry.status === 'partially_met') return sum + 0.5;
          return sum;
        }, 0) / consideredCriteria.length;

  // --- ADR guardrails (weight 35) ---
  const consideredAdrs = adrs.filter((entry) => entry.status !== 'not_verifiable');
  const adrScore =
    consideredAdrs.length === 0
      ? null
      : consideredAdrs.filter((entry) => entry.status === 'respected').length /
        consideredAdrs.length;

  // --- Dependency / scope safety (weight 15) ---
  const impactScore =
    dependencies.length === 0
      ? null
      : dependencies.filter((entry) => entry.resolved || entry.mentioned).length /
        dependencies.length;

  const components: Array<{ weight: number; ratio: number }> = [];
  if (criteriaScore !== null) components.push({ weight: WEIGHTS.criteria, ratio: criteriaScore });
  if (adrScore !== null) components.push({ weight: WEIGHTS.adrs, ratio: adrScore });
  if (impactScore !== null) components.push({ weight: WEIGHTS.impact, ratio: impactScore });

  const totalWeight = components.reduce((sum, entry) => sum + entry.weight, 0);
  const weighted = components.reduce((sum, entry) => sum + entry.weight * entry.ratio, 0);
  const score = totalWeight === 0 ? 0 : Math.round((weighted / totalWeight) * 100);

  // --- Findings & remediation ---
  for (const entry of criteria) {
    if (entry.status === 'not_met') {
      findings.push({
        source: entry.id,
        severity: 'warning',
        message: `Acceptance criterion "${entry.text}" has no corresponding change in the submitted implementation.`,
      });
      suggestions.push(`Implement or explicitly document ${entry.id}: "${entry.text}".`);
    } else if (entry.status === 'partially_met') {
      findings.push({
        source: entry.id,
        severity: 'info',
        message: `Acceptance criterion "${entry.text}" is only partially evidenced.`,
      });
      suggestions.push(`Add a test or explicit note proving ${entry.id} is satisfied.`);
    } else if (entry.status === 'not_verifiable') {
      findings.push({
        source: entry.id,
        severity: 'info',
        message: `Acceptance criterion "${entry.text}" could not be evaluated from the supplied summary.`,
      });
    }
  }

  for (const entry of adrs) {
    if (entry.status === 'violated') {
      findings.push({
        source: `${entry.pageTitle} (${entry.kind})`,
        severity: 'blocker',
        message: `ADR guardrail violated: "${entry.text}".`,
      });
      suggestions.push(
        `Revise the implementation to comply with ${entry.pageTitle}: "${entry.text}".`,
      );
    }
  }

  for (const entry of dependencies) {
    if (!entry.resolved && !entry.mentioned) {
      findings.push({
        source: entry.key,
        severity: 'blocker',
        message: entry.message,
      });
      suggestions.push(`Resolve or document dependency ${entry.key} before merging.`);
    } else if (!entry.resolved) {
      findings.push({ source: entry.key, severity: 'warning', message: entry.message });
    }
  }

  const hasBlocker = findings.some((finding) => finding.severity === 'blocker');
  const computedVerdict = verdictFor(score);
  const verdict: AlignmentVerdict =
    computedVerdict === 'ALIGNED' && hasBlocker ? 'DRIFT_DETECTED' : computedVerdict;

  if (components.length === 0) {
    findings.push({
      source: 'bundle',
      severity: 'blocker',
      message: 'No evidence was available to score this implementation.',
    });
  }

  return {
    issueKey: bundle.issueKey,
    score,
    verdict,
    criteria,
    adrs,
    dependencies,
    findings,
    suggestions: [...new Set(suggestions)],
    weights: { ...WEIGHTS },
    agentSource: request.agentSource,
    evaluatedAt: new Date().toISOString(),
  };
}
