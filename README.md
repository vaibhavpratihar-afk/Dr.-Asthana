# Auto Dev Agent (Dr. Asthana) v2

An autonomous AI developer agent that picks up JIRA tickets, debates implementation strategy using multiple AI agents, and submits draft PRs for human review.

## Architecture: Separate Thinking from Doing

The core insight: **expensive models think, cheap models do.**

1. **Debate** — Two AI agents (Agent A and Agent B) argue over implementation strategy across multiple rounds, using only read-only tools. Agent A proposes, Agent B critiques.
2. **Evaluate** — A quality gate judges the debate output and extracts a clean **cheatsheet** — a step-by-step implementation guide.
3. **Execute** — A deliberately dumb executor follows the cheatsheet exactly. No planning, no exploration, no decisions.

The **cheatsheet** is the most valuable artifact. It's persisted to disk so failed executions can retry without re-debating.

## Tech Stack

- **Runtime:** Node.js (ES modules, async/await throughout)
- **Package manager:** pnpm
- **AI:** Claude Code / Codex via AI Provider module (pluggable strategies)
- **Source control:** Azure DevOps (PRs via `az` CLI)
- **Ticketing:** JIRA REST API v3 + jira-cli.mjs (ADF comments, label management)
- **Notifications:** Slack (Block Kit DMs via `@slack/web-api`)

## Project Structure

```
src/
  index.js                → CLI entry point (daemon, single, dry-run, resume)
  ai-provider/            → Sole interface for spawning AI CLIs
    index.js              → runAI(), getProviderLabel(), checkProviderAvailable()
    provider.js           → Core spawn engine (process lifecycle, streaming, timeout)
    adapters/             → Claude Code and Codex CLI adapters
    strategies/           → single, fallback, parallel, race
  agent/                  → Deliberately dumb executor
    index.js              → execute(cheatsheet, cloneDir, config)
  infra/                  → MongoDB/Redis/Kafka lifecycle
  jira/                   → JIRA REST API, ticket parser, CLI transitions
  notification/           → Slack DMs, JIRA comment builders, report formatters
  pipeline/               → Orchestrator, checkpoint persistence, step definitions
  prompt/                 → Debate engine, evaluator, validator, context builders
  service/                → Git operations, Azure DevOps PR creation, base tagger
  utils/                  → Config loader, logger, summariser
agent-rules-with-tests.md → Rules injected into clone when tests enabled
agent-rules-no-tests.md   → Rules injected when tests handled externally
config.json               → Runtime configuration
```

## How It Works

1. Agent polls JIRA for tickets with the configured trigger label.
2. Fetches and parses ticket details (title, description, comments, affected systems, fix versions).
3. Validates required fields.
4. **Transitions ticket to In-Progress** and posts a JIRA comment with scope details.
5. For each affected service x target branch:
   a. Clones the repo and creates a feature branch.
   b. **Debate phase** — Agent A proposes implementation strategy, Agent B critiques (read-only tools). Runs 1-3 rounds.
   c. **Evaluate** — Quality gate extracts a cheatsheet from the debate.
   d. **Execute** — Cheap model follows the cheatsheet exactly.
   e. **Validate** — Checks git diff, file alignment, leftover debug logs.
   f. Commits, pushes, handles base image tagging, opens a PR on Azure DevOps.
6. **Transitions ticket to LEAD REVIEW** (if PRs were created).
7. Posts final JIRA comment with PR table, sends Slack DM, updates labels.

## AI Provider

All AI spawning goes through `src/ai-provider/`. Supports four strategies:

| Strategy | Behavior |
|----------|----------|
| `single` | One provider, return result (default) |
| `fallback` | Primary first, secondary on failure |
| `parallel` | Both simultaneously, pick best result |
| `race` | Both simultaneously, return first finisher |

Three modes with different tool permissions:

| Mode | Purpose | Tools | Default Model |
|------|---------|-------|---------------|
| `execute` | Write code | Read,Write,Edit,Bash,Glob,Grep | haiku |
| `debate` | Explore & argue | Read,Glob,Grep | sonnet |
| `evaluate` | Judge quality | Read,Glob,Grep | sonnet |

## Configuration

Edit `config.json` in the project root. See `config.example.json` for the full schema.

| Section | What it configures |
|---|---|
| `jira` | baseUrl, email, apiToken, trigger label, done label, custom field IDs |
| `azureDevOps` | org URL, project, SSH repo base URL |
| `services` | map of service name -> { repo, component, componentId, lead } |
| `slack` | botToken, userId for DM notifications |
| `agent` | pollInterval (300s), maxTicketsPerCycle (1), logDir, executionRetries |
| `aiProvider` | strategy, per-mode config (execute, debate, evaluate) |
| `infra` | enabled, scriptsDir, stopAfterProcessing |
| `tests` | enabled |

## Infrastructure (Optional)

The agent can optionally start/stop local infrastructure services (MongoDB, Redis, Kafka) before running tests. Disabled by default. Set `infra.enabled: true` and point `infra.scriptsDir` to a directory containing `run_services.sh` and `stop-services.sh`.

## Setup

```bash
pnpm install
cp config.example.json config.json  # then fill in your values
```

Ensure `az` CLI is authenticated for Azure DevOps and `claude` CLI is available on PATH.
For length-safe summaries, ensure `aisum` is installed on PATH.

## Running

```bash
# Continuous polling (daemon mode)
pnpm start

# Process a single ticket
pnpm run single -- JCP-123

# Dry run — show what would be processed without making changes
pnpm run dry-run

# Resume a failed run from a specific step
pnpm run resume -- JCP-123 --from-step=5
```
