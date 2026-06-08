# CLAUDE Agent Guide

This repository is a **thin Claude Code wrapper**. It finds JIRA tickets carrying a trigger label
and runs `claude -p` inside a fresh worktree of the cms-ai workspace to implement each ticket and
open a PR. It is driven entirely by an external scheduler (ghanta-ghar / cron) — there is no daemon.

## Non-Negotiable Rules

1. Read before writing.
2. Keep diffs minimal and ticket-scoped.
3. No placeholder code.
4. Prefer deterministic, auditable behavior.
5. Use `pnpm` (not npm/yarn) for this repo.
6. No destructive git commands.
7. Stay slim. The whole point of this rewrite was to delete code that Claude Code now does
   natively (spawn/stream parsing, persona injection, git clone, PR creation, logging). Do not
   reintroduce that scaffolding. If a feature can be a flag to `claude` or an instruction in
   `executor.prompt.md`, it does not belong in JS.

## Architecture

The wrapper only does what Claude can't bootstrap: find the tickets and report the result.
Everything else (read ticket, route scope, clone service repos, implement, commit, push, open PR)
is done by the spawned `claude -p` run using cms-ai's own instruction files and the ambient
`gh` / `az` auth.

| Path | Responsibility |
|---|---|
| `src/index.js` | CLI entry — search labeled tickets, process each, notify, exit |
| `src/config.js` | Load + validate `config.json` |
| `src/jira.js` | REST search by label, fetch ticket (ADF → text), minimal validation |
| `src/agent.js` | Fresh cms-ai worktree → spawn `claude -p --output-format json` → parse result → cleanup |
| `src/notify.js` | Slack DM (optional) or stdout |
| `executor.prompt.md` | System prompt: KB-vs-service routing, ship instructions, bailout, output markers |

## How a ticket is processed

1. `jira.searchByLabel` — open tickets with the trigger label (highest priority first).
2. `jira.getTicket` + `jira.validate` — fetch detail; skip (with a Slack note) if no summary, or no
   description and no comments.
3. `agent.runTicket` — `git worktree add` a clean checkout of cms-ai on a new feature branch, spawn
   `claude -p` there with `executor.prompt.md` appended as the system prompt, parse the JSON result
   for a `**PR URL:**` or `**BAILOUT:**` marker, then remove the worktree.
4. `notify` — report shipped / bailout / rejected / failed.

## Output Markers (contract between executor.prompt.md and agent.js)

The executor prompt must emit these; `agent.js` parses them:

- `**PR URL:** <url>` — success
- `**BAILOUT:** ...` / `**SUGGESTION:** ...` — needs a human
- `**SUMMARY:** ...` — short description (optional, surfaced in the notification)

If you change a marker in one file, change it in the other.
