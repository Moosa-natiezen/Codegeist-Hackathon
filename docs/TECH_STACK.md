# SpecGuard MCP — Tech Stack & Architecture

| Field | Value |
|---|---|
| App | SpecGuard MCP |
| Hosting | 100% Atlassian Forge (serverless) |
| Runtime | Node.js **24.x** LTS, TypeScript |
| Tooling | `@forge/cli@15.1.0` |
| Target site | `https://one-atlas-deuz.atlassian.net` |
| Persistence | `@forge/kvs` (no external database) |
| Status | Architecture locked |
| Last updated | 2026-11-25 |

---

## 1. Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│  External AI coding agents                                           │
│  Freebuff · Cursor · Claude Code · any MCP client                    │
│  (consume root SKILL.md, speak MCP)                                  │
└───────────────▲──────────────────────────────────────────────────────┘
                │  MCP tools: specguard_get_context / _verify_implementation / _sync_status
┌───────────────┴──────────────────────────────────────────────────────┐
│  Forge app  (Node 24 LTS · TypeScript · @forge/cli 15.1.0)            │
│                                                                       │
│  rovo:mcp ──► resolver ──► context service ──► Jira REST (asUser)     │
│  rovo:agent ─┘            verification      ──► Confluence REST       │
│  rovo:action ─┘           sync service      ──► Teamwork Graph         │
│  jira:issuePanel ─────────► UI Kit (@forge/react)                     │
│  confluence:contentBylineItem ─► UI Kit (@forge/react)                │
│                                                                       │
│  Persistence: @forge/kvs   Secrets: Forge variables (none required v1)│
└───────────────▲──────────────────────────────────────────────────────┘
                │
        Atlassian platform (Jira · Confluence · Rovo · Teamwork Graph)
```

**Design constraints that follow from this shape:**

- No external database, no outbound calls that carry customer content, no container, no long-running process. This keeps the app eligible for **Runs on Atlassian** marketplace designation.
- All reads/writes that depend on a human's permissions go through `asUser()`; app-scoped `asApp()` is reserved for the app's own KVS bookkeeping and for operations the user has implicitly authorized (e.g. app-owned Confluence section writes where `asUser()` lacks scope).
- Every handler is idempotent and cache-first so Forge invocation limits are never the user's problem.

---

## 2. Manifest modules

`manifest.yml` (source of truth; this table mirrors it):

| Module | Key | Entry point | Purpose |
|---|---|---|---|
| `jira:issuePanel` | `specguard-issue-panel` | `src/frontend/index.tsx` | "SpecGuard Status" panel: score badge, criteria checklist, ADR guardrails, dependency impact, audit log, sync |
| `confluence:contentBylineItem` | `specguard-adr-byline` | `src/frontend/byline.tsx` | ADR page byline chip: governed issue count + drift status |
| `rovo:agent` | `specguard-agent` | `src/rovo/agent.ts` | Natural-language Q&A over verifications, returns structured audit cards |
| `rovo:action` | `specguard-sync-action` (+ `verify-action`) | `src/rovo/actions.ts` | Rovo-initiated sync / re-verify with the same permission and preview rules as the UI |
| `rovo:mcp` | `specguard-mcp` | `src/mcp/server.ts` | MCP server exposing the three governed tools to external agents |

### 2.1 Module notes

- **`rovo:mcp`** is the integration surface for Codegeist's MCP track and for `SKILL.md` consumers. Tool schemas are declared once in `src/mcp/schemas.ts` and reused by the Rovo agent so chat and MCP can never drift apart.
- **`rovo:agent`** holds no business logic of its own: it selects a tool, calls the same service functions as the panel, and renders the result as an audit card.
- **`rovo:action`** is the write path from chat. It must enforce the same preview/idempotency contract as the panel's Sync button (see `DESIGN.md` §3.2).

---

## 3. Source layout

```
manifest.yml
SKILL.md                      # public agent skill (MCP entry instructions)
src/
  index.ts                    # resolver: maps module keys + routes to handlers
  frontend/
    index.tsx                 # jira:issuePanel
    byline.tsx                # confluence:contentBylineItem
    components/               # ScoreBadge, CriteriaList, AdrList, ImpactList, AuditLog, SyncPreview
  mcp/
    server.ts                 # rovo:mcp handler
    schemas.ts                # tool input/output schemas (single source of truth)
  rovo/
    agent.ts                  # rovo:agent
    actions.ts                # rovo:action
  services/
    context.ts                # bundle assembly (Jira + Confluence + Graph)
    verification.ts           # accepted criteria/ADR judgments → weighted score
    sync.ts                   # Jira comment/labels/transition + Confluence guardrail note
    jira.ts                   # @forge/api wrappers, retry/backoff
    confluence.ts
    graph.ts                  # Teamwork Graph traversal
    audit.ts                  # audit log writes
  storage/
    keys.ts                   # KVS key builders + TTL policy
    kv.ts                     # typed get/set helpers
  types/                      # Bundle, Verification, Finding, AuditEvent
