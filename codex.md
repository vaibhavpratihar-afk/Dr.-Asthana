# Codex Agent Context

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
  council/
    index.js              → Public API: createCouncil()
    council.js            → Round orchestrator (proposer → critics → agreement → evaluate)
    runner.js             → AI call wrapper with session memory across rounds
    evaluator.js          → Configurable quality gate (structural pre-checks + AI evaluation)
    workspace.js          → File-based observability, round artifacts, human-in-the-loop
    defaults.js           → Default agreement role, structural checks, approval/rejection keywords
  infra/
    index.js              → Infrastructure lifecycle (start/stop MongoDB, Redis, Kafka)
  jira/
    index.js              → Public API re-exports
    client.js             → JIRA REST API (getTicketDetails, getTicketStatus) — read-only
    parser.js             → Ticket parsing, ADF→markdown, fix-version-to-branch mapping
    transitions.js        → JIRA CLI operations via jira-cli.mjs (transitions, comments, search, labels)
    validator.js          → Pre-processing ticket validation (required fields, scope checks)
  notification/
    index.js              → Public API: postJiraStep, postFinalJiraReport, notifySlack*
    report.js             → Report builders (JIRA ADF comments, Slack Block Kit messages)
    slack.js              → Slack WebClient DM sender
  pipeline/
    index.js              → Pipeline orchestrator (runPipeline, resume)
    bundler.js            → Run artifact bundler (tar + upload to Pixelbin CDN)
    checkpoint.js         → Checkpoint persistence (.pipeline-state/<ticketKey>/)
    steps.js              → Step definitions (FETCH_TICKET through NOTIFY)
  prompt/
    index.js              → Orchestrates: ticket context → codebase context → council → cheatsheet
    council-prompts.js    → Prompt builders for council phases (proposer, critic, agreement)
    validator.js          → Post-execution validation (git diff, file alignment, debug log check)
    static.js             → Static system prompt for the executor agent
    ticket-context.js     → Builds ticket context markdown from parsed ticket data
    codebase-context.js   → Reads CLAUDE.md/CODEX.md/codex.md, file tree, package.json from clone
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
agent-rules-with-tests.md  → Standing rules injected into clone's instruction file when tests enabled
agent-rules-no-tests.md    → Standing rules injected when tests handled externally
config.json                → Runtime configuration (JIRA, Azure DevOps, services, Slack, aiProvider)
```

## Core Architecture: Council-then-Execute

The system separates **thinking** from **doing**: expensive models collaborate in a council to produce a plan, then a cheap model executes it.

### 1. Council (expensive models)
A group of AI agents collaborate via file-based discussions to produce an actionable output. A proposer explores the codebase and proposes a strategy, critic agents challenge and verify claims, then the proposer synthesizes critiques into a unified plan (AGREED/DISAGREE protocol). Runs 1-3 rounds until convergence. All discussions are persisted to disk for full visibility. Human feedback can be injected mid-council via a `human-feedback.md` file. Agents maintain session memory across rounds to avoid re-reading the codebase.

### 2. Evaluate (configurable quality gate)
Structural pre-checks (fast, no API calls: minimum length, file paths, action verbs) followed by an AI evaluator that judges the council output and extracts a clean artifact between configurable markers.

### 3. Execute (cheap model)
A deliberately dumb executor follows the extracted cheatsheet exactly. No planning, no exploration, no decisions.

The **cheatsheet** is the most valuable artifact. It's persisted to `.pipeline-state/<ticketKey>/cheatsheet.md` so failed executions can retry without re-running the council.

## Council Module (`src/council/`)
A reusable multi-agent deliberation engine — decoupled from any specific use case. The caller configures everything: goal, context, agent roles, prompt builders, evaluation criteria, and output format. The council handles: round orchestration, turn-taking, session continuity (memory), file-based discussions, human-in-the-loop, and failure recovery.

**Round flow:**
1. **Proposer** (agent-0): Proposes strategy (round 1) or revises based on critiques (round 2+)
2. **Critics** (agent-1..N): Each critiques the proposal, sees prior critics' outputs
3. **Agreement**: Proposer synthesizes all critiques → responds AGREED or DISAGREE
4. **Evaluate**: Structural pre-checks + AI quality gate → extract output or reject

**Workspace** (`.pipeline-state/<label>/council/`): All agent discussions are written as files. Status, round artifacts, and human feedback are all file-based for full transparency.

**Failure modes:** Critic fails → skip. Zero critics → use proposer directly. Proposer fails → break. Max rounds → force-evaluate.

## AI Provider Module (`src/ai-provider/`)
Single interface for all AI CLI spawning. No other module spawns `claude` or `codex` directly.

### Modes
| Mode | Purpose | Tools | Model | Used By |
|------|---------|-------|-------|---------|
| `execute` | Follow cheatsheet — write code | Read,Write,Edit,Bash,Glob,Grep | Cheap (haiku) | Agent |
| `debate` | Explore codebase, argue strategy | Read,Glob,Grep (read-only) | Expensive (sonnet) | Council |
| `evaluate` | Judge council output quality | Read,Glob,Grep | Expensive (sonnet) | Council Evaluator |

### Strategies
- **single** (default): One provider, return result.
- **fallback**: Primary first, secondary on failure.
- **parallel**: Both simultaneously, pick best result.
- **race**: Both simultaneously, return whichever finishes first.

## Processing Pipeline
```
Step 1:   FETCH_TICKET — fetch from JIRA REST API, parse ADF → markdown
Step 2:   VALIDATE_TICKET — required fields, scope checks, service config lookup
Step 2.5: Transition to In-Progress + JIRA comment with scope details
Steps 3-7: For each service × branch (fully sequential, isolated clones):
  Step 3: CLONE_REPO — shallow clone, create feature branch, inject agent rules
  Step 4: BUILD_CHEATSHEET — council deliberation → quality gate → extract cheatsheet
  Step 5: EXECUTE — cheap model follows cheatsheet (static prompt + guardrails)
  Step 6: VALIDATE_EXECUTION — git diff non-empty, files align, no debug logs
  Step 7: SHIP — commit, push (force if needed), base tag if applicable, create PR
