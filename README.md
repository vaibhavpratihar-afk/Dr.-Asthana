# Auto Dev Agent

A **Claude Code agent that is just markdown.** On a schedule, Claude reads open JIRA tickets carrying
a trigger label and, for each, implements the change in a fresh worktree of a configured **workspace**
and opens a pull request — then reports to Slack.

The agent has **no application code**. The agent *is* [`agent.md`](agent.md), executed by Claude.
Everything Claude can already do (search JIRA, clone/branch, edit, commit, push, open PRs, post
Slack) it does itself by following that markdown, using the CLIs already on the machine
(`jira-cli`, `gh`, `az`, `curl`). The only non-markdown file is [`run.sh`](run.sh), a thin bash
launcher for the one thing the agent can't do for itself — capture its own run transcript — which it
uploads to Pixelbin for post-mortem.

```
agent.md      the agent — the whole workflow, in markdown (Claude executes it)
run.sh        launcher: run Claude, capture transcript → Pixelbin → Slack the log link
config.json   data only: workspace path, trigger label, model, Slack
```

No `src/`, no `package.json`, no dependencies. The workspace itself carries its own `CLAUDE.md` /
`AGENTS.md` telling Claude how to work in it — that knowledge lives in the workspace, not here, so
this agent is generic (cms-ai is just the configured `workspace.path`).

## Flow

```
scheduler (ghanta-ghar / cron) → run.sh
  └─ claude -p  (system prompt = agent.md), one cycle:
       search JIRA for open tickets with the trigger label   (jira-cli)
       for each ticket (up to maxTickets):
         git worktree add — clean checkout of the workspace on a new feature branch
         read the workspace's own instructions, implement the ticket
         ship the PR  (gh / az, ambient auth)   |   or bail out cleanly
         DM the outcome to Slack  (curl)
         worktree remove
  └─ tee transcript → pixelbin-upload → DM the log link to Slack
```

## Configuration

Copy `config.example.json` → `config.json` (gitignored):

| Field | Meaning |
|---|---|
| `label` | JIRA trigger label |
| `workspace.path` | absolute path to the local workspace (data-source) git repo |
| `workspace.baseBranch` | branch to cut feature branches from |
| `maxTickets` | tickets to process per run (1 = one ticket per scheduled run) |
| `claude.model` | model for the run (optional) |
| `slack` | `botToken` + `userId` (optional — omit to print outcomes to stdout) |

JIRA auth is **not** here — it belongs to the `jira` CLI (`JIRA_CONFIG_PATH`), which Claude uses.

## Run

```bash
./run.sh          # one cycle: process labeled tickets, then exit
```

Point ghanta-ghar (or cron) at `run.sh`. There is no daemon — each invocation processes the current
queue once and exits.

## Requirements (all already on this machine)

- `claude` CLI, logged in
- `jira-cli` (`~/Desktop/skills/jira/scripts/jira-cli.mjs`) configured via `JIRA_CONFIG_PATH`
- `gh` / `az` authenticated as needed for shipping
- `pixelbin-upload` on `PATH` (optional — transcript upload is skipped if absent)
- A local clone of the workspace at `workspace.path`