tests/                        # unit tests for scoring + sync idempotency
```

---

## 4. Data model (`@forge/kvs`)

| Key pattern | Value | TTL | Notes |
|---|---|---|---|
| `bundle:<issueKey>:<bundleId>` | `ContextBundle` (criteria, adrs, impact, hashes, createdAt) | 30 days | Immutable snapshot; verification cites it |
| `latest:<issueKey>` | `{ bundleId, verificationId, score, verdict }` | none | Fast panel/byline paint |
| `verification:<verificationId>` | `Verification` (judgments, findings, score, actor, bundleHash) | 180 days | Audit trail |
| `adr:<pageId>` | `{ governedIssues: string[], lastVerdict, needsReReview }` | none | Byline source |
| `specguard:adr:<pageId>:cached_rule` | `{ pageId, pageTitle, pageUrl, rules, issueKeys, cachedAt }` | none | Parsed ADR rules, written by the byline or by browser-session ingestion; read by `discoverAdrRules` when a live read is refused |
| `specguard:issue:<issueKey>:cached_adrs` | `{ issueKeys, pageIds, updatedAt }` | none | Issue → cached ADR page IDs, so the panel can resolve rules no live link returns |
| `audit:<issueKey>` (list, capped) | `AuditEvent[]` (ts, actor, client, tool, bundleId, verdict) | 180 days | Panel audit log |
| `config:<cloudId>:<projectKey>` | `{ statusMapping, adrBinding }` | none | Optional per-project settings |

Rules:

- Keys are namespaced by `cloudId`-derived app installation context (Forge KVS is already per-installation); never store PII beyond Atlassian account IDs.
- Nothing secret is ever written to KVS — no tokens, no API keys. There are **no required app secrets in v1**.
- Verification records are append-only; a re-verify creates a new `verificationId`.

---

## 5. Tool contracts (MCP + shared services)

```ts
// specguard_get_context
input : { issueKey: string, includeGraph?: boolean }        // includeGraph default true
output: { bundleId, bundleHash, issue: {...}, criteria: Criterion[],
          adrs: Adr[], impact: Impact, warnings: string[], instructions: string }

// specguard_verify_implementation
input : { issueKey: string, bundleId: string,
          implementation: { summary: string, files?: string[], notes?: string } }
output: { verificationId, score: number, verdict: "Aligned"|"Drift Detected"|"Unverified",
          criteria: CriterionVerdict[], adrs: AdrVerdict[], findings: Finding[],
          weights: { criteria: 50, adrs: 35, impact: 15 } }

// specguard_sync_status
input : { issueKey: string, bundleId: string, apply?: boolean }   // apply=false => preview
output: { preview: SyncAction[], applied: boolean, results: { jira: Result, confluence: Result } }
```

**Scoring (deterministic, no model sampling):**

```
score = 50 * criteriaMetRatio + 35 * adrRespectedRatio + 15 * impactDisclosed
verdict = score >= 85 ? "Aligned" : findings.length ? "Drift Detected" : "Unverified"
```

`not_verifiable` judgments are excluded from the ratio's denominator (never scored as failures). Weights are constants in `verification.ts` and echoed in every response so the number is explainable.

---

### 5.1 Browser-session ADR fallback (`ingestClientAdrPage`)

Some sites refuse the app's own Confluence identity (`asUser` → `Authentication Required`, `asApp` → HTTP 401) even with `read:confluence-content.all`. The Jira panel therefore reads a linked ADR page with the viewer's session (`requestConfluence` from `@forge/bridge`, v2 then v1) and posts the storage body to the resolver:

```ts
// ingestClientAdrPage
input : { pageId: string, storageHtml: string, title?: string, url?: string,
          issueKey?: string, cloudId?: string }
