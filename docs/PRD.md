# SpecGuard MCP — Product Requirements Document

| Field | Value |
|---|---|
| Product | **SpecGuard MCP** |
| Repository | `Moosa-natiezen/Codegeist-Hackathon` |
| Status | **Architecture locked** — implementation pending |
| Event | Atlassian Codegeist 2026 |
| Platform | Atlassian Forge (serverless), site `https://one-atlas-deuz.atlassian.net` |
| Document version | 1.0 |
| Last updated | 2026-11-25 |

---

## 1. Problem

AI coding agents (Freebuff, Cursor, Claude Code, and similar) are now the fastest path from a Jira ticket to merged code — and the fastest path to silent architectural drift. Three failure modes recur on every team using them:

1. **Context starvation.** The agent starts coding with only the ticket title and whatever files it happens to open. The real acceptance criteria live in Jira subtasks, the architectural constraints live in Confluence ADRs, and the blast radius lives in the Teamwork Graph (what else depends on this service). None of that reaches the agent's context window, so it invents requirements.
2. **No spec-to-code verification.** After the agent writes code, nothing checks the implementation back against the acceptance criteria and the governing ADRs. Divergence is discovered in review, or in production.
3. **Manual status labor.** Engineers hand-copy "moved to In Review", "criteria 3 of 5 met", "drift found in the event schema" between the agent session and Jira/Confluence. It is slow, lossy, and the first thing dropped under deadline pressure.

The result is that AI-accelerated teams ship *more* code against *less* documented intent, and the distance between what the spec says and what the system does grows invisibly.

**SpecGuard MCP** closes that loop inside Atlassian: it feeds governed context **to** the agent before it codes, scores the agent's output **against** that context after it codes, and writes the verdict **back** into Jira and Confluence automatically.

---

## 2. Product overview

SpecGuard MCP is an Atlassian Forge app that bridges AI coding agents with three sources of truth in the Atlassian platform:

- **Jira** — acceptance criteria on the issue and its subtasks.
- **Confluence** — Architecture Decision Records (ADRs) and the constraints they impose.
- **Teamwork Graph** — cross-product dependency and ownership context for the work item.

It exposes that material through an MCP server (`rovo:mcp`) and a shipped agent skill (`SKILL.md`), so any MCP-capable coding agent can pull a **Pre-Flight Context Bundle** before writing code, then submit its implementation for a **Spec Alignment Score** and one-click **state sync**.

### 2.1 Value proposition

> The agent gets the spec before it codes, the reviewer gets a drift verdict before merge, and Jira/Confluence stay true without anyone copying text by hand.

### 2.2 Positioning against the platform

SpecGuard does not replace Jira, Confluence, Rovo, or the coding agent. It is the **contract layer** between them: deterministic, auditable, and entirely inside the customer's Atlassian tenancy.

---

## 3. Target tracks

### 3.1 Main category — *Apps for Software Teams*

SpecGuard targets software delivery teams directly: it operates on the Jira issues and Confluence ADRs that engineering organizations already use, inside the tools they already have open, and it produces artifacts (alignment scores, audit logs, drift status) that a software team's review process can act on.

### 3.2 Stackable bonus tracks

| Bonus track | How SpecGuard satisfies it |
|---|---|
| **Best Rovo Agent** | Ships a `rovo:agent` module ("SpecGuard") plus `rovo:action` handlers, so users can ask Rovo in natural language: *"Is PAY-412 still aligned with ADR-014?"* and receive a structured, cited verdict card — not free text. |
| **Best App with Atlassian MCP** | The app **is** an MCP server (`rovo:mcp`) with three governed tools (`specguard_get_context`, `specguard_verify_implementation`, `specguard_sync_status`) plus a public `SKILL.md`, usable from Freebuff, Cursor, Claude Code, or any MCP client. |
| **Best Teamwork Graph Integration** | Every context bundle and verification includes Teamwork Graph traversal (`read:graph:jira`): dependent issues, owning teams, and downstream services affected by the change, surfaced as a Dependency Impact section. |
| **Best Marketplace Published App** | Built to marketplace standards from day one: Forge-hosted (Runs on Atlassian eligible), no external database or third-party data egress, least-privilege scopes, light/dark UI Kit parity, documented install/permission rationale, and a listing-ready README. |

---

## 4. Target users

