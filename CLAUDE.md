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

Single-agent execution — the spawned CLI agent (claude or codex) does everything:

1. Fetch + validate ticket (`src/jira/`)
2. Clone repo, create feature branch (`src/service/git.js`)
3. Spawn agent with ticket context + ship instructions (`src/prompt/index.js`)
4. Agent implements changes, commits, pushes, creates PR on Azure DevOps
5. Parse PR URL from agent output, notify Slack (`src/notification/`)

## Module Map

| Path | Responsibility |
|---|---|
| `src/index.js` | CLI entry point (daemon, single, dry-run) |
| `src/pipeline/index.js` | Phase orchestrator |
| `src/pipeline/phases/ticket.js` | Fetch + validate ticket |
| `src/pipeline/phases/service.js` | Clone → execute step machine |
| `src/pipeline/phases/service-steps.js` | Clone, pnpm check, execute steps |
| `src/pipeline/phases/notify.js` | Artifact bundle + Slack notification |
| `src/pipeline/core/bundler.js` | Artifact tar + Pixelbin upload |
| `src/pipeline/core/checkpoint.js` | Artifact directory path helper |
| `src/pipeline/core/support.js` | Shared pipeline utilities |
| `src/prompt/index.js` | Builds executor prompt + ship instructions |
| `src/prompt/ticket-context.js` | Formats ticket data for prompt |
| `src/personas/index.js` | Loads persona `.md` files |
| `src/personas/executor.prompt.md` | Agent task + shipping instructions |
| `src/ai-provider/index.js` | Single `runAI()` entry point |
| `src/ai-provider/adapters/cli-json.js` | Arg builder + stream parser (claude & codex) |
| `src/ai-provider/provider/spawn-runtime.js` | Process spawn + stream handling |
| `src/ai-provider/provider/event-parser.js` | JSON event → log summary |
| `src/ai-provider/provider/log-writer.js` | Writes prompt + log files to artifact dir |
| `src/jira/client.js` | JIRA REST API (search, fetch ticket) |
| `src/jira/parser.js` | Parses raw JIRA response into ticket object |
| `src/jira/validator.js` | Validates required ticket fields |
| `src/service/git.js` | Clone repo, create branch, cleanup |
| `src/notification/index.js` | Slack success + failure notifications |
| `src/notification/slack.js` | Slack Web API transport |
| `src/notification/report.js` | Slack Block Kit message builders |
| `src/utils/config.js` | Config loader + service/repo helpers |
| `src/utils/logger.js` | Console + file logger with step tracking |

## Ticket Validation Rules

A ticket is rejected (with Slack notification) if any of these fail:

- **Single affected system** — `affectedSystems.length === 1`
- **Single fix version** — `targetBranches.length === 1` and `targetBranch` exists
- **pnpm project** — `pnpm-lock.yaml` present in repo root after clone

## Pipeline Steps

1. Fetch ticket
2. Validate ticket (rejects with Slack if rules above fail)
3. Clone repo + create feature branch + verify pnpm-lock.yaml (rejects with Slack if missing)
4. Execute (agent implements + commits + pushes + creates PR)
5. Notify (artifact bundle + Slack success)

## Output Expectations

- High signal, low noise.
- Explicit scope and risks.
- Reproducible artifact trail.
