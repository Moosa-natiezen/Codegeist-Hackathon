# SpecGuard MCP

**The contract layer between AI coding agents and Atlassian.** SpecGuard gives an agent the governed
spec for a Jira issue *before* it writes code, scores the agent's implementation against that spec
*after*, and writes the verdict back into Jira and Confluence — deterministically, inside the
customer's own tenancy.

Built for **Atlassian Codegeist 2026** on Atlassian Forge. App
`ari:cloud:ecosystem::app/2dac9431-ae6d-461f-a35f-17b42a3b203e`, demo site
`https://one-atlas-deuz.atlassian.net`.

---

## 1. The problem

AI coding agents turn a Jira ticket into merged code faster than any human process can keep up with —
and they invent requirements while doing it, because the real spec is scattered:

| Where the truth lives | What the agent sees |
|---|---|
| Acceptance criteria in the issue description and **subtasks** | The ticket title |
| Architecture constraints in **Confluence ADRs** | Nothing |
| Blast radius in the **Teamwork Graph** | Nothing |

Nothing checks the finished code back against that intent either, so divergence is found in review or
in production. SpecGuard closes the loop in three calls:

```
specguard_get_context  →  agent codes  →  specguard_verify_implementation  →  specguard_sync_status
        (before)                                  (after)                          (write-back)
```

---

## 2. What it does

### 2.1 Pre-Flight Context Bundle — `specguard_get_context`

One call returns a normalized, token-efficient bundle for an issue key:

- **Acceptance criteria** parsed from the description and every subtask — checkbox lists
  (`- [ ]`), bullets under an *Acceptance Criteria* heading, and native Jira **task lists**
  (`taskList` / `taskItem`, including ticked state).
- **Governing ADR guardrails** from Confluence, resolved from the issue's remote links:
  `globalId` page IDs, canonical `/wiki/spaces/<KEY>/pages/<id>` URLs, `pageId=` query URLs, and
  **Confluence tiny links** (`/wiki/x/<key>`) decoded back to the numeric page ID. Unresolvable
  Confluence links fall back to a CQL **title** search, then to a `text ~ "<issue-key>"` search.
- **Dependency impact** from Jira issue links, plus the Teamwork Graph signal it exposes for a work
  item (linked external pull requests) through the work-item ARI
  `ari:cloud:jira:<cloudId>:issue/<id>`.
- A stable `bundleId` + content hash so a later verification can prove exactly which spec it scored.

Every step degrades instead of failing: zero ADRs returns `adrs: []` plus a warning, and a graph
failure is captured as structured `graphDiagnostics` (never a thrown error, never a secret).

### 2.2 Spec Alignment Score — `specguard_verify_implementation`

Scores a submitted implementation summary (plus optional changed files) from 0–100 and returns the
per-item evidence, drift findings, and remediation suggestions — **no model in the scoring path**.

| Component | Weight | Signal |
|---|---|---|
| Acceptance-criteria coverage | **50%** | each criterion `met` / `partially_met` / `not_met` / `not_verifiable` |
| ADR guardrail conformance | **35%** | each rule `respected` / `violated` / `not_verifiable` |
| Dependency / scope safety | **15%** | unresolved or unacknowledged dependencies |

```
score = round( Σ(weightᵢ × ratioᵢ) / Σ(weightᵢ over components with evidence) × 100 )
```

- **Deterministic:** identical bundle + identical submission ⇒ identical score (token-overlap
  judgement with fixed thresholds; no sampling, no temperature).
- **Renormalized, not punished:** a component with no evidence is excluded from the numerator *and*
  the denominator, so missing data lowers confidence instead of manufacturing drift.
- **Verdict bands:** `ALIGNED` ≥ 85 · `DRIFT_DETECTED` 50–84 · `BLOCKED_OR_VIOLATION` < 50. An ADR
  violation or an unaddressed blocking dependency caps an otherwise-aligned score at
  `DRIFT_DETECTED`.
