# SpecGuard — agent skill

**Audience:** AI coding agents (Freebuff, Cursor, Claude Code, any MCP client).
**What it does:** gives you the governed spec for a Jira issue *before* you write code, scores your
implementation against it *after*, and writes the verdict back into Jira/Confluence.

SpecGuard is an Atlassian Forge app published through Atlassian's MCP server (`rovo:mcp`). It reads
Jira acceptance criteria, Confluence ADRs, and Teamwork Graph dependencies — using the permissions of
the Atlassian user who authorized the MCP connection, never a shared service account.

---

## 1. When to use this skill

Use SpecGuard when the task is tied to a Jira issue and correctness is judged against a written spec:

| Moment | Call |
|---|---|
| Before writing any code | `specguard_get_context` |
| After implementing, before opening a PR | `specguard_verify_implementation` |
| After the user approves the verdict | `specguard_sync_status` |

Skip it for work with no Jira issue, or for purely mechanical tasks (typo fixes, dependency bumps)
where the user has already confirmed no criteria apply.

---

## 2. Tools

### 2.1 `specguard_get_context` — before coding

**Input**

```json
{ "issueKey": "PAY-412" }
```

**Output** (shape)

```json
{
  "issueKey": "PAY-412",
  "bundleId": "1790000000000-1a2b3c4d",
  "bundleHash": "1a2b3c4d",
  "bundle": {
    "issue": { "summary": "...", "status": "In Progress", "issueType": "Story" },
    "criteria": [{ "id": "AC-1", "text": "Retry the sync on HTTP 429 with backoff" }],
    "adrs": [{ "pageId": "1001", "pageTitle": "ADR-014 Event Contracts", "kind": "Must", "text": "..." }],
    "dependencies": [{ "key": "PAY-300", "relationship": "is blocked by", "resolved": false }],
    "warnings": [],
    "graphSource": "teamwork-graph"
  },
  "instructions": "Treat the N acceptance criteria below as the definition of done. ..."
}
```

**How to behave**

1. Treat every acceptance criterion as the definition of done. Do not narrow, merge, or reword them.
2. Treat each ADR rule as a hard constraint. `Must Not` rules are prohibitions, not suggestions.
3. Keep the returned `bundleId` — the verification call needs it to prove which spec you were given.
4. If `warnings` is non-empty, tell the user which context is missing (e.g. no ADR resolved, graph
   traversal degraded) instead of silently proceeding.
5. If a dependency is `resolved: false` and its relationship is `is blocked by`, say so before you
   start: the work may not be startable.

### 2.2 `specguard_verify_implementation` — after coding

**Input**

```json
{
  "issueKey": "PAY-412",
  "bundleId": "1790000000000-1a2b3c4d",
  "implementationSummary": "Added exponential backoff (3 tries, jitter) in src/payments/sync.ts; emits audit event on every retry; runbook section added.",
  "changedFiles": ["src/payments/sync.ts", "docs/runbook.md"],
  "agentSource": "cursor"
}
```

**Output** (shape)

```json
{
  "score": 92,
  "verdict": "ALIGNED",
  "criteria": [{ "id": "AC-1", "status": "met", "evidence": "..." }],
  "adrs": [{ "kind": "Must", "status": "respected" }],
  "findings": [{ "source": "AC-3", "severity": "warning", "message": "..." }],
  "suggestions": ["Add a test proving AC-3 is satisfied."],
  "weights": { "criteria": 50, "adrs": 35, "impact": 15 }
}
```

**Verdict bands:** `ALIGNED` ≥ 85 · `DRIFT_DETECTED` 50–84 · `BLOCKED_OR_VIOLATION` < 50.

**How to behave**

1. Write an **honest** summary: what behavior changed, which files, which criteria each change serves.
   The bundle hash makes the claim auditable, so inflating the summary is detectable and pointless.
2. Fix every `blocker` finding (an ADR violation or an unaddressed blocking dependency) and re-verify.
3. Never edit the spec, the criteria, or a stored bundle to raise the score. If a criterion looks
   wrong, tell the user and let a human change Jira.
4. Report the score with its findings, never the number alone.

