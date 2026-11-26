/**
 * Shared domain types for SpecGuard MCP.
 * Mirrors the contracts in docs/TECH_STACK.md §5.
 */

export type AlignmentVerdict = 'ALIGNED' | 'DRIFT_DETECTED' | 'BLOCKED_OR_VIOLATION';

export type CriterionStatus = 'met' | 'partially_met' | 'not_met' | 'not_verifiable';

export type AdrConformance = 'respected' | 'violated' | 'not_applicable' | 'not_verifiable';

export type RuleKind = 'Decision' | 'Must' | 'Must Not' | 'Constraints' | 'Guardrails';

export type FindingSeverity = 'info' | 'warning' | 'blocker';

export interface AcceptanceCriterion {
  /** Stable identifier, e.g. `AC-1`. */
  id: string;
  text: string;
  /** Where the criterion came from — issue description or a subtask. */
  source: 'description' | 'subtask';
  subtaskKey?: string;
  /** Checkbox state as authored in Jira, when present. */
  checkedInJira?: boolean;
}

export interface ConfluenceAdrRule {
  pageId: string;
  pageTitle: string;
  pageUrl?: string;
  kind: RuleKind;
  text: string;
}

export interface GraphDependency {
  key: string;
  relationship: string;
  summary: string;
  status?: string;
  /** True when the dependency is closed/resolved and cannot block delivery. */
  resolved: boolean;
}

export interface JiraIssueSummary {
  key: string;
  summary: string;
  descriptionText: string;
  status: string;
  issueType: string;
  parentKey?: string;
  parentSummary?: string;
  webLinks: string[];
}

export type CloudIdSource = 'context' | 'cache' | 'missing';

/** Structured, secret-free note describing how the Teamwork Graph call went. */
export interface GraphDiagnostics {
  /** Whether the graph query was actually sent. */
  attempted: boolean;
  /** Where the cloud ID came from, so a degraded panel can say why. */
  cloudIdSource: CloudIdSource;
  /** Work-item ARI used for the query, when one could be built. */
  ari?: string;
  /** Reason the graph call was skipped or degraded. */
  reason?: string;
}

export interface SpecContextBundle {
  issueKey: string;
  issue: JiraIssueSummary;
  criteria: AcceptanceCriterion[];
  adrs: ConfluenceAdrRule[];
  dependencies: GraphDependency[];
  warnings: string[];
  fetchedAt: string;
  /** Whether Teamwork Graph traversal succeeded, or degraded to Jira links only. */
  graphSource: 'teamwork-graph' | 'jira-links' | 'unavailable';
  /** Linked pull requests reported by the Teamwork Graph, when it responded. */
  linkedPullRequests?: number;
  /** How cloud ID / graph resolution went, surfaced in the Dependency Impact block. */
  graphDiagnostics?: GraphDiagnostics;
  /** Confluence page IDs the issue links to (ADR pages attempted, readable or not). */
  resolvedPageIds?: string[];
}

export interface VerificationRequest {
  issueKey: string;
  implementationSummary: string;
  changedFiles?: string[];
  agentSource?: string;
}

export interface CriterionEvaluation {
  id: string;
  text: string;
  status: CriterionStatus;
  evidence: string;
}

export interface AdrEvaluation {
  pageId: string;
  pageTitle: string;
  pageUrl?: string;
  kind: RuleKind;
  text: string;
  status: AdrConformance;
  evidence: string;
}

export interface DriftFinding {
  source: string;
  severity: FindingSeverity;
  message: string;
}

export interface DependencyEvaluation {
  key: string;
  relationship: string;
  resolved: boolean;
  mentioned: boolean;
  message: string;
}

export interface VerificationResult {
  issueKey: string;
  score: number;
  verdict: AlignmentVerdict;
  criteria: CriterionEvaluation[];
  adrs: AdrEvaluation[];
  dependencies: DependencyEvaluation[];
  findings: DriftFinding[];
  suggestions: string[];
  weights: { criteria: number; adrs: number; impact: number };
  agentSource?: string;
  evaluatedAt: string;
}

export interface AuditLogEntry {
  id: string;
  issueKey: string;
  action: 'get_context' | 'verify' | 'sync';
  actor: string;
  verdict?: AlignmentVerdict;
  score?: number;
  detail?: string;
  timestamp: string;
}

export interface SyncRequest {
  issueKey: string;
  postComment: boolean;
  addDriftLabel: boolean;
}

export interface SyncResult {
  issueKey: string;
  commentId?: string;
  labelled: boolean;
  commentPosted: boolean;
  warnings: string[];
  syncedAt: string;
}

/** Tool input/output envelopes shared by rovo actions and the MCP server. */
export interface ToolSuccess<T> {
  ok: true;
  data: T;
}

export interface ToolFailure {
  ok: false;
  errorCode: string;
  message: string;
}

export type ToolResult<T> = ToolSuccess<T> | ToolFailure;