output: PanelIssueState   // same shape as getIssueSpecState
```

The handler extracts rules with the byline's `extractAdrRules`, caches them in the KVS keys above, then re-fetches the context so the returned bundle already contains the hydrated ADR rules. `PanelIssueState.resolvedPageIds` (mirrored from `bundle.resolvedPageIds`) tells the panel which linked pages it may hydrate.

The Confluence byline uses the same browser read so opening SpecGuard on an ADR page always caches its rules:

```ts
// cacheClientAdrPage — byline path, no Jira panel state to refresh
input : { pageId: string, storageHtml: string, title?: string, url?: string }
output: { pageId, pageTitle, ruleCount, issueKeys: string[], cachedAt: string | null }
```

Both resolvers expose the identical extraction + `cacheAdrRules` behaviour; only `ingestClientAdrPage` takes an issue key and re-fetches the scoreable bundle. The byline calls `ingestClientAdrPage` when the page already governs a Jira issue, otherwise `cacheClientAdrPage`, once per page per byline session. The Jira panel reacts to a failed browser read (for example before Confluence consent is granted) with an inline note and a **Retry Confluence Sync** button inside *Linked Confluence ADRs*.

---

## 6. Required scopes

```yaml
permissions:
  scopes:
    - read:jira-work                 # issues, subtasks, fields
    - write:jira-work                # comments, labels, transitions
    - read:confluence-content.all    # ADR pages + bodies
    - write:confluence-content       # guardrail note on ADR pages
    - read:graph:jira                # Teamwork Graph traversal
    - storage:app                    # @forge/kvs persistence
```

Scope rationale (for marketplace review): each scope maps 1:1 to a feature — no scope is requested for a capability the app does not ship.

---

## 7. Runtime, tooling, and commands

- **Node.js:** 24.x LTS (`v24.22.3` in this workspace, managed by nvm at `$HOME/.nvm`). Forge CLI warns on other majors — stay on 24.x.
- **Language:** TypeScript, `strict: true`; UI via `@forge/react` (UI Kit), API via `@forge/api`, storage via `@forge/kvs`.
- **Lint:** `forge lint` (platform rules) + ESLint/Prettier for app code.
- **Tests:** Vitest/Jest for scoring determinism and sync idempotency.

```bash
# once an app exists in this repo
npm ci
npx tsc --noEmit                 # type check
npm test                         # unit tests (scoring, sync)
forge lint                       # Forge platform + manifest rules
forge deploy                     # deploy to development environment
forge install --site one-atlas-deuz --product jira --product confluence
forge tunnel                     # local iteration on UI
```

- Credentials come from Freebuff Project Secrets (`FORGE_EMAIL`, `FORGE_API_TOKEN`) — see `AGENTS.md`. No `.env` file is required, and secrets are never echoed or committed.

---

## 8. `SKILL.md` — open-source agent skill

Root-level `SKILL.md` is the public contract for external coding agents. Shape:

1. **When to use** — before writing code for a Jira issue; after implementation; when status must be reflected in Jira/Confluence.
2. **Before coding:** call `specguard_get_context` with the issue key. Treat returned `criteria` as the definition of done and `adrs[].constraint` as non-negotiable design rules. If `warnings` is non-empty, surface it to the user.
3. **After coding:** call `specguard_verify_implementation` with the same `bundleId` and an honest `implementation.summary` (files changed, behavior added). Fix `blocker` findings and re-verify. Never edit the summary to inflate the score — the hash is auditable.
4. **When done:** call `specguard_sync_status` with `apply: false` first, show the preview, then `apply: true`.
5. **Failure handling:** on `Unverified`, report missing evidence instead of guessing; on degraded impact data, say the impact weight was excluded.
6. **Security:** never print tenant content beyond what the user asked for; never store bundle contents in the agent's own logs.

The skill ships with example invocations for Freebuff, Cursor, and Claude Code MCP configuration.

---

## 9. Security and compliance

- **Permissions:** `asUser()` for all human-scoped reads/writes; permission denials surface as explicit errors, never silent empty results.
- **Least privilege:** the six scopes above; no `manage:jira-configuration`, no admin scopes, no user-management scopes.
- **No data egress:** verification is computed inside the Forge function from Atlassian data; nothing is sent to third-party services. Eligible for Runs on Atlassian.
- **Secrets:** none required in v1. Any future secret (e.g. an optional model endpoint) goes into Forge variables/secrets, never into KVS or the repo.
- **Auditability:** every MCP/Rovo call appends an `AuditEvent` with actor, client, tool, bundle hash, and verdict.

## 10. Observability

- Structured JSON logs via `console.log` with `issueKey`, `bundleId`, `verificationId`, `durationMs`, `degradedFlags` — never token values or full issue bodies.
- `forge logs` for development; error paths return a stable `errorCode` (`GRAPH_DEGRADED`, `ADR_UNRESOLVED`, `PERMISSION_DENIED`, `SCORING_NO_EVIDENCE`) so the UI and cards can localize the message.
- Latency budgets from `DESIGN.md` §8 are asserted in tests where feasible (service-level timing, not UI).

## 11. Deployment topology

| Environment | Site | Purpose |
|---|---|---|
| `development` | `one-atlas-deuz.atlassian.net` | hackathon demo + judging |
| `production` | same site (Forge app version promotion) | marketplace submission build |

Forge handles hosting, scaling, and versioning; there is no infrastructure to operate beyond `forge deploy` / `forge install`. The provisioned demo site expires **2027-02-15** — the submission and judging window sits comfortably inside it.