### 2.3 `specguard_sync_status` — when done

**Input**

```json
{ "issueKey": "PAY-412", "postComment": true, "addDriftLabel": true }
```

Posts an ADF audit comment with the score, verdict, and findings; adds the `spec-drift` label when the
verdict is not `ALIGNED`, and removes it when it is. The stored verdict must exist first.

**How to behave:** ask the user before the first sync of a session — it writes to their Jira issue —
then report the comment URL/id and any per-target warnings.

---

## 3. Connecting an MCP client

SpecGuard is reached through Atlassian's remote MCP server; the app supplies the tools, Atlassian
supplies transport and user authorization. No API keys, tokens, or credentials belong in a client
config — authorization happens in the browser the first time you connect.

### 3.1 Generic MCP client (JSON)

```json
{
  "mcpServers": {
    "specguard": {
      "type": "http",
      "url": "https://mcp.atlassian.com/v1/mcp",
      "headers": { "Accept": "application/json, text/event-stream" }
    }
  }
}
```

### 3.2 Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "specguard": {
      "url": "https://mcp.atlassian.com/v1/mcp"
    }
  }
}
```

Then in Cursor: **Settings → MCP → specguard → Connect** and complete the Atlassian sign-in prompt in
the browser.

### 3.3 Claude Code

```bash
claude mcp add --transport http specguard https://mcp.atlassian.com/v1/mcp
```

Authenticate when prompted, then confirm the tools are visible:

```bash
claude mcp list
# specguard: https://mcp.atlassian.com/v1/mcp (HTTP) - connected
```

### 3.4 Freebuff

Add the same endpoint as an HTTP MCP server in the project's agent configuration, then authorize it
in the browser:

```json
{
  "mcp": {
    "servers": {
      "specguard": { "type": "http", "url": "https://mcp.atlassian.com/v1/mcp" }
    }
  }
}
```

### 3.5 Verifying the connection

Ask the agent to list its tools; you should see `specguard_get_context`,
`specguard_verify_implementation`, and `specguard_sync_status`. If only some appear, the app version
installed on the site is older than this skill — ask the site admin to upgrade the app.

---

## 4. End-to-end example (agent transcript outline)

```
user: implement PAY-412
agent: [specguard_get_context {issueKey: "PAY-412"}]
       → 3 criteria, 2 ADR guardrails, 1 blocking dependency (PAY-300, open)
agent: PAY-300 ("schema registry rollout") is still open and this issue is blocked by it.
       Proceeding with the code but the sync will stay blocked until PAY-300 closes.
       [writes code]
       [specguard_verify_implementation {issueKey:"PAY-412", bundleId:"...", implementationSummary:"..."}]
       → 88 ALIGNED, 1 warning: AC-3 partially evidenced
agent: [adds a runbook note, re-verifies] → 95 ALIGNED
user: sync it
agent: [specguard_sync_status {issueKey:"PAY-412", postComment:true, addDriftLabel:true}]
       → comment posted (id 10231), no drift label applied
```

---

## 5. Failure handling

| Tool result | What to do |
|---|---|
| `ok: false`, `INVALID_INPUT` | Fix the argument shape; issue keys look like `PROJ-123`. |
| `ok: false`, `BUNDLE_NOT_FOUND` | Call `specguard_get_context` again; the bundle expired or the id is stale. |
| `ok: false`, `NO_VERIFICATION` | Run `specguard_verify_implementation` before syncing. |
| `ok: false`, `CONTEXT_FETCH_FAILED` / `VERIFICATION_FAILED` / `SYNC_FAILED` | Report the message verbatim; do not retry more than once. |
| `warnings` mentioning degraded graph or unresolved ADRs | Say the score excluded that evidence; do not claim full coverage. |

---

## 6. Boundaries

- SpecGuard never edits acceptance criteria, ADR prose, or source code. It reads, scores, and comments.
- Scores are deterministic given the same bundle and summary — a changed score means a changed claim.
- Do not paste tenant content into third-party services; the bundle is for the task at hand only.
- This file contains no credentials and never should. Authorization is handled by Atlassian OAuth.
