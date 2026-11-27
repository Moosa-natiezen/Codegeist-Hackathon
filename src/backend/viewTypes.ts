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
  /** Confluence page IDs linked on the issue, so the panel knows what it may hydrate. */
  resolvedPageIds: string[];
}

/**
 * `ingestClientAdrPage` — a Confluence page body the panel read through the browser
 * bridge (`requestConfluence`), used when the backend's own read is refused (401/403).
 */
export interface ClientAdrPagePayload {
  pageId: string;
  title?: string;
  url?: string;
  /** Storage-format HTML (`body.storage.value`) exactly as Confluence returned it. */
  storageHtml: string;
  /** Resolver context carries the issue key; the panel also forwards it explicitly. */
  issueKey?: string;
  cloudId?: string;
}

/**
 * `cacheClientAdrPage` — what a page body read in the browser added to the KVS cache.
 * The Confluence byline uses this when the page has no governed Jira issue yet, so its
 * rules are cached without refreshing a panel state that does not exist.
 */
export interface ClientAdrCacheResult {
  pageId: string;
  pageTitle: string;
  ruleCount: number;
  /** Issues the rules were cached for (linked keys plus keys named in the rule text). */
  issueKeys: string[];
  cachedAt: string | null;
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
