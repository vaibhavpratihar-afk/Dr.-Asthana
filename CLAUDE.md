# CLAUDE Agent Guide

This repository runs an autonomous JIRA-to-PR pipeline.

## Non-Negotiable Rules

1. Read before writing.
2. Keep diffs minimal and ticket-scoped.
3. Do not add placeholder code.
4. Prefer deterministic, auditable behavior.
5. Use `pnpm` (not npm/yarn).
6. Do not use destructive git commands.

## Architecture

No council. No debate rounds. Single-agent execution:

1. Fetch + validate ticket (`src/jira/`)
2. Clone repo, create feature branch (`src/service/git.js`)
3. Execute — Codex agent applies changes (`src/prompt/index.js`)
4. Diff review loop — adversarial reviewer flags issues, fix pass, repeat (`src/pipeline/diff-review.js`)
5. Commit + push (`src/service/git.js`)
6. Create PR on Azure DevOps (`src/service/azure.js`)
7. Notify JIRA + Slack (`src/notification/`)

## Module Map

| Path | Responsibility |
|---|---|
| `src/index.js` | CLI entry point (daemon, single, dry-run, resume) |
| `src/pipeline/index.js` | Step orchestrator |
| `src/pipeline/diff-review.js` | Adversarial review loop |
| `src/pipeline/checkpoint.js` | Per-ticket state persistence |
| `src/pipeline/bundler.js` | Artifact tar + Pixelbin upload |
| `src/prompt/index.js` | Builds executor prompt + calls Codex |
| `src/prompt/ticket-context.js` | Formats ticket data for prompt |
| `src/prompt/codebase-context.js` | Reads repo structure for prompt |
| `src/personas/index.js` | Loads persona `.md` files |
| `src/ai-provider/index.js` | Single `runAI()` entry point |
| `src/ai-provider/adapters/codex.js` | Codex arg builder + stream parser |
| `src/jira/client.js` | JIRA REST API (fetch ticket, delete comments) |
| `src/jira/transitions.js` | JIRA status transitions + label ops via jira-cli.mjs |
| `src/utils/config.js` | Config loader + service/repo helpers |
| `src/utils/logger.js` | Console + file logger with step tracking |

## Pipeline Steps

- Fetch ticket
- Validate ticket
- Clone repo + setup branch
- Execute (Codex)
- Diff review loop
- Commit + push
- Create PR
- Notify

## Output Expectations

- High signal, low noise.
- Explicit scope and risks.
- Reproducible artifact trail.
