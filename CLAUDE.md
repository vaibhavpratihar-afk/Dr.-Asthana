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
    index.js              → Public API: postJiraStep, postFinalJiraReport, notifySlack*, uploadLogFile
    report.js             → Report builders (JIRA ADF comments, Slack Block Kit messages)
    slack.js              → Slack WebClient DM sender
  pipeline/
    index.js              → Pipeline orchestrator (runPipeline, resume)
    checkpoint.js         → Checkpoint persistence (.pipeline-state/<ticketKey>/)
    steps.js              → Step definitions (FETCH_TICKET through NOTIFY)
  prompt/
    index.js              → Orchestrates: ticket context → codebase context → council → cheatsheet
    council-prompts.js    → Prompt builders for council phases (proposer, critic, agreement)
    validator.js          → Post-execution validation (git diff, file alignment, debug log check)
    static.js             → Static system prompt for the executor agent
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

## Core Architecture: Council-then-Execute

The system separates **thinking** from **doing**: expensive models collaborate in a council to produce a plan, then a cheap model executes it.

### 1. Council (expensive models)
A group of AI agents collaborate via file-based discussions to produce an actionable output. A proposer explores the codebase and proposes a strategy, critic agents challenge and verify claims, then the proposer synthesizes critiques into a unified plan (AGREED/DISAGREE protocol). Runs 1-3 rounds until convergence. All discussions are persisted to disk for full visibility. Human feedback can be injected mid-council via a `human-feedback.md` file. Agents maintain session memory across rounds to avoid re-reading the codebase.

### 2. Evaluate (configurable quality gate)
Structural pre-checks (fast, no API calls: minimum length, file paths, action verbs) followed by an AI evaluator that judges the council output and extracts a clean artifact between configurable markers. Approval/rejection keywords and extraction markers are defined by the caller.

### 3. Execute (cheap model)
A deliberately dumb executor follows the extracted cheatsheet exactly. No planning, no exploration, no decisions. Gets a static system prompt with strict guardrails (no git, no docker, no deploy).

The **cheatsheet** is the most valuable artifact. It's persisted to `.pipeline-state/<ticketKey>/cheatsheet.md` so failed executions can retry without re-running the council.

## Council Module (`src/council/`)
A reusable multi-agent deliberation engine — decoupled from any specific use case. The caller configures everything: goal, context, agent roles, prompt builders, evaluation criteria, and output format. The council handles: round orchestration, turn-taking, session continuity (memory), file-based discussions, human-in-the-loop, and failure recovery.

**API:**
```js
import { createCouncil } from '../council/index.js';

const council = createCouncil({
  goal: 'What the council should achieve',
  context: 'All information the agents need',
  workingDir: '/path/to/repo',
  roles: { proposer: '...', critic: '...', agreement: '...(optional)' },
  prompts: {
    buildProposer: (round, baseContext, proposerOutput, criticOutputs, role, feedback) => string,
    buildCritic: (round, baseContext, proposerOutput, criticOutputs, criticIndex, role) => string,
    buildAgreement: (baseContext, proposerOutput, criticOutputs, agreementRole) => string,
  },
  evaluation: {
    structural: (output) => ({ passed, feedback }),     // optional, default checks length/files/verbs
    buildAiPrompt: (output, context, force) => string,  // required
    outputMarkers: { start: '=== START ===', end: '=== END ===' },  // required
    approvalKeyword: 'APPROVED',    // optional
    rejectionKeyword: 'REJECTED',   // optional
    forceOnLastRound: true,         // optional
  },
  config,
  label: 'identifier-for-logs',
  checkpointDir: '/path/to/workspace',
  feedback: 'prior feedback from failed run',  // optional
});

const result = await council.run();
// { passed: boolean, output: string|null, feedback: string|null, rounds: number }
```

**Round flow:**
1. **Proposer** (agent-0): Proposes strategy (round 1) or revises based on critiques (round 2+)
2. **Critics** (agent-1..N): Each critiques the proposal, sees prior critics' outputs
3. **Agreement**: Proposer synthesizes all critiques → responds AGREED or DISAGREE
4. **Evaluate**: Structural pre-checks + AI quality gate → extract output or reject

**Workspace layout** (`.pipeline-state/<label>/council/`):
```
council/
├── status.md                    ← Live status: current round, phase, timestamps
├── round-1/
│   ├── agent-0-proposal.md      ← Proposer's output
│   ├── agent-1-critique.md      ← Critic's output
│   ├── agreement.md             ← AGREED/DISAGREE + synthesis
│   └── evaluation.md            ← Pass/fail + feedback
├── round-2/
│   └── ...
└── human-feedback.md            ← Drop this file to steer mid-council
```

**Failure modes:**
- Critic fails or rate-limited → skip that critic, continue with rest
- Zero critics succeed → use proposer output directly for evaluation
- Proposer fails → break loop
- Max rounds exhausted → force-evaluate last output as best-effort

## Prompt Module (`src/prompt/`)
Owns all prompt construction across the pipeline. For the council, it provides ticket-specific configuration: proposer/critic role instructions, the AI evaluator prompt, and cheatsheet extraction markers. For the executor, it provides the static system prompt with guardrails.

**Key responsibilities:**
- `buildCheatsheet()` — builds ticket + codebase context, configures a council with ticket-specific roles and evaluation, runs it, returns the cheatsheet
- `council-prompts.js` — prompt builders passed into `createCouncil()` (proposer, critic, agreement phase prompts)
- `ticket-context.js` — converts parsed ticket data into markdown context
- `codebase-context.js` — reads CLAUDE.md/CODEX.md, file tree, package.json from clone
- `static.js` — executor rules (follow cheatsheet exactly, no git/docker/deploy)
- `validator.js` — post-execution checks (git diff non-empty, changed files align with cheatsheet, no leftover debug logs)

