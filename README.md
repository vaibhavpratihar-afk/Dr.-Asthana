# Auto Dev Agent

A thin **Claude Code wrapper** for the [cms-ai](https://github.com/vaibhavpratihar-afk/cms-ai)
workspace. On a schedule, it finds JIRA tickets carrying a trigger label and runs Claude — in a
fresh, throwaway worktree of cms-ai — to implement each ticket and open a pull request.

Almost everything the agent used to hand-roll (process spawning, stream parsing, persona injection,
git clone, PR creation, logging) is now native Claude Code. This wrapper only does the two things
Claude can't bootstrap on its own: **find the labeled tickets** and **report the result**.

## Flow

```
scheduler (ghanta-ghar / cron)
  → search JIRA for open tickets with the trigger label
  → for each ticket:
      create a fresh git worktree of cms-ai on a new feature branch
      run `claude -p` in it  (Claude: routes KB-vs-service, implements, ships the PR)
      parse the result (PR URL / bailout)
      notify Slack (or stdout)
      remove the worktree
  → exit
```

Claude decides scope from the ticket plus cms-ai's own `CLAUDE.md` / `AGENTS.md` routing table:

- **Knowledge-base task** → edit files in cms-ai (`docs/`, `personas/`, `theme/`, …) → `gh pr` to GitHub.
- **Platform-service task** → clone the needed Azure repo per `repos.json` → change it → `az repos pr`.

The agent ships using the ambient `gh` / `az` auth already on the machine — the wrapper never
handles tokens.

## Layout

```
src/
  index.js     CLI entry: search labeled tickets → run each → notify → exit
  config.js    load + validate config.json
  jira.js      REST search by label, fetch ticket (ADF → text), minimal validation
  agent.js     fresh cms-ai worktree → spawn `claude -p --output-format json` → parse result
  notify.js    Slack DM (optional) or stdout
executor.prompt.md   system prompt: scope routing, ship instructions, bailout, output markers
```

## Configuration

Copy `config.example.json` → `config.json` (gitignored) and fill in:

| Section | Fields |
|---|---|
| `jira` | `baseUrl`, `email`, `apiToken`, `label`, `maxComments` |
| `cmsAi` | `path` (absolute path to the local cms-ai clone), `baseBranch` |
| `claude` | `command`, `model`, `maxTurns` |
| `slack` | `botToken`, `userId` (optional — omit to log results to stdout) |
| `maxTickets` | how many labeled tickets to process per run |

## Run

```bash
pnpm start            # process labeled tickets once, then exit (scheduled mode)
node src/index.js JCP-1234   # process one specific ticket
```

There is no daemon. Schedule `pnpm start` with ghanta-ghar (or cron); each invocation processes the
current queue and exits.

## Requirements

- Node ≥ 18, `pnpm`
- `claude` CLI, logged in, on `PATH`
- A local clone of cms-ai at `cmsAi.path`, with `gh` (GitHub) and `az` (Azure DevOps) authenticated
- A ticket gate (run is skipped with a notification if it fails): a ticket needs a summary and
  either a description or comments.
```
