# SpecGuard MCP — Design Document

| Field | Value |
|---|---|
| Product | SpecGuard MCP |
| Surface | Atlassian Forge UI Kit (`@forge/react`) |
| Modules | `jira:issuePanel`, `confluence:contentBylineItem`, Rovo chat cards |
| Status | Architecture locked |
| Last updated | 2026-11-25 |

---

## 1. Design principles

1. **Native, not adjacent.** SpecGuard should read as a first-party Atlassian surface: UI Kit components, Atlassian tokens, Atlassian spacing. No custom design system, no brand colors, no re-skinned buttons.
2. **Verdict first, evidence second.** The user's question is always "is this safe to merge?" — answer it in the first 48 px, then let them drill into criteria and ADRs.
3. **Never a bare number.** Every score is presented with the findings that produced it. A percentage without evidence is treated as a design defect.
4. **Honest emptiness.** No bundle, no ADRs, or degraded graph data each get an explicit, actionable state — never a spinner or a blank card.
5. **Text + icon for status.** Color is reinforcement only, so the product survives dark mode, color-blindness, and grayscale screenshots.

## 2. UI framework and tokens

- **Framework:** Atlassian **Forge UI Kit** via `@forge/react`. UI Kit supplies the components (`Badge`, `Lozenge`, `Box`, `Stack`, `Inline`, `Text`, `Heading`, `Button`, `SectionMessage`, `ProgressBar`, `Table`, `DynamicTable`, `Spinner`, `Tabs`, `Code`, `Link`, `Tooltip`, `EmptyState` equivalents).
- **Theming:** All color, elevation, and typography come from Atlassian design tokens resolved by UI Kit at runtime — light and dark are automatic. **Hard-coded hex values are prohibited** in app code and in this document's implementation notes.
- **Semantic mapping (token intent, not literal hex):**

| Meaning | UI Kit expression |
|---|---|
| Aligned / healthy | `Lozenge appearance="success"` + check icon + word "Aligned" |
| Drift detected | `Lozenge appearance="warning"` (warning) or `"danger"` (blocker findings) + word "Drift Detected" |
| Unverified / no data | `Lozenge appearance="default"` + word "Unverified" |
| Informational | `Lozenge appearance="information"` |
| Score meter | `ProgressBar` with `appearance` following the verdict band |

- **Spacing/layout:** `Box` padding `space.100`–`space.200`, `Stack space="space.100"` for vertical rhythm. Panel width is Jira-constrained (~360–420 px) — never assume desktop width.
- **Typography:** `Heading size="small"` for section titles, `Text size="small"` for body, `Text size="small" color="color.text.subtlest"` for metadata.

## 3. Surface 1 — `jira:issuePanel` ("SpecGuard Status")

The primary surface: an at-a-glance verdict for the issue, with evidence nested beneath.

### 3.1 Layout (top → bottom)

1. **Header** — `Inline`: title "SpecGuard Status" + refresh `Button` (`appearance="subtle"`, icon-only, `aria-label="Refresh"`).
2. **Alignment Score Badge** — the focal element:
   - Large numeric score (`Heading size="medium"`, e.g. `92%`) with the band word beside it (`Aligned` / `Drift Detected` / `Unverified`).
   - `ProgressBar` underneath showing 0–100 with the band's appearance.
   - Subtext: `Verified <relative time> · bundle <short hash> · by <display name>`.
3. **Acceptance Criteria Checklist** — one row per criterion:
   - Status icon: `met` (check, success), `partially_met` (half, warning), `not_met` (cross, danger), `not_verifiable` (dash, default).
   - Criterion text (wrapping, max 3 lines with "show more").
   - Weight indicator is implicit; the section footer states `n of m criteria met (50% of score)`.
4. **Linked Confluence ADR Guardrails** — list of governing ADRs:
   - ADR key/title as a `Link` opening in a new tab.
   - Conformance `Lozenge`: `Respected` / `Violated` / `Not applicable`.
   - One-line quoted constraint in `Text size="small"`.
   - Footer: `35% of score` and, when discovery was heuristic, an `information` note "Matched by label — confirm binding".
5. **Teamwork Graph Dependency Impact**:
   - Counts: dependent issues, owning team, downstream services.
   - Each dependent issue as a `Link` with its status `Lozenge`.
   - If graph data is unavailable: `SectionMessage appearance="warning"` "Dependency impact unavailable (graph query degraded) — score excludes the 15% impact weight."
6. **Agent Audit Log** — collapsible (`Tabs` or disclosure) table of events: timestamp, actor (human or agent client), tool (`get_context` / `verify` / `sync`), bundle hash, verdict. Newest first, 10 rows with "View all".
7. **Primary action** — `Button appearance="primary"` "Sync to Jira & Confluence", disabled until a verification exists; opens the sync **preview** below it.

### 3.2 Sync preview (inline, replaces the button area when opened)

- `SectionMessage appearance="info"` summarizing intended writes.
- Bullet list of concrete effects: `Comment: SpecGuard verdict — 92% Aligned`, `Tick criteria: AC-1, AC-3`, `Transition: In Review`, `ADR-014: append guardrail note`.
- `Inline`: `Button appearance="primary"` "Apply" + `Button appearance="subtle"` "Cancel".
- After apply: success `SectionMessage` with links to the created comment and updated ADR, plus per-target results (Jira / Confluence) so a partial failure is visible.

### 3.3 States

