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