Step 8:   NOTIFY — JIRA final report, Slack DM, log upload, label updates, transition
```

## Processing Model
- One service, one branch at a time — fully sequential.
- Each branch gets a fresh clone, processes completely (Clone → Council → Execute → Validate → Ship), then the next branch starts.
- No shared git state between branches; each is fully isolated.
- Multi-version tickets: each fix version produces a separate branch and PR per service.

## Git Operations
- Feature branches: `feature/{ticketKey}-{sanitized-summary}` (single branch) or `feature/{ticketKey}-{sanitized-summary}-{version}` (multi-branch).
- Shallow clone (`--depth=50`) for implementation.
- Instruction file (CLAUDE.md/CODEX.md/codex.md) is always restored before committing — injected rules never reach the remote.
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
- **Run Artifact:** At end of run, the entire `.pipeline-state/{ticketKey}/` directory is bundled into a `.tar.gz` and uploaded to Pixelbin CDN. The artifact URL is linked in JIRA comments and Slack DMs.
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
- AI pass outputs saved to `.pipeline-state/{ticketKey}/ai-calls/{label}.log`.
- Council round artifacts saved to `.pipeline-state/{ticketKey}/council/round-N/`.
- Console output with ANSI colors; file output strips colors.

## Artifacts

All run output is consolidated under `.pipeline-state/{ticketKey}/` — one directory per ticket run:

```
.pipeline-state/{ticketKey}/
├── run.log                          ← Main run log (copied from logs/ at end)
├── run.errors.log                   ← Error-only log (copied from logs/ at end)
├── ai-calls/                        ← Per-AI-call logs
│   ├── council-r1-agent-0.log
│   ├── council-r1-agent-1.log
│   ├── evaluator-0.log
│   └── execute-attempt-1.log
├── council/                         ← Council workspace: round artifacts, status, human feedback
│   ├── status.md
│   ├── round-1/
│   │   ├── agent-0-proposal.md
│   │   ├── agent-1-critique.md
│   │   ├── agreement.md
│   │   └── evaluation.md
│   └── human-feedback.md
├── cheatsheet.md                    ← Persisted cheatsheet (survives retries)
└── state.json                       ← Pipeline checkpoint for resume
```

At the end of a run (step 8), the directory is bundled into a `.tar.gz` and uploaded to Pixelbin CDN as a single artifact.

## Module Boundaries
Every module's `index.js` is the ONLY public interface. Internal files are private. Cross-module imports must go through `index.js`.

## Output Format
When done, summarize:
- FILES CHANGED: list of files
- SUMMARY: what was done (2-3 sentences)
- RISKS: what reviewer should check
