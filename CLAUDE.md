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
7. All changes must be submitted via PR. Always create feature branches from `main`.

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
- Implementation clones get a unique subdirectory under `.tmp/agent-*`.
- Planning clones (master plan for multi-branch) get `.tmp/plan-*` subdirectories.
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
    prompt-builder.js   — ticket context prompt + multi-branch master planning prompt
    summariser.js       — shared `aisum` wrapper for detail-preserving, length-safe summaries (JIRA/Slack/PR)
    git.js              — clone, branch, commit, push, cleanup, planning clone; restores CLAUDE.md before committing
    base-tagger.js      — base image tag creation (auto-detected from Dockerfile)
    test-runner.js      — test detection (CLAUDE.md / package.json), execution, shouldRunTests change analysis
    notifications.js    — Slack DMs, JIRA comment builders (PR table, In-Progress, LEAD REVIEW), PR description builders, run log upload
    jira.js             — JIRA REST API (get ticket details, get status, legacy transitions)
    jira-transitions.js — JIRA CLI operations via jira-cli.mjs (transitions, comments, search, labels)
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
- **Multi-branch master planning:** For tickets with 2+ target branches, a single master plan pass runs before the branch loop. The plan clone fetches all branches as remote refs, Claude produces per-branch plan sections (with `### BRANCH:` headers), and each branch's implementation pass receives its section as an external plan (skipping per-branch plan pass). If the master plan fails at any point, affected branches gracefully fall back to per-branch planning.

## Processing Pipeline
```
Step 1:   Fetch & parse ticket
Step 2:   Validate required fields
Step 2.5: Transition to In-Progress (Dev Started) + detailed JIRA comment (services, branches, ticket context)
Step 3:   Check re-trigger (done labels + comment analysis)
Steps 4-8: For each service:
            [Master Plan (multi-branch only): cloneForPlanning → spawnClaude → parseMultiBranchPlan → cleanup]
            For each branch:
              Clone → Inject Rules → [Infra] → Claude (Plan or External Plan → Implement → [Validate]) → Test → Commit → Push → Base tag → PR → Cleanup
Step 8.5: Transition to LEAD REVIEW + plan/files/summary JIRA comment (only if PRs exist)
Step 9:   Upload run log → PR notification comment + Slack DM + label updates
```

## Three-Pass Claude Invocation
- **Pass 1 (Plan):** Explores the codebase and produces an implementation plan without making changes. Configured via `claude.planTurns` (default 40) and `claude.planTimeoutMinutes` (default 30). Plan is validated for quality — rejected if too short (<200 chars) or generic. When an `externalPlan` is provided (from multi-branch master planning), the plan pass is skipped entirely and the external plan text is used directly.
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
- Shallow clone (`--depth=50`) for implementation, `--depth=100` for planning clones.
- Planning clones (`cloneForPlanning`): shallow clone of primary branch, remaining branches fetched as remote refs. Used for multi-branch master planning. Temp dirs use `plan-` prefix. Non-fatal if individual branch fetch fails.
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

## JIRA CLI Operations (`jira-transitions.js`)
All JIRA write and query operations are routed through `jira-cli.mjs` via `jira-transitions.js`. The only direct REST API calls remaining in `jira.js` are read-only (`getTicketDetails`, `getTicketStatus`) and the legacy `transitionTicket`.

- **Transitions** (Dev Started, Dev Testing, EM Review): via `jira-cli.mjs transition`. API-first with automatic browser fallback for hasScreen transitions. 2-minute timeout.
- **Comments**: via `jira-cli.mjs comment add --file`. Markdown written to temp file, posted, temp file cleaned up. Non-blocking.
- **Search** (`searchTickets`): via `jira-cli.mjs search --jql --json`. Used by daemon and dry-run modes. **Throws on failure** (callers depend on error propagation). 30s timeout.
- **Labels** (`addLabel`, `removeLabel`): via `jira-cli.mjs label add/remove`. Non-blocking (never throw). Used for trigger label removal and versioned done-label management.
- **In-Progress** (Step 2.5): Triggered immediately after ticket validation, before any code work begins. Posts a rich ADF comment showing the ticket context (summary, description), a table of services/repos/branches being targeted, and scope.
- **LEAD REVIEW** (Step 8.5): Triggered after all services are processed and PRs exist. Two-step transition:
  1. Dev Testing — via `node jira-cli.mjs transition <key> "Dev Testing"` (API-first, browser fallback for validators/attachments)
  2. EM Review — via `node jira-cli.mjs transition <key> "EM Review"` (after 3-second pause for JIRA to process)
  Posts an ADF comment with Claude's implementation plan, files changed, summary, and PR table.
- **Non-blocking**: All transition and label calls are wrapped in try/catch. Failures log `warn()` and never block the pipeline.
- **jira-cli.mjs**: Working directory defaults to `~/Desktop/jira-creator/`, configurable via `JIRA_CREATOR_DIR` env var.

## Notifications
- **JIRA:** Structured ADF comment with a table of PRs (service, branch, PR link), Claude's summary, and any failures in a warning panel. Trigger label is removed, versioned done labels are added.
- **Slack:** DM to configured user with all PR links, ticket link, summary, and failure warnings.
- **Failure:** Both JIRA comment and Slack DM on error, with error message.
- **Run Log:** After each run, the log file is uploaded to Pixelbin CDN via `uploadLogFile()`. The CDN URL is included in JIRA comments and Slack DMs (success, failure, and no-PRs paths). Upload failures are non-blocking.
- **Length limits:** User-facing long text is summarized via `services/summariser.js` (`aisum`) instead of direct substring truncation. Hard truncation is only used as a fallback when summarisation is unavailable.

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
- `getRunLogPath()` returns the current log file path (must be called before `finalizeRun()` resets it).
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
