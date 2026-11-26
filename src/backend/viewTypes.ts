/**
 * View contracts shared by the UI Kit surfaces and the Forge resolver.
 * Type-only: importing this module from the frontend adds nothing to the bundle.
 */
import type {
  AlignmentVerdict,
  AuditLogEntry,
  SpecContextBundle,
  VerificationResult,
} from './types';

export type PanelStatus = 'unverified' | 'aligned' | 'drift';

/** `getIssueSpecState` — everything the issue panel paints on first render. */
export interface PanelIssueState {
  issueKey: string;
  state: PanelStatus;
  result: VerificationResult | null;
  history: AuditLogEntry[];
  bundle: SpecContextBundle | null;
  bundleHash: string | null;
  verifiedAt: string | null;
  agentSource: string | null;
  warnings: string[];
}

/** `runGuardrailCheck` — a context fetch (`mode: 'context'`) or a scored verification. */
export interface GuardrailCheckPayload {
  mode?: 'context' | 'verify';
  implementationSummary?: string;
  changedFiles?: string[];
  /** `cloudId` from `useProductContext()`; resolver contexts do not always carry one. */
  cloudId?: string;
}

export interface GuardrailCheckResponse {
  issueKey: string;
  bundleId: string;
  bundleHash: string;
  bundle: SpecContextBundle;
  result: VerificationResult | null;
  warnings: string[];
}

/**
 * Payload every UI Kit surface forwards: the `cloudId` it read from
 * `useProductContext()` (resolver contexts do not always carry one), plus the panel's
 * request for a live context fetch.
 */
export interface PanelContextPayload {
  cloudId?: string;
  refreshContext?: boolean;
}

/** `syncVerificationToJira` */
export interface SyncPayload {
  postComment?: boolean;
  addDriftLabel?: boolean;
  /** Forwarded for consistency; the sync write itself is cloud-ID agnostic. */
  cloudId?: string;
}

export type AdrAggregate = 'success' | 'warning' | 'danger' | 'default';

export interface AdrBylineIssue {
  key: string;
  score: number | null;
  verdict: AlignmentVerdict | null;
  evaluatedAt: string | null;
}

/** `getAdrGovernanceState` — the Confluence ADR byline chip and its expanded table. */
export interface AdrBylineState {
  pageId: string;
  pageTitle: string | null;
  governedCount: number;
  driftCount: number;
  issues: AdrBylineIssue[];
  aggregate: AdrAggregate;
  needsReReview: boolean;
  lastEvaluatedAt: string | null;
}

/** `reevaluateGovernedIssues` — byline state plus issues whose ADR rules changed. */
export interface AdrReevaluation extends AdrBylineState {
  changedIssues: string[];
}
