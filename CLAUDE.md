# CLAUDE Agent Guide

This repository is a **markdown-only Claude agent**. The agent *is* `agent.md`, executed by Claude on
a schedule. It turns labeled JIRA tickets into shipped PRs in a configured workspace.

## The one rule that shapes everything

**The agent must not contain application code.** If Claude can do something natively (JIRA via
`jira-cli`, git/worktree via Bash, PRs via `gh`/`az`, Slack via `curl`), it belongs in `agent.md` as
an instruction — never in a `.js` file. Code is allowed **only** for a capability Claude genuinely
lacks (e.g. uploading to a CDN), and even then prefer an existing external CLI over adding code here.

When asked to add a feature, ask first: *can Claude already do this?* If yes → edit `agent.md`. If it
needs workspace-specific knowledge → it belongs in the **workspace's** own `CLAUDE.md`, not here. Only
a true capability gap with no existing CLI justifies new code.

## Files

| File | Role |
|---|---|
| `agent.md` | **The agent.** The whole workflow (find tickets → worktree → implement → ship → Slack), in markdown. Claude executes it. |
| `run.sh` | The only non-markdown file. Bash launcher for the one gap the agent can't fill itself: capture its own transcript → `pixelbin-upload` → Slack the log link. ghanta-ghar/cron points here. |
| `config.json` | Data only: `label`, `workspace.{path,baseBranch}`, `maxTickets`, `claude.model`, `slack`. No logic. |

There is intentionally no `src/`, no `package.json`, no dependencies.

## How a run works

`run.sh` launches `claude -p` with `agent.md` as the system prompt for one cycle. Claude searches
JIRA for the label, and per ticket: makes a clean worktree of `workspace.path`, reads the workspace's
own instructions, implements the ticket, ships a PR (or bails out), and DMs the outcome to Slack.
`run.sh` then tees the transcript, uploads it to Pixelbin, and DMs the log link.

## Capability gaps (the only place code is allowed)

- **Transcript capture** → `run.sh` (the agent can't tee its own stdout).
- **Pixelbin upload** → the external `pixelbin-upload` CLI (called from `run.sh`).

Everything else is Claude doing its job from `agent.md`.