## AI Provider Module (`src/ai-provider/`)
Single interface for all AI CLI spawning. No other module spawns `claude` or `codex` directly. Handles process lifecycle, streaming JSON parsing, timeout, heartbeat monitoring, and log capture.

### Modes
| Mode | Purpose | Tools | Model | Used By |
|------|---------|-------|-------|---------|
| `execute` | Follow cheatsheet — write code | Read,Write,Edit,Bash,Glob,Grep | Cheap (haiku) | Agent |
| `debate` | Explore codebase, argue strategy | Read,Glob,Grep (read-only) | Expensive (sonnet) | Council |
| `evaluate` | Judge council output quality | Read,Glob,Grep | Expensive (sonnet) | Council Evaluator |

### Strategies
- **single** (default): One provider, return result.
- **fallback**: Primary first, secondary on failure.
- **parallel**: Both simultaneously, pick best result (clones workdir for write mode to avoid conflicts).
- **race**: Both simultaneously, return whichever finishes first.

### Adapters
- **Claude Code** (`adapters/claude.js`): Builds `claude -p <prompt> --output-format stream-json`, parses stream-json events, extracts sessionId for resume.
- **Codex** (`adapters/codex.js`): Builds `codex exec <prompt> --json --approval-mode full-auto`, parses JSONL events, extracts thread_id for resume.

## Pipeline Module (`src/pipeline/`)
Orchestrates the full ticket processing flow. Each step is checkpointed to disk so failed runs can resume from any point.

### Processing Pipeline
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

### Checkpoint Persistence
All step data is saved to `.pipeline-state/<ticketKey>/state.json`. The cheatsheet is separately persisted to `.pipeline-state/<ticketKey>/cheatsheet.md`. On resume, the pipeline skips completed steps and picks up from the specified step.

## Processing Model
- One service, one branch at a time — fully sequential.
- Each branch gets a fresh clone, processes completely (Clone → Council → Execute → Validate → Ship), then the next branch starts.
- No shared git state between branches; each is fully isolated.
- Multi-version tickets: each fix version produces a separate branch and PR per service.

## Agent Module (`src/agent/`)
The deliberately dumb executor. Combines the static system prompt (from `prompt/static.js`) with the cheatsheet and calls `runAI()` in `execute` mode with a cheap model. The static prompt enforces strict guardrails: follow the cheatsheet exactly, don't touch unlisted files, no git/docker/deploy commands, pnpm allowed for dependency management.

## JIRA Module (`src/jira/`)
Two-layer architecture: `client.js` handles read-only REST API calls (fetch ticket, get status), while `transitions.js` handles all write operations via `jira-cli.mjs` (transitions, comments, search, labels).

- **Ticket parsing** (`parser.js`): Converts raw JIRA response + ADF content → structured `{key, summary, description, comments, type, priority, status, affectedSystems, fixVersion, targetBranch, targetBranches, labels}`.
- **Validation** (`validator.js`): Pre-processing checks — content present, structural fields set (affectedSystems, fixVersion), scope limits (single system, single version), service exists in config.
- **Transitions**: Dev Started, Dev Testing, EM Review — API-first with automatic browser fallback.
- **Comments**: Posted via `jira-cli.mjs comment add --file --auto-summarize`. Long content auto-summarized via `aisum`.

## Service Module (`src/service/`)
Git operations, Azure DevOps PR creation, and base image tagging.

- **Git** (`git.js`): Shallow clone (`--depth=50`), feature branch creation, agent rules injection (CLAUDE.md/CODEX.md restored before commit), force push on branch conflict.
- **Azure DevOps** (`azure.js`): PR creation via `az repos pr create`. Handles TF401179 (PR already exists) by finding and returning the existing PR.
- **Base Tagger** (`base-tagger.js`): Auto-detected from Dockerfile. Creates `deploy.base.vMAJOR-MINOR-PATCH-BUILD` tags when `package.json`/`package-lock.json` change. Requires: Dockerfile with base-images registry FROM, Dockerfile.base, and azure-pipelines.yml.

## Notification Module (`src/notification/`)
JIRA comments (structured ADF with PR tables, summary panels, failure panels), Slack DMs (Block Kit messages with PR links), and run log upload to Pixelbin CDN. All long content auto-summarized via `utils/summariser.js` with presets (jira-comment: 32k chars, slack-message: 4k chars, pr-title: 120 chars). Hard truncation only as fallback.

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
- Council round artifacts saved to `.pipeline-state/<label>/council/round-N/`.
- Console output with ANSI colors; file output strips colors.

## Artifacts
| Location | Purpose |
|----------|---------|
| `.tmp/agent-*` | Cloned repos (cleaned up after each service branch) |
| `.pipeline-state/<ticketKey>/state.json` | Pipeline checkpoint for resume |
| `.pipeline-state/<ticketKey>/cheatsheet.md` | Persisted cheatsheet (survives retries) |
| `.pipeline-state/<ticketKey>/council/` | Council workspace: round artifacts, status, human feedback |
| `logs/YYYY-MM-DD/<runId>.log` | Full run log |
| `logs/YYYY-MM-DD/<runId>.errors.log` | Error-only log |

## Module Boundaries
Every module's `index.js` is the ONLY public interface. Internal files are private. Cross-module imports must go through `index.js`.

## Output Format
When done, summarize:
- FILES CHANGED: list of files
- SUMMARY: what was done (2-3 sentences)
- RISKS: what reviewer should check