- **No false blocks:** if an issue has no criteria *and* no ADRs, scoring is refused with
  `NO_SPECS_TO_VERIFY` ("No acceptance criteria or linked Confluence ADRs found. Add a checklist to
  the issue description or link an ADR page, then press Get context.") instead of reporting a
  misleading `0%`.

### 2.3 One-click write-back — `specguard_sync_status`

Posts an ADF audit comment (score, verdict, weights, findings, remediation) to the Jira issue and
maintains the `spec-drift` label — added when the verdict is not `ALIGNED`, removed when it is. Sync
is previewed in the panel before it is applied, and it is idempotent: re-syncing the same verdict
reuses the label rather than stacking duplicates.

### 2.4 Native surfaces

| Surface | What the user sees |
|---|---|
| `jira:issuePanel` — **SpecGuard Status** | Score + verdict band, progress bar, criteria checklist, ADR guardrails (linked to the page), dependency impact + graph diagnostics, agent audit log, drift-check form, sync preview |
| `confluence:contentBylineItem` | Compact ADR chip: `SpecGuard: 3 governed issues · 1 drift`, with an expandable per-issue score table and a **Re-evaluate** action that flags ADR edits made after verification |
| `rovo:agent` — **SpecGuard** | Natural-language Q&A ("Is PAY-412 still aligned with our ADRs?") answered from stored verifications or a fresh one, citing the issue key and ADR page |
| `rovo:mcp` — **SpecGuard MCP** | The same three tools exposed to any MCP client: Freebuff, Cursor, Claude Code, or a custom agent |

### 2.5 Agent skill

[`SKILL.md`](./SKILL.md) is the shipped, credential-free contract for external coding agents: when to
call each tool, how to interpret verdicts and blockers, how to connect over Atlassian's remote MCP
server, and how to fail safely.

---

## 3. Architecture

```
┌──────────────────────── Atlassian (Runs on Atlassian) ────────────────────────┐
│                                                                               │
│  Jira issue panel ─┐                        ┌─ Jira REST (asUser / asApp)     │
│  Confluence byline ┴─► Forge resolver ──────┼─ Confluence REST (ADR pages)    │
│  Rovo agent ───────┐   (src/backend)        └─ Teamwork Graph (work-item ARI) │
│  MCP client ───────┴─► tool handlers ──► scoring engine ──► Forge KVS         │
│                          (actions.ts)     (50/35/15)         (bundles,        │
│                                                               verdicts,       │
│                                                               audit, ADR index)│
└───────────────────────────────────────────────────────────────────────────────┘
```

**Forge modules** (`manifest.yml`)

| Module | Key | Handler / resource |
|---|---|---|
| `jira:issuePanel` | `specguard-issue-panel` | `resolver` → `src/frontend/issue-panel.tsx` |
| `confluence:contentBylineItem` | `specguard-adr-byline` | `resolver` → `src/frontend/confluence-byline.tsx` |
| `action` ×3 | `specguard-get-context`, `specguard-verify-implementation`, `specguard-sync-status` | `tools.specguardGetContext` / `…VerifyImplementation` / `…SyncStatus` |
| `rovo:agent` | `specguard-agent` | references the three actions |
| `rovo:mcp` | `specguard-mcp` | exposes the three tools |

**Source layout**

```
src/
  backend/
    cloudId.ts          tenant resolution: context → installContext ARI → extension.cloudId → cache → /_edge/tenant_info
    contextFetcher.ts   Jira + subtasks, remote links, Confluence ADRs (globalId / canonical / tiny links), Teamwork Graph
    extract.ts          ADF → text (incl. taskList/taskItem), acceptance-criteria + ADR-rule parsing
    scoringEngine.ts    deterministic 50/35/15 scoring, verdict bands, NO_SPECS_TO_VERIFY guard
    actions.ts          validated MCP / Rovo tool handlers
    syncEngine.ts       ADF comment + spec-drift label
    storage.ts          Forge KVS: bundles, latest verdict, audit log, ADR governance index
    index.ts            UI Kit resolver endpoints
  frontend/
    issue-panel.tsx     jira:issuePanel
    confluence-byline.tsx
    surfaceContext.ts   async product-context gate (spinner, never a blank panel)
    PanelBoundary.tsx   error boundary with diagnostic + retry
    viewModel.ts        pure, unit-tested view helpers
  tools.ts              Forge function entry points
tests/                  8 suites, 74 tests (unit + resolver integration)
```

**Storage** is Forge KVS only: `bundle:<issue>:<bundleId>`, `latest:<issue>`, `history:<issue>`,
`adr:<pageId>`. No external database, no object store, no third party.

---

## 4. Track mapping — Codegeist 2026

**Main category: Apps for Software Teams.** SpecGuard operates on the Jira issues and Confluence ADRs
delivery teams already use, and produces artifacts (alignment scores, drift findings, audit log) their
review process can act on.

| Bonus track | How SpecGuard satisfies it |
|---|---|
| **Best Agents** | `rovo:agent` module + three `action` extensions. Rovo answers alignment questions with a stored or freshly computed verdict and cites the issue key and ADR page; the same logic drives the panel. |
| **Best App with Atlassian MCP** | The app **is** an MCP server (`rovo:mcp`) with three governed tools and a public [`SKILL.md`](./SKILL.md). Any MCP client — Freebuff, Cursor, Claude Code — gets criteria, ADRs, and guardrails before coding, then submits its implementation for scoring. |
| **Best Teamwork Graph Integration** | Every bundle resolves the work-item ARI (`cloudId` from context, `installContext`, `extension.cloudId`, or `/_edge/tenant_info`) and queries the graph for linked pull requests, surfacing them as Dependency Impact. Graph failures are explained in-panel via `graphDiagnostics` rather than silently degrading. |
| **Best Marketplace Published App** | Forge-hosted and Runs on Atlassian eligible: zero external servers, no customer-content egress, least-privilege scopes, `asUser()` for every permission-sensitive read and all writes, documented install + permission rationale, light/dark UI Kit tokens only, and an error boundary around each surface. |

---

## 5. Judge quick start

### 5.1 Install

The app is deployed to the `production` environment and installed on
`https://one-atlas-deuz.atlassian.net` for both Jira and Confluence:

```bash
forge deploy -e production
forge install --non-interactive --site one-atlas-deuz.atlassian.net --product jira -e production
forge install --non-interactive --site one-atlas-deuz.atlassian.net --product confluence -e production
```

On your own site, install from the Forge developer console (**SpecGuard MCP → Distribution → Install**)
or run the two `forge install` commands above with your site name. Installation asks for exactly the six
scopes listed in §6.

### 5.2 Demo walkthrough (≈5 minutes)

1. **Create the ADR.** In Confluence, add a page *“ADR-014 Event Contracts”* with these sections:

   ```markdown
   ## Decision
   We will use schema-registry validation for every published event.

   ## Must
   - Validate payloads before publish
   - Version every schema change

   ## Must Not
   - Break the consumer contract without a major version bump
   ```

2. **Create the story.** In Jira, add a Story *PAY-412 — Add retry handling to the payment sync* with a
   checklist in the description (or a native task list — both are parsed):

   ```markdown
   ## Acceptance Criteria
   - [ ] Retry the sync on HTTP 429 with exponential backoff
   - [ ] Emit an audit log entry for every retry
   - [ ] Document the retry policy in the runbook
   ```

3. **Link the ADR** to the issue (*Link → Web link*, paste the Confluence URL). Canonical, `pageId=`,
   and `/wiki/x/<tiny>` URLs all resolve.

4. **Open the panel.** Jira issue → **Apps → SpecGuard Status** → **Get context**. You should see the
   score placeholder, three criteria, the ADR guardrails with a live link, dependency impact, and the
   audit log entry for the context fetch.

5. **Trigger drift.** **Run a drift check…** with a deliberately partial summary:

   ```
   Added retry on HTTP 429. Touched src/payments/sync.ts.
   ```

   Expect a sub-85 score, per-criterion `MISSING` / `PARTIAL` lozenges, and numbered findings that
   name the unmet criteria and ADR rules.

6. **Fix and re-verify.** Re-run with a complete summary:

   ```
   Retry the sync on HTTP 429 with exponential backoff (3 tries, jitter) in src/payments/sync.ts.
   Emit an audit log entry for every retry. Document the retry policy in the runbook.
   Validate payloads before publish; version every schema change.
   ```

   Expect **ALIGNED ≥ 85** and no blockers.

7. **Sync.** **Sync verification to Jira** → preview → **Apply**. The issue gets an ADF audit comment
   and, for a drifted verdict, the `spec-drift` label.

8. **Check the ADR.** Open *ADR-014* → the SpecGuard byline shows `3 governed issues · 0 drift`.
   Edit a `Must` bullet, press **Re-evaluate**, and the governed issues are flagged *needs re-review*
   — the ADR changed after they were verified.

9. **Ask Rovo.** *“Is PAY-412 still aligned with our ADRs?”* — the SpecGuard agent answers from the
   stored verification and cites the issue and the ADR page.

10. **Connect an external agent.** Point any MCP client at Atlassian's remote MCP server as described in
    [`SKILL.md` §3](./SKILL.md); `specguard_get_context`, `specguard_verify_implementation`, and
    `specguard_sync_status` appear in its tool list, and the agent pulls the bundle before coding.

### 5.3 What to try if something looks degraded

| Symptom | Meaning |
|---|---|
| *Dependency impact degraded* + `Teamwork Graph not queried: cloud ID is unavailable` | The invocation carried no tenant identity and `/_edge/tenant_info` failed. The panel still works from Jira issue links; the diagnostic line names the cause. |
| `Teamwork Graph degraded: <API message>` | The graph rejected the query (for example the graph preview is not enabled on the site). Impact falls back to Jira links. |
| `NO_SPECS_TO_VERIFY` | The issue has no criteria and no linked ADR — author one, then press **Get context**. This is a guard, not a failure. |
| Panel shows a spinner for ~1.5 s | The bridge has not delivered the product context yet; after the grace window the resolver — which carries its own context — drives the panel instead of rendering blank. |

---

## 6. Security & Runs on Atlassian

- **No external servers or databases.** Every network call goes to Atlassian (`asUser()` / `asApp()`
  to Jira, Confluence, and the Teamwork Graph). Nothing is sent to a third party; the app has no
  outbound host of its own. State lives in Forge KVS.
- **Runs on Atlassian eligible.** Forge serverless runtime (`nodejs24.x`), Forge storage, Forge
  identity — no egress of customer content, no external secrets.

| Scope | Why it is needed |
|---|---|
| `read:jira-work` | Read the issue, description, subtasks, issue links, and remote links |
| `write:jira-work` | Post the verification comment and maintain the `spec-drift` label |
| `read:confluence-content.all` | Read ADR page bodies to extract guardrail rules |
| `write:confluence-content` | Reserved for the ADR byline's re-evaluation write-back of the governance index |
| `read:graph:issue:jira` | Query Teamwork Graph for the work item's linked pull requests |
| `storage:app` | Bundles, verdicts, audit log, and ADR governance index in Forge KVS |

- **User-scoped by default.** Reads and every write use `asUser()`, so the audit trail names the human
  who acted and no user sees content they could not already open. `asApp()` is only a fallback for
  reads when user auth is unavailable.
- **No secrets in the repository.** Credentials are supplied by the environment (`FORGE_EMAIL`,
  `FORGE_API_TOKEN`) at deploy time only; there is no `.env` on disk and no token, key, or tenant
  content is logged. Diagnostics surface an HTTP status or API message, never a credential.
- **No prompt-injection surface.** Scoring never calls a model and never executes ticket content: it
  tokenizes text and applies fixed weights, so a malicious description cannot change the algorithm.

---

## 7. Local development

```bash
# Node 24.x LTS and @forge/cli@15.1.0
npm ci
npx tsc --noEmit          # strict type check
npx vitest run            # 8 suites, 74 tests
forge lint                # platform + manifest rules
forge deploy -e development
forge install --upgrade --site <your-site>.atlassian.net --product jira -e development
forge logs -e development -n 40
```

Resolvers are exported as plain handlers in `src/backend/index.ts`, so the panel, byline, Rovo, and MCP
paths are covered by the same tests:

| Test suite | Covers |
|---|---|
| `tests/graph.test.ts` | `cloudId` extraction (context, `installContext` ARI, `extension.cloudId`, cache, `tenant_info`), ARI validation, graph traversal diagnostics, MCP cloudId threading |
| `tests/confluence.test.ts` | Confluence tiny-link decoding, `globalId` / canonical / query page-ID extraction |
| `tests/extract.test.ts` | ADF flattening incl. `taskList` / `taskItem`, criteria and ADR-rule parsing |
| `tests/scoring.test.ts` | 50/35/15 scoring, verdict bands, determinism, renormalization |
| `tests/guards.test.ts` | `NO_SPECS_TO_VERIFY` across MCP and panel paths |
| `tests/resolver.test.ts` | Panel + byline resolver flows end to end |
| `tests/actions.test.ts` | MCP tool handlers and persistence |
| `tests/viewModel.test.ts` | UI-state helpers, chip labels, graph diagnostic notes |

---

## 8. Scope of v1

- Scoring judges the **submitted implementation summary** (plus changed files) — not an AST diff. That
  keeps it deterministic, auditable, and fast, and keeps source code out of the app entirely.
- Sync posts the audit comment and maintains the `spec-drift` label. Ticking criteria checkboxes and
  Jira status transitions are deliberately deferred: both mutate author-owned content and deserve an
  explicit per-project mapping.
- ADR discovery is link-first, then title search, then issue-key text search. Ambiguous matches surface
  as a warning rather than a guessed page.

## 9. Docs

- [`docs/PRD.md`](./docs/PRD.md) — problem, scope, target tracks, requirements, success metrics.
- [`docs/DESIGN.md`](./docs/DESIGN.md) — UI Kit surfaces, states, accessibility, budgets.
- [`docs/TECH_STACK.md`](./docs/TECH_STACK.md) — modules, source layout, KVS data model, tool contracts, scopes.
- [`SKILL.md`](./SKILL.md) — the agent-facing contract and MCP client setup.

---

**Built on Atlassian Forge for Codegeist 2026.** No external infrastructure, no model calls, no data
leaves the tenant.
