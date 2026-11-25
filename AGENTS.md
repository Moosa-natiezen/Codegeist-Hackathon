# AGENTS.md — Atlassian Forge Development Rules

Rules for any agent or contributor working in this repository (Codegeist 2026 Hackathon).

## Platform

- Target: **Atlassian Forge** — apps are defined by `manifest.yml` and run on the Node.js runtime.
- Runtime: **Node.js 24.x LTS** (`v24.22.3`) via `nvm`, installed user-locally at `$HOME/.nvm` (`/usr/local/nvm` is root-owned and must not be modified). `~/.bashrc` and `~/.profile` source `nvm.sh`, so `node --version` resolves to `v24.x.x` in new shells.
- Forge CLI: **`@forge/cli@15.1.0`**, installed globally into the active nvm Node tree. Other Node majors make the CLI print an `Unsupported Node.js versions` warning — stay on 24.x.
- Use `forge` for all platform operations.

## Environment

- Provisioned Atlassian development site: **https://one-atlas-deuz.atlassian.net**
  - Site name: `one-atlas-deuz`
  - Status: `active`
  - Expires: **2027-02-15**
- `forge site provision` is idempotent: it reports the existing demo site, or provisions one asynchronously (re-run it to poll until a site URL and expiry appear).

## Authentication (non-interactive)

- Credentials are managed as **Freebuff Project Secrets**: `FORGE_EMAIL` and `FORGE_API_TOKEN`, injected into commands as environment variables.
- **No `.env` file is required, and none is kept on disk.** `.env` stays git-ignored as a safety net; `.env.example` documents the placeholder names only.
- `forge login` cannot store a session in this container (no libsecret keychain). Forge CLI authenticates straight from the two environment variables, which is the documented fallback — no login step is needed.
- **Never echo, print, `printenv`, `env`, or shell-expand `FORGE_API_TOKEN`** — not in commands, logs, docs, commit messages, or CI output. Reference it only as `"$FORGE_API_TOKEN"` inside a command that consumes it, and never print a variable-presence check that expands its value.

## Verification loop before any commit

1. Run `forge lint` once a Forge app is scaffolded in this repository; fix reported issues before committing.
2. Run `git status` and inspect staged files: confirm no `.env` file is staged.
3. Scan the diff for credentials (`git diff --cached`); zero secrets in tracked files is a hard requirement.
4. Confirm build artifacts (`node_modules/`, `dist/`, `build/`, `.forge/`) are ignored, not committed.

## Git protocol

- Stage with `git add .`.
- Commit with [Conventional Commits](https://www.conventionalcommits.org/) messages, e.g. `feat(app): add Jira issue panel`, `chore(setup): ...`, `fix(lint): ...`.
- Push to the remote repository after verification.
- Never leak `.env` files or tokens: they stay untracked, and no secret is ever committed.

## Project Architecture (SpecGuard MCP)

This repository builds **SpecGuard MCP**, an Atlassian Forge app that bridges AI coding agents with Jira acceptance criteria, Confluence ADRs, and Teamwork Graph context. The locked architecture lives in:

- [`docs/PRD.md`](docs/PRD.md) — product scope, target tracks, features, requirements, success metrics.
- [`docs/DESIGN.md`](docs/DESIGN.md) — UI Kit surfaces (`jira:issuePanel`, `confluence:contentBylineItem`, Rovo cards), states, accessibility, budgets.
- [`docs/TECH_STACK.md`](docs/TECH_STACK.md) — Forge modules, source layout, KVS data model, tool contracts, scopes, deployment.

### Target Forge modules

| Module | Purpose |
|---|---|
| `jira:issuePanel` | "SpecGuard Status" panel: alignment score, criteria, ADRs, dependency impact, audit log, sync |
| `confluence:contentBylineItem` | ADR byline: governed issue count + drift status |
| `rovo:agent` | Natural-language Q&A returning structured audit cards |
| `action` | Rovo-initiated verify/sync, same preview + idempotency rules as the panel. The `@forge/cli@15.1.0` manifest schema has no `rovo:action` module; the three tool extensions are declared under `action` and referenced by `rovo:agent.actions` and `rovo:mcp.tools`. |
| `rovo:mcp` | MCP server exposing `specguard_get_context`, `specguard_verify_implementation`, `specguard_sync_status` |

Read the relevant doc before changing a surface or a contract: tool input/output validation lives in `src/backend/actions.ts`, resolver payloads shared with the UI Kit surfaces live in `src/backend/viewTypes.ts`, and scoring weights are constants in `src/backend/scoringEngine.ts`. Do not silently change a module's contract without updating `docs/`.

### Registered app

- App name: **SpecGuard MCP** · Developer Space: `SpecGuard Dev` (`8ad35b79-5073-44ef-a433-3db240851018`).
- `app.id`: `ari:cloud:ecosystem::app/2dac9431-ae6d-461f-a35f-17b42a3b203e` (stored in `manifest.yml`; never replace it with a placeholder).
- Environments created on registration: `development`, `staging`, `production`.
- The `jira:issuePanel` icon is served from the `static-icons` resource (`static/icons/specguard.svg`).

### Required verification before every commit

Both of these must pass, in addition to the secret checks above:

1. `npx tsc --noEmit` — TypeScript strict type check.
2. `forge lint` — Forge platform and manifest rules.

Fix reported issues rather than suppressing them. The existing rules still apply unchanged: Node 24.x LTS, `@forge/cli@15.1.0`, Freebuff Project Secrets for `FORGE_EMAIL` / `FORGE_API_TOKEN`, and **never log, echo, print, or commit credentials**.
