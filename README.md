# Auto Dev Agent (Dr. Asthana)

An autonomous AI developer agent that picks up JIRA tickets, implements changes, and submits draft PRs for human review.

## Tech Stack

- **Runtime:** Node.js (ES modules, async/await throughout)
- **Target services:** Node.js + Express, MongoDB with Mongoose, Redis (two-layer caching with pub/sub invalidation), microservices on Kubernetes
- **AI:** Claude in headless mode (three-pass: plan, implement, validate)
- **Source control:** Azure DevOps (PRs via `az` CLI)
- **Ticketing:** JIRA REST API v3 (ADF comments, label management)
- **Notifications:** Slack (Block Kit DMs)

## Project Structure

```
src/
  index.js              — CLI entry point (daemon, single, dry-run)
  config.js             — config loader, validator, getRepoUrl(), getServiceConfig()
  logger.js             — enhanced logger with file output, run/step tracking, API/CMD logging
  agent/
    processor.js        — main orchestration (loops services x branches, coordinates pipeline steps)
    retrigger.js        — re-trigger detection + lightweight Claude analysis for version filtering
    ticket.js           — ticket parsing, ADF text extraction, fix-version-to-branch mapping
  services/
    ai-provider.js      — provider dispatcher (`claude`)
    claude.js           — three-pass execution engine (plan -> implement -> validate), stream-json parsing, rate-limit handling
    prompt-builder.js   — ticket context prompt only (key, title, description, comments)
    git.js              — clone, branch, commit, push, cleanup; restores CLAUDE.md before committing
    base-tagger.js      — base image tag creation (auto-detected from Dockerfile)
    test-runner.js      — test detection (CLAUDE.md / package.json), execution, shouldRunTests change analysis
    notifications.js    — Slack DMs, JIRA ADF comments (PR table, In-Progress, LEAD REVIEW), PR description builders
    jira.js             — JIRA REST API (fetch tickets, get details, comment, add/remove labels, transitions)
    jira-transitions.js — JIRA status transitions via Claude Code headless subprocess (In-Progress, Dev Testing → EM Review)
    azure.js            — Azure DevOps PR creation via az CLI, existing PR detection (TF401179 fallback)
    infra.js            — infrastructure lifecycle (start/stop MongoDB, Redis, Kafka via local scripts)
agent-rules-with-tests.md  — standing rules injected into clone's CLAUDE.md when Claude runs tests
agent-rules-no-tests.md    — standing rules injected when tests are handled externally
config.json                — runtime configuration (JIRA, Azure DevOps, services, Slack, agent, provider, claude, infra)
.tmp/                      — local temporary directory for repo clones (git-ignored)
logs/                      — run logs, error logs, Claude pass outputs, and test output files
```

## How It Works

1. Agent polls JIRA for tickets with the `patient-dr-asthana` label.
2. Fetches and parses ticket details (title, description, comments, affected systems, fix versions).
3. Validates required fields (affected systems, fix versions, known services).
4. **Transitions ticket to In-Progress** — spawns a Claude Code subprocess against `~/Desktop/jira-creator/` to call the JIRA REST API. Posts a detailed ADF comment showing services, branches, and ticket context.
5. Checks for re-triggers — if done labels exist, analyzes comments with a lightweight Claude call to determine which versions need rework.
6. For each affected service x target branch:
   a. Clones the repo into `.tmp/` and creates a feature branch.
   b. Injects agent standing rules into the clone's CLAUDE.md.
   c. **Plan pass** — selected provider explores the codebase and produces an implementation plan (~20 turns).
   d. **Implement pass** — selected provider executes the plan (up to 250 turns). Falls back to ticket context if planning failed.
   e. **Validate pass** — only runs if implementation didn't complete normally. Reviews state, fixes issues (~30 turns).
   f. Checks if source code changed — skips tests for dependency-only/docs/config changes.
   g. If tests needed, starts infrastructure lazily (MongoDB, Redis, Kafka) on first use.
   h. Commits and pushes. Provider instruction file changes (CLAUDE.md) are always restored (never pushed).
   i. Handles base image tagging if dependencies changed (auto-detected from Dockerfile).
   j. Opens a PR on Azure DevOps (detects and reuses existing PRs).
   k. Cleans up the clone directory.
7. **Transitions ticket to LEAD REVIEW** (only if PRs were created) — two-step transition via Claude subprocess: Dev Testing (browser-based) then EM Review (API). Posts an ADF comment with Claude's plan, files changed, summary, and PR table.
8. Posts a structured ADF comment on JIRA with a PR table and summary.
9. Sends a Slack DM with all PR links.
10. Removes the trigger label, adds versioned done labels.

## Configuration

Edit `config.json` in the project root. Key sections:

| Section | What it configures |
|---|---|
| `jira` | baseUrl, email, apiToken, trigger label, done label, custom field IDs |
| `azureDevOps` | org URL, project, SSH repo base URL |
| `services` | map of service name -> { repo, component, componentId, lead } |
| `slack` | botToken, userId for DM notifications |
| `agent` | pollInterval (300s), maxTicketsPerCycle (1), logDir |
| `provider` | top-level AI provider switch: `claude` |
| `claude` | Claude provider settings: maxTurns (250), planTurns (20), validationTurns (30), timeoutMinutes (30), runTests (true) |
| `infra` | enabled, scriptsDir, stopAfterProcessing |

## Setup

```bash
npm install
```

Ensure `az` CLI is authenticated for Azure DevOps and `claude` CLI is available on PATH.

## Running

```bash
# Continuous polling (daemon mode)
npm start

# Process a single ticket
npm run single -- JCP-123

# Dry run — show what would be processed without making changes
npm run dry-run
```