| State | Presentation |
|---|---|
| **No bundle yet** | `Unverified` badge, score shown as `—`. `SectionMessage appearance="information"`: "No context bundle for this issue yet. Run `specguard_get_context` from your agent, or press Get context." Action: `Button` "Get context". |
| **Loading** | `Spinner` with `label="Loading SpecGuard status"` inside a fixed-height Box to prevent layout jump. |
| **Bundle exists, not verified** | `Unverified`, criteria listed as `not_verifiable`, action "Verify implementation" |
| **Verified, aligned** | Success lozenge, full evidence, primary action enabled |
| **Verified, drift** | Warning/danger lozenge, findings list expanded by default, primary action enabled |
| **Error (permission/API)** | `SectionMessage appearance="error"` with the failing resource named and a Retry `Button` |
| **Forge invocation timeout** | Cached last-known verdict with a `warning` note "Showing last verification from <time> — refresh failed." |

### 3.4 Microcopy rules

- Verdict words are fixed strings: `Aligned`, `Drift Detected`, `Unverified`.
- No exclamation marks, no anthropomorphism ("SpecGuard thinks…" → "Verification found…").
- Findings are written as facts with the source named: *"AC-2 (retry on 429) has no corresponding change in the submitted implementation."*
- Times are relative (`2 minutes ago`) with absolute time in a `Tooltip`.

## 4. Surface 2 — `confluence:contentBylineItem` (ADR byline)

Compact, non-intrusive, appears in the page byline next to author/date.

- **Collapsed chip:** `Lozenge` + short text: `SpecGuard · 4 issues governed · 1 drift`.
  - Aggregate status logic: any `blocker` finding ⇒ danger; any `warning` ⇒ warning; only aligned ⇒ success; no governed issues ⇒ default.
- **Popover/expanded view** (`Box` with `Stack`):
  - `Heading size="xxsmall"` "Governed issues".
  - `Table` (2 cols): issue key (link) | latest verdict lozenge, newest 5, "View all in Jira" link.
  - Footer line: `Last evaluated <relative time>` and a `Button appearance="subtle"` "Re-evaluate" (re-runs verification against current ADR content and flags ADRs edited after the last verification as `needs re-review`).
- **States:** no governing issues ⇒ chip reads `SpecGuard · not linked` with an `information` tooltip explaining how issues bind to this ADR; graph/API error ⇒ chip hidden and error logged, never a broken byline.

## 5. Surface 3 — Rovo chat audit cards

Returned by the `rovo:agent` module as structured cards (not prose), so the same evidence model as the panel appears in chat.

- **Card anatomy:**
  1. Title line: `<issue key> — 92% Aligned` with the verdict `Lozenge`.
  2. Findings summary: up to 3 bullets, each naming its source (AC or ADR) + severity `Lozenge`.
  3. Criteria roll-up: `3 of 4 met · 1 partially`.
  4. Actions: `Open in Jira` (link), `Sync status` (`rovo:action`), `Verify again`.
  5. Footer: bundle hash + verified-at, so a chat screenshot is self-authenticating.
- **Answer discipline:** the agent must answer only from stored verification records or a fresh verification; when neither exists the card says so and offers to run `specguard_get_context`.
- **Citations:** every claim links to the Jira issue or Confluence page it came from — Rovo answers must be auditable, not summarized.

## 6. Interaction flows

### 6.1 First-run (issue with no SpecGuard history)

`Panel loads` → `Unverified` state → "Get context" → bundle built (spinner in button) → criteria + ADRs appear as `not_verifiable` → developer runs agent → agent calls `verify` → panel refresh shows score, findings, audit log entry → "Sync to Jira & Confluence" → preview → Apply → confirmation with links.

### 6.2 Drift remediation loop

`Drift Detected` card → findings list (blocker first) → developer copies finding text into the agent session (one-click "Copy findings" `Button`) → agent fixes → `verify` again → score rises → sync ticks newly met criteria.

### 6.3 ADR change

Architect edits ADR-014 → byline flags `needs re-review` → "Re-evaluate" re-verifies governed issues → issues whose implementation violates the updated constraint flip to `Drift Detected` and get a Jira label `spec-drift`.

## 7. Accessibility

- Status is always **word + icon + color**, satisfying WCAG 1.4.1.
- Score `ProgressBar` carries an accessible label ("Spec alignment, 92 percent") — the number is never only visual.
- All icon-only buttons have `aria-label`; focus order follows visual order; no keyboard traps in the disclosure regions.
- Contrast is inherited from Atlassian tokens (UI Kit guarantees AA in both themes).
- Lists use semantic `Table`/list components rather than visually-spaced `Text` runs, so screen readers announce structure.

## 8. Performance budgets (UI)

| Metric | Budget |
|---|---|
| Panel first paint (cached verdict) | < 1.5 s |
| Panel with fresh verification fetch | < 3 s |
| Byline chip render | < 1 s |
| Sync preview computation | < 2 s |
| Audit log page (10 rows) | < 1 s |

Implementation notes: render cached KVS state immediately, then reconcile; never block first paint on Confluence or Teamwork Graph calls; use Forge `async` handlers with bounded retry for slow dependencies.

## 9. Out of scope for UI v1

- Custom charts beyond `ProgressBar` (no bespoke canvas/SVG).
- Inline editing of ADRs from SpecGuard.
- Bulk multi-issue dashboards (Jira dashboard gadget is a post-v1 candidate).
- Mobile-native layouts (UI Kit responsive behavior only).