| Persona | Need | What SpecGuard gives them |
|---|---|---|
| **AI-assisted engineer** | Stop guessing what "done" means; stop re-pasting ADRs into the prompt | One `specguard_get_context` call returns criteria, ADRs, and dependency impact |
| **Tech lead / reviewer** | Objective signal that AI-written code matches the agreed design | Spec Alignment Score (0–100%) and a per-criterion pass/fail checklist in the issue panel |
| **Architect** | Know when an ADR is being violated, and by which issue | ADR byline on the Confluence page showing governed issue count and drift status |
| **Engineering manager** | Traceability for audits | Agent Audit Log: who called which tool, when, with what verdict |

---

## 5. Core features

### 5.1 Pre-Flight Context Bundle (`rovo:mcp` + `SKILL.md`)

**What:** A single MCP tool call, `specguard_get_context`, returns a normalized, token-efficient bundle for a Jira issue key:

- Acceptance criteria, parsed from the description and subtasks (checkbox-aware).
- Governing ADRs from Confluence, resolved by linked pages and label/space conventions.
- Teamwork Graph dependency impact (dependents, owning team, downstream services).
- A stable `bundleId` + content hash so the later verification can cite exactly what context was used.

**Why:** Turns "the agent guessed" into "the agent was told."

**Flow:**
1. Agent (or developer) calls `specguard_get_context({ issueKey })`.
2. App fetches Jira issue + subtasks, Confluence ADRs, and Teamwork Graph neighbors in parallel.
3. App persists the bundle snapshot in Forge KVS under `bundle:<issueKey>:<bundleId>`.
4. Response includes an `instructions` block summarizing the guardrails in imperative form.

**Acceptance criteria:**
- Returns a bundle in < 5 s typical for an issue with ≤ 10 criteria and ≤ 5 ADRs.
- Works with **zero** ADRs linked (returns `adrs: []` plus a warning, never an error).
- Never returns data the calling user cannot already read (permission-scoped via `asUser()`).
- The content hash is stable across identical inputs.

### 5.2 Architectural Guardrail & Drift Verification (`0–100%` Spec Alignment Score)

**What:** `specguard_verify_implementation({ issueKey, bundleId, summary })` compares a submitted implementation description (diff summary, changed files, notes) against the stored bundle and produces:

- **Spec Alignment Score**, 0–100%, a weighted aggregate of:
  - Acceptance criteria coverage (weight 50%) — each criterion judged `met` / `partially_met` / `not_met` / `not_verifiable`.
  - ADR guardrail conformance (weight 35%) — each ADR constraint judged `respected` / `violated` / `not_applicable`.
  - Teamwork Graph impact disclosure (weight 15%) — whether affected dependents are acknowledged in the implementation notes.
- **Drift findings** — human-readable statements naming the specific criterion or ADR constraint that is unaddressed, with severity `info` / `warning` / `blocker`.
- **Verdict band** — `Aligned` (≥ 85), `Drift Detected` (< 85 with ≥ 1 finding), `Unverified` (no bundle or insufficient evidence).

**Why:** Gives reviewers a defensible, explainable number instead of an opinion, and gives the agent actionable feedback it can fix in-session.

**Acceptance criteria:**
- Deterministic scoring: same bundle + same submission ⇒ same score (no random sampling, no temperature-dependent output in the scoring path).
- Every score is accompanied by the findings that produced it; a bare number is never returned.
- Missing evidence degrades to `not_verifiable` and is excluded from the denominator rather than scored as failure.
- Score and findings are persisted with the bundle hash they were computed against.

### 5.3 One-Click Jira / Confluence State Sync

**What:** `specguard_sync_status({ issueKey, bundleId })` and a UI button apply the verification outcome to Atlassian state:

- Adds/updates a Jira comment with the score, verdict, and findings table.
- Ticks the matching acceptance-criteria checkboxes in the issue description (only the ones judged `met`).
- Transitions the issue (configurable mapping, default: `Aligned` → *In Review*; drift → stays in current status, label `spec-drift` added).
- Appends a guardrail note to the linked Confluence ADR page ("Governed by SpecGuard — last verdict …"), creating an app-owned section rather than editing author prose.

**Why:** Removes the copy-paste step that everyone skips.

**Acceptance criteria:**
- Every sync is previewed before it is applied (diff-style summary in the issue panel).
- All writes go through `asUser()` so the audit trail names the human who clicked.
- Idempotent: re-syncing the same bundle does not duplicate comments or labels.
- Failures are reported per-target (Jira vs Confluence) and never partially silent.

