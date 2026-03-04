# Auto Dev Agent

Autonomous JIRA-to-PR pipeline. Reads a JIRA ticket, clones the target repo, runs a Codex agent to implement the changes, runs an adversarial diff review loop, and ships a PR on Azure DevOps.

## Pipeline

```
1. Fetch + validate ticket
2. Clone repo → create feature branch
3. Execute  — Codex agent implements changes
4. Diff review loop  — adversarial reviewer flags issues, Codex fixes, repeat until APPROVED
5. Commit + push
6. Create PR on Azure DevOps
7. Notify JIRA + Slack
```

The executor receives: the persona prompt, ticket context (summary, description, comments, target branch), and codebase context (instruction files, file tree, package.json, referenced files pre-loaded).

The diff reviewer is a separate Codex call that sees only the raw diff and ticket requirements — no shared state with the executor. It returns `APPROVED` or `NEEDS_CHANGES` with specific issues. On `NEEDS_CHANGES` a targeted fix pass runs and the loop repeats (up to `diffReview.maxRetries`). If the loop exhausts retries without approval, the run fails and no PR is created.

## Project Structure

```
src/
  ai-provider/          # Codex CLI adapter + spawn runtime
    adapters/codex.js   # arg builder, stream parser
    provider/           # spawn-runtime, event-parser, log-writer
  jira/                 # JIRA API client, ADF parser, transitions, validator
  notification/         # JIRA comment + Slack DM builders
  pipeline/             # step orchestrator, checkpoint, diff-review loop, artifact bundler
  personas/             # executor.prompt.md, diff-reviewer.persona.md
  prompt/               # prompt builder, ticket context, codebase context
  service/              # git operations, Azure DevOps PR, base image tagger
  utils/                # config loader, logger, AI summariser
```

## Configuration

Copy `config.example.json` → `config.json` and fill in:

| Section | Required fields |
|---|---|
| `jira` | `baseUrl`, `email`, `apiToken`, `label` |
| `azureDevOps` | `org`, `project`, `repoBaseUrl` |
| `services` | map of service name → `{ repo }` |
| `agent` | `pollInterval`, `maxTicketsPerCycle`, `logDir` |
| `aiProvider.execute` | `provider` (`codex`), `codex.model`, `codex.timeoutMinutes` |
| `diffReview` | `maxRetries` |
| `slack` | `botToken`, `userId` (optional) |

## Commands

```bash
pnpm start                     # daemon — polls JIRA label on interval
pnpm run single -- JCP-123     # process one ticket
pnpm run dry-run               # fetch + display tickets, no execution
pnpm run resume -- JCP-123     # re-run a ticket from scratch
```

## Artifacts

Per-ticket artifacts live under `.pipeline-state/<TICKET_KEY>/`:
- `ai-calls/<label>.prompt.md` — prompt sent to each AI call
- `ai-calls/<label>.log` — agent output summary per call
- `state.json` — pipeline checkpoint

Run logs live under `logs/YYYY-MM-DD/`.

## Design Principles

- Single-agent execution — no planning council, no debate rounds.
- Adversarial quality gate — diff reviewer is independent, sees only diff + ticket.
- Fail closed — if diff review cannot reach APPROVED, no PR is created.
- File-backed auditability — every AI call prompt and output is persisted.
- Minimal hidden state — config and ticket drive all decisions.
