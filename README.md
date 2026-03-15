# Auto Dev Agent

Autonomous JIRA-to-PR pipeline. Reads a JIRA ticket, clones the target repo, spawns a Claude or Codex CLI agent to implement the changes and ship the PR, then notifies via Slack.

## Pipeline

```
1. Fetch + validate ticket
2. Clone repo → create feature branch
3. Spawn agent (claude / codex) — implements changes, commits, pushes, creates PR
4. Bundle run artifact → upload to Pixelbin
5. Notify Slack
```

The spawned agent receives: the executor persona, ticket context (summary, description, comments, affected systems, target branch), and ship instructions (exact branch name, `az repos pr create` command with org/project/repo pre-filled). The agent explores the codebase itself, makes the changes, and ships end-to-end.

## Ticket Requirements

A ticket must pass all of the following before execution begins — rejected tickets get a Slack notification with the reason:

| Rule | Requirement |
|---|---|
| Single affected system | Exactly one entry in Affected Systems |
| Single fix version | Exactly one Fix Version / target branch |
| pnpm project | `pnpm-lock.yaml` present in repo root after clone |

Tickets failing any rule are skipped without touching the repo.

## Project Structure

```
src/
  ai-provider/              # CLI adapter + spawn runtime
    adapters/cli-json.js    # arg builder + stream parser (claude & codex)
    provider/               # spawn-runtime, event-parser, log-writer
  jira/                     # JIRA REST API client, parser, validator
  notification/             # Slack DM builders
  pipeline/
    core/                   # checkpoint path, artifact bundler, step support
    phases/                 # ticket, service, notify phase handlers
  personas/                 # executor.prompt.md
  prompt/                   # prompt builder, ticket context, ship instructions
  service/                  # git clone + cleanup
  utils/                    # config loader, logger
```

## Configuration

Copy `config.example.json` → `config.json` and fill in:

| Section | Required fields |
|---|---|
| `jira` | `baseUrl`, `email`, `apiToken`, `label` |
| `azureDevOps` | `org`, `project`, `repoBaseUrl` |
| `services` | map of service name → `{ repo }` |
| `agent` | `pollInterval`, `maxTicketsPerCycle`, `logDir` |
| `aiProvider.execute` | `provider` (`claude` or `codex`), `<provider>.command`, `<provider>.model` |
| `slack` | `botToken`, `userId` (optional) |

### Provider examples

**Claude:**
```json
"aiProvider": {
  "execute": {
    "provider": "claude",
    "claude": { "command": "claude", "model": "claude-opus-4-6" }
  }
}
```

**Codex:**
```json
"aiProvider": {
  "execute": {
    "provider": "codex",
    "codex": { "command": "codex", "model": "o3" }
  }
}
```

## Commands

```bash
pnpm start                     # daemon — polls JIRA label on interval
pnpm run single -- JCP-123     # process one ticket
pnpm run dry-run               # fetch + display tickets, no execution
```

## Artifacts

Per-ticket artifacts live under `.pipeline-state/<TICKET_KEY>/`:
- `ai-calls/<label>.prompt.md` — prompt sent to each AI call
- `ai-calls/<label>.log` — agent output summary per call

Run logs live under `logs/YYYY-MM-DD/`.

## Design Principles

- Single agent, full autonomy — the spawned agent explores, implements, commits, and ships without pipeline scaffolding.
- Provider-agnostic — works with `claude` or `codex` CLI; args built per-provider, output parsed from stream-json events.
- No artificial caps — no stall timeouts, no output truncation, no tool restrictions.
- File-backed auditability — every AI call prompt and output is persisted.