### 5.4 Native Jira Issue Panel & Confluence ADR Byline UI

**What:** The product is usable without leaving Atlassian:

- **`jira:issuePanel` — "SpecGuard Status"**: Alignment Score badge, criteria checklist, ADR guardrails list, Teamwork Graph dependency impact, Agent Audit Log, and the sync action.
- **`confluence:contentBylineItem`**: compact byline chip showing governed Jira issue count and aggregate drift status for the ADR page.
- **Rovo chat cards**: structured audit cards returned by the `rovo:agent`, mirroring the panel's verdict/score/findings sections.

Detail lives in [`DESIGN.md`](./DESIGN.md).

**Acceptance criteria:**
- Panel renders a useful state with no bundle yet (`Unverified` + "Get context" guidance) instead of an empty shell.
- All views honour Atlassian light and dark tokens with no hard-coded colors.
- Every number shown in the UI is traceable to a stored verification record.

---

## 6. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | `specguard_get_context` returns a bundle for a valid issue key visible to the caller | Must |
| FR-2 | Bundle includes criteria, ADRs, and Teamwork Graph impact | Must |
| FR-3 | `specguard_verify_implementation` returns a 0–100 score plus findings and verdict | Must |
| FR-4 | `specguard_sync_status` writes Jira comment + criteria ticks + status per preview | Must |
| FR-5 | Confluence ADR byline shows governed issue count and drift status | Must |
| FR-6 | `rovo:agent` answers alignment questions with structured audit cards | Must |
| FR-7 | Agent Audit Log records every MCP call with user, bundle, verdict, timestamp | Must |
| FR-8 | `SKILL.md` documents the three tools for external agents | Must |
| FR-9 | Sync is previewable and idempotent | Should |
| FR-10 | Configurable status mapping per project | Could |

## 7. Non-functional requirements

- **Hosting:** 100% Forge serverless. No external database, no third-party egress of customer content.
- **Runtime:** Node.js 24.x LTS, TypeScript, `@forge/cli@15.1.0`.
- **Latency:** context bundle p95 < 5 s; verification p95 < 8 s; panel first paint < 2 s.
- **Resilience:** All Atlassian API calls use bounded retry with backoff; partial failure returns degraded-but-valid output, never a 500 to the UI.
- **Security:** Least-privilege scopes (see `TECH_STACK.md`); `asUser()` everywhere a permission decision matters; no secrets in code, logs, or KVS.
- **Accessibility:** WCAG 2.1 AA via UI Kit primitives; status conveyed by text + icon, never color alone.

## 8. Success metrics

| Metric | Target |
|---|---|
| Time from ticket open → agent has governed context | < 30 s |
| Reviews with an alignment score attached | > 80% of SpecGuard-enabled issues |
| Drift findings caught pre-merge | ≥ 60% of injected drift in demo/eval runs |
| Manual status updates eliminated per issue | ≥ 3 actions |
| External agents onboarded via `SKILL.md` | ≥ 3 clients (Freebuff, Cursor, Claude Code) in demo |

## 9. Out of scope (v1)

- Running or hosting the coding agent itself.
- Code parsing / AST-level diffing (v1 scores the submitted implementation summary, not raw source).
- Non-Atlassian trackers (GitHub Issues, Linear, Azure DevOps).
- Billing, marketplace pricing, and multi-tenant administration beyond Forge's model.
- Real-time collaborative editing of ADRs.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Teamwork Graph query latency or scope rejection | Degrade to Jira-only impact analysis; label the section `degraded` rather than failing the bundle |
| LLM non-determinism in scoring | Score from explicit per-criterion judgments with fixed weights; cache verdict per bundle hash |
| ADR discovery ambiguity (which page governs this issue?) | Explicit link first, then label/space convention, then a UI prompt to bind an ADR |
| Forge invocation time limits | Chunk verification per criterion with `async`/queue-friendly handlers; cap bundle size |
| Marketplace review (Runs on Atlassian) | No external calls carrying customer data; all processing inside Forge |

## 11. Release criteria

1. All `Must` requirements demonstrable end-to-end on `one-atlas-deuz.atlassian.net`.
2. `tsc --noEmit` and `forge lint` clean; no secrets in the repository.
3. `SKILL.md` validated against at least one external MCP client.
4. Panel and byline verified in both light and dark themes.
5. Demo script: ticket → context bundle → agent codes → verification → sync → Rovo question answered with an audit card.
