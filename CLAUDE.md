# Agent Context

You are an AI developer agent working autonomously on JIRA tickets.
Your changes will be submitted as draft PRs for human review.

## Rules
1. Read before writing. Explore relevant files and understand patterns first.
2. Minimal diff. Only change what the ticket requires.
3. Follow existing conventions. Match code style, naming, patterns.
4. Handle errors properly. This is a high-throughput production system.
5. No placeholders or TODOs. Every line must be production-ready.
6. Run lint/test if available. Note failures but don't block on infra issues.

## Tech Stack
- Node.js + Express backend
- MongoDB with Mongoose
- Redis caching (two-layer: in-memory + Redis with pub/sub invalidation)
- Microservices on Kubernetes
- Async/await throughout

## CLI Modes
The bot is invoked via `node src/index.js <command>`:
- `daemon` — continuous poll loop, checks JIRA every `agent.pollInterval` seconds (default 300s), processes up to `agent.maxTicketsPerCycle` tickets per cycle.
- `single <KEY>` — process one specific JIRA ticket by key (e.g., `single JCP-123`).
- `dry-run` — poll once, display parsed ticket details, make no changes.

## Working Directory
- Repos are cloned into `.tmp/` within the project root (not the system temp directory).
- Each clone gets a unique subdirectory under `.tmp/agent-*`.
- `.tmp/` is git-ignored and cleaned up automatically after each run.

## Directory Structure
```
src/
  index.js              — CLI entry point (daemon, single, dry-run)
  config.js             — config loader, validator, getRepoUrl(), getServiceConfig()
  logger.js             — enhanced logger with file output, run/step tracking, API/CMD logging
  agent/
    processor.js        — main orchestration (loops services x branches, coordinates pipeline steps, injects agent rules)
    retrigger.js        — re-trigger detection + lightweight Claude analysis for version filtering
    ticket.js           — ticket parsing, ADF text extraction, fix-version-to-branch mapping
  services/
    claude.js           — three-pass Claude invocation (plan -> implement -> validate), stream-json parsing, rate-limit handling
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
config.json                — runtime configuration (JIRA, Azure DevOps, services, Slack, agent, claude, infra)
```

## Processing Model
- One service, one branch at a time — fully sequential.
- Each branch gets a fresh clone, processes completely (Clone -> Inject Rules -> Plan -> Implement -> [Validate] -> Test -> Commit -> Push -> Base tag -> PR -> Cleanup), then the next branch starts.
- No shared git state between branches; each is fully isolated.
- Multi-version tickets: each fix version produces a separate branch and PR per service.

## Processing Pipeline
```
Step 1:   Fetch & parse ticket
Step 2:   Validate required fields
Step 2.5: Transition to In-Progress + detailed JIRA comment (services, branches, ticket context)
Step 3:   Check re-trigger (done labels + comment analysis)
Steps 4-8: For each service/branch:
            Clone → Inject Rules → [Infra] → Claude (Plan → Implement → [Validate]) → Test → Commit → Push → Base tag → PR → Cleanup
Step 8.5: Transition to LEAD REVIEW + plan/files/summary JIRA comment (only if PRs exist)
Step 9:   PR notification comment + Slack DM + label updates
```

## Three-Pass Claude Invocation
- **Pass 1 (Plan):** Explores the codebase and produces an implementation plan without making changes. Configured via `claude.planTurns` (default 20) and `claude.planTimeoutMinutes` (default 10). Plan is validated for quality — rejected if too short (<200 chars) or generic.
- **Pass 2 (Implement):** Executes the plan (or falls back to ticket context if planning failed). Uses `claude.maxTurns` (default 250) and `claude.timeoutMinutes` (default 30).
- **Pass 3 (Validate):** Runs only if implementation didn't complete normally or hit max turns. Reviews current state, fixes issues, runs tests. Uses `claude.validationTurns` (default 30), 15-minute timeout.
- All passes use `--dangerously-skip-permissions` and `--output-format stream-json`.
- Standing rules are injected into the clone's CLAUDE.md (not into the prompt), so Claude Code discovers them natively.
- **Rate limit handling:** Each pass checks for rate limits. Plan rate limit aborts the entire run (no code changes made). Implement rate limit skips validation and returns best available output. Validate rate limit returns best output from any pass.
- **Output selection:** `pickBestOutput` prefers structured output (contains FILES CHANGED/SUMMARY/RISKS), falls back to first non-garbage response, skips rate-limit errors and suspiciously short responses.

## Re-trigger Detection
- Detects when a ticket has been re-triggered by checking for existing done labels (versioned or bare) matching the configured `labelProcessed` value.
- Uses a lightweight Claude call (1 turn, no tools, 60s timeout) to analyze JIRA comments and determine which versions need rework.
- Falls back to processing all versions if analysis fails or returns empty.
- New versions (no done label) are always included regardless of analysis result.

