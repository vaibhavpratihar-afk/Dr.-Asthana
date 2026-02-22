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
- `resume <KEY> --from-step=N` — resume a failed run from a specific step.

## Package Manager
This project uses **pnpm**. Do not use npm or yarn.

## Working Directory
- Repos are cloned into `.tmp/` within the project root (not the system temp directory).
- Implementation clones get a unique subdirectory under `.tmp/agent-*`.
- `.tmp/` is git-ignored and cleaned up automatically after each run.

## Directory Structure
```
src/
  index.js                → CLI entry point (daemon, single, dry-run, resume)
  ai-provider/
    index.js              → Public API: runAI(), getProviderLabel(), checkProviderAvailable()
    provider.js           → Core spawn engine (process lifecycle, streaming, timeout, heartbeat)
    adapters/
      claude.js           → Claude Code CLI adapter (args builder, stream-json parser)
      codex.js            → Codex CLI adapter (args builder, output parser)
    strategies/
      single.js           → Run one provider, return result
      fallback.js         → Run primary, if it fails run secondary
      parallel.js         → Run both simultaneously, pick best result
      race.js             → Run both, return whichever finishes first
  agent/
    index.js              → Deliberately dumb executor (static prompt + cheatsheet → runAI)
  infra/
    index.js              → Infrastructure lifecycle (start/stop MongoDB, Redis, Kafka)
  jira/
    index.js              → Public API re-exports
    client.js             → JIRA REST API (getTicketDetails, getTicketStatus)
    parser.js             → Ticket parsing, ADF text extraction, fix-version-to-branch mapping
    transitions.js        → JIRA CLI operations via jira-cli.mjs (transitions, comments, search, labels)
  notification/
    index.js              → Public API: postJiraStep, postFinalJiraReport, notifySlack*, uploadLogFile
    report.js             → Report builders (JIRA ADF comments, Slack Block Kit messages)
    slack.js              → Slack WebClient DM sender
  pipeline/
    index.js              → Pipeline orchestrator (runPipeline, resume)
    checkpoint.js         → Checkpoint persistence (.pipeline-state/<ticketKey>/)
    steps.js              → Step definitions (FETCH_TICKET through NOTIFY)
  prompt/
    index.js              → Orchestrates: ticket context → codebase context → debate → cheatsheet
    debate.js             → Debate engine (Agent A proposes, Agent B critiques, evaluator judges)
    evaluator.js          → Quality gate (structural checks + lightweight AI extraction)
    validator.js          → Post-execution validation (git diff, file alignment, debug log check)
    static.js             → Static system prompt for the executor
    ticket-context.js     → Builds ticket context markdown from parsed ticket data
    codebase-context.js   → Reads CLAUDE.md, file tree, package.json from clone
  service/
    index.js              → Public API re-exports
    git.js                → Clone, branch, commit, push, cleanup
    azure.js              → Azure DevOps PR creation via az CLI
    base-tagger.js        → Base image tag creation (auto-detected from Dockerfile)
  utils/
    index.js              → Public API re-exports
    config.js             → Config loader, validator, getRepoUrl(), getServiceConfig()
    logger.js             → Enhanced logger with file output, run/step tracking
    summariser.js         → aisum wrapper for length-safe summaries
agent-rules-with-tests.md  → Standing rules injected into clone's CLAUDE.md when tests enabled
agent-rules-no-tests.md    → Standing rules injected when tests handled externally
config.json                → Runtime configuration (JIRA, Azure DevOps, services, Slack, aiProvider)
```

## Core Architecture: Separate Thinking from Doing

The system uses a **debate-then-execute** paradigm:

1. **Debate** (expensive models): Two AI agents argue over implementation strategy across multiple rounds. Agent A proposes, Agent B critiques. Both use read-only tools only (Read, Glob, Grep).
2. **Evaluate**: A quality gate judges the debate output using structural checks + a lightweight AI call. Extracts a clean **cheatsheet** — a step-by-step implementation guide.
3. **Execute** (cheap model): A deliberately dumb executor follows the cheatsheet exactly. No planning, no exploration, no decisions.

The **cheatsheet** is the most valuable artifact. It's persisted to `.pipeline-state/<ticketKey>/cheatsheet.md` so failed executions can retry without re-debating.

## AI Provider Module
All AI CLI spawning goes through `src/ai-provider/`. No other module spawns `claude` or `codex` directly.

### Modes
| Mode | Purpose | Tools | Model | Called By |
|------|---------|-------|-------|----------|
| `execute` | Run cheatsheet — write code | Read,Write,Edit,Bash,Glob,Grep | Cheap (haiku) | Agent Module |
| `debate` | Explore codebase, argue strategy | Read,Glob,Grep (read-only) | Expensive (sonnet) | Prompt Module |
| `evaluate` | Judge debate output quality | Read,Glob,Grep | Expensive (sonnet) | Prompt Module |

