# AGENTS.md — Atlassian Forge Development Rules

Rules for any agent or contributor working in this repository (Codegeist 2026 Hackathon).

## Platform

- Target: **Atlassian Forge** — apps are defined by `manifest.yml` and run on the Node.js runtime.
- Node.js 20+ is required (22.x / 24.x LTS recommended).
- Forge CLI is installed globally (`@forge/cli`); use `forge` for all platform operations.

## Authentication (non-interactive)

- Authenticate with the environment variables `FORGE_EMAIL` and `FORGE_API_TOKEN`. Never run interactive `forge login` in automation.
- Local values live in `.env` (untracked). `.env.example` holds placeholders only.
- **Never log, echo, print, or commit tokens.** Do not paste token values into code, docs, commit messages, or CI logs.

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