## Git Operations
- Feature branches: `feature/{ticketKey}-{sanitized-summary}` (single branch) or `feature/{ticketKey}-{sanitized-summary}-{version}` (multi-branch).
- Shallow clone (`--depth=50`) for speed.
- CLAUDE.md is always restored before committing — if the service has its own tracked CLAUDE.md, it's reset to HEAD; if copied from the bot's default, it's unstaged. Injected agent rules never reach the remote.
- Force push on branch conflict (previous run left a remote branch).

## Base Image Tagging
- Base tags are auto-detected from each repo's `Dockerfile` — no per-service config needed.
- Three conditions must be met: `Dockerfile` with a matching base-images registry FROM line, `Dockerfile.base`, and `azure-pipelines.yml` all present.
- Tag prefix is always `deploy.base`, format: `deploy.base.vMAJOR-MINOR-PATCH-BUILD`.
- Only triggered when `package.json` or `package-lock.json` change in the committed diff.
- 2.x version branches use upstream Node.js images (no base image pipeline), so base tagging is automatically skipped.

## Test Execution
- Tests only run when source code (`.js`, `.ts`, etc.) changes. Dependency-only updates (`package.json`, `package-lock.json`), docs, config, and Docker/CI file changes skip tests.
- Infrastructure (MongoDB, Redis, Kafka) is started lazily — only on the first branch that actually needs tests. If no branch needs tests, infra is never started.
- When `claude.runTests` is true, infra starts before the first Claude run so Claude can run tests internally. External test step is skipped if Claude completed normally.
- When CLAUDE.md provides both a shell script and bare `npm test`, only the shell script runs (it wraps `npm test` internally).
- On test failure, full stdout+stderr is saved to `logs/test-<name>-<timestamp>.log` for post-mortem debugging. The run log shows the last 30 lines of stdout (where test frameworks print failure summaries).

## JIRA Status Transitions
- **In-Progress** (Step 2.5): Triggered immediately after ticket validation, before any code work begins. Uses the JIRA REST API directly. Posts a rich ADF comment showing the ticket context (summary, description), a table of services/repos/branches being targeted, and scope.
- **LEAD REVIEW** (Step 8.5): Triggered after all services are processed and PRs exist. Two-step transition via Claude subprocess:
  1. Dev Testing — browser-based via `node jira-transition.mjs <key> "Dev Testing"` (handles screen/validator requirements)
  2. EM Review — REST API with transition ID 331 (after 3-second pause for JIRA to process)
  Posts an ADF comment with Claude's implementation plan, files changed, summary, and PR table.
- **Non-blocking**: All transition calls are wrapped in try/catch. Failures log `warn()` and never block the pipeline. JIRA comments are only posted on successful transitions.
- **Claude subprocess**: Spawned with `--max-turns 3 --output-format text --dangerously-skip-permissions`, 2-minute timeout per transition. Working directory is configurable via `JIRA_CREATOR_DIR` env var (contains transition workflow scripts and credentials).

## Notifications
- **JIRA:** Structured ADF comment with a table of PRs (service, branch, PR link), Claude's summary, and any failures in a warning panel. Trigger label is removed, versioned done labels are added.
- **Slack:** DM to configured user with all PR links, ticket link, summary, and failure warnings.
- **Failure:** Both JIRA comment and Slack DM on error, with error message.

## Azure DevOps PR Creation
- PRs created via `az repos pr create` with org/project from config.
- If a PR already exists for the source branch (TF401179 error), falls back to finding and returning the existing active PR via `az repos pr list`.
- PR description includes Claude's summary and test results.

## Configuration (`config.json`)
Key sections:
- `jira` — baseUrl, email, apiToken, label, labelProcessed, custom field IDs
- `azureDevOps` — org, project, repoBaseUrl (SSH)
- `services` — map of service name to { repo, component, componentId, lead }
- `slack` — botToken, userId
- `agent` — pollInterval (300s), maxTicketsPerCycle (1), logDir
- `claude` — maxTurns (250), planTurns (20), validationTurns (30), timeoutMinutes (30), planTimeoutMinutes (10), runTests (true), allowedTools
- `infra` — enabled, scriptsDir, stopAfterProcessing

## Logging
- Run-level logging: each ticket run gets a unique ID (`YYYY-MM-DD_HH-MM-SS_TICKETKEY`), logs to `logs/YYYY-MM-DD/{runId}.log` and `{runId}.errors.log`.
- Step tracking with durations (startStep/endStep).
- Specialized log methods: `logApi` (HTTP requests), `logCmd` (shell commands), `logData` (structured data dumps).
- Console output with ANSI colors; file output strips colors.
- Claude pass outputs saved to `logs/{ticketKey}-{pass}-{timestamp}.log`.

## Reference Service Repos
If you have local copies of service repos, you can use them for read-only verification. Use `git show <branch>:<path>` to inspect files on any branch without switching — **never clone into or modify reference directories**.

## Output Format
When done, summarize:
- FILES CHANGED: list of files
- SUMMARY: what was done (2-3 sentences)
- RISKS: what reviewer should check