### Strategies
- **single** (default): One provider, return result.
- **fallback**: Primary provider first, secondary on failure.
- **parallel**: Both providers simultaneously, pick best result.
- **race**: Both providers, return whichever finishes first.

## Processing Model
- One service, one branch at a time — fully sequential.
- Each branch gets a fresh clone, processes completely (Clone → Debate → Execute → Validate → Commit → Push → Base tag → PR → Cleanup), then the next branch starts.
- No shared git state between branches; each is fully isolated.
- Multi-version tickets: each fix version produces a separate branch and PR per service.

## Processing Pipeline
```
Step 1:   Fetch & parse ticket
Step 2:   Validate required fields
Step 2.5: Transition to In-Progress + JIRA comment
Steps 3-7: For each service × branch:
  Step 3: Clone repo, create feature branch
  Step 4: Build cheatsheet (ticket context → codebase context → debate → evaluate)
  Step 5: Execute cheatsheet (cheap model follows instructions)
  Step 6: Validate execution (git diff, file alignment)
  Step 7: Commit, push, base tag, create PR
Step 8:   Transition to LEAD REVIEW + final JIRA report + Slack DM + label updates
```

## Git Operations
- Feature branches: `feature/{ticketKey}-{sanitized-summary}` (single branch) or `feature/{ticketKey}-{sanitized-summary}-{version}` (multi-branch).
- Shallow clone (`--depth=50`) for implementation.
- CLAUDE.md/CODEX.md is always restored before committing — injected rules never reach the remote.
- Force push on branch conflict (previous run left a remote branch).

## Base Image Tagging
- Base tags are auto-detected from each repo's `Dockerfile` — no per-service config needed.
- Three conditions must be met: `Dockerfile` with a matching base-images registry FROM line, `Dockerfile.base`, and `azure-pipelines.yml` all present.
- Tag prefix is always `deploy.base`, format: `deploy.base.vMAJOR-MINOR-PATCH-BUILD`.
- Only triggered when `package.json` or `package-lock.json` change in the committed diff.

## JIRA CLI Operations (`jira/transitions.js`)
All JIRA write operations route through `jira-cli.mjs` via `jira/transitions.js`. Direct REST API calls in `jira/client.js` are read-only.

- **Transitions** (Dev Started, Dev Testing, EM Review): via `jira-cli.mjs transition`. API-first with automatic browser fallback.
- **Comments**: via `jira-cli.mjs comment add --file --auto-summarize`.
- **Search**: via `jira-cli.mjs search --jql --json`. Throws on failure.
- **Labels**: via `jira-cli.mjs label add/remove`. Non-blocking.
- **jira-cli.mjs**: Working directory defaults to `~/Desktop/skills/jira/scripts/`.

## Notifications
- **JIRA:** Structured ADF comment with PR table, summary, and failure panels.
- **Slack:** DM to configured user with all PR links and summary.
- **Run Log:** Uploaded to Pixelbin CDN via `uploadLogFile()`. URL included in JIRA/Slack.
- **Length limits:** Summarized via `utils/summariser.js` (`aisum` with presets). Hard truncation only as fallback.

## Azure DevOps PR Creation
- PRs created via `az repos pr create` with org/project from config.
- If a PR already exists (TF401179 error), falls back to finding and returning the existing PR.

## Configuration (`config.json`)
Key sections:
- `jira` — baseUrl, email, apiToken, label, labelProcessed, custom field IDs
- `azureDevOps` — org, project, repoBaseUrl (SSH)
- `services` — map of service name to { repo, component, componentId, lead }
- `slack` — botToken, userId
- `agent` — pollInterval (300s), maxTicketsPerCycle (1), logDir, executionRetries
- `aiProvider` — strategy, per-mode config (execute, debate, evaluate) with provider-specific settings
- `infra` — enabled, scriptsDir, stopAfterProcessing
- `tests` — enabled

## Logging
- Run-level logging: each ticket run gets a unique ID, logs to `logs/YYYY-MM-DD/{runId}.log`.
- Step tracking with durations (startStep/endStep).
- AI pass outputs saved to `logs/{ticketKey}-{label}-{provider}-{timestamp}.log`.
- Console output with ANSI colors; file output strips colors.

## Module Boundaries
Every module's `index.js` is the ONLY public interface. Internal files are private. Cross-module imports must go through `index.js`.

## Output Format
When done, summarize:
- FILES CHANGED: list of files
- SUMMARY: what was done (2-3 sentences)
- RISKS: what reviewer should check
