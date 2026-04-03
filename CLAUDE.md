# CLAUDE Agent Guide

Thin launcher for an autonomous JIRA-to-PR pipeline. Claude handles everything — JS only exists for two things Claude can't do: **start itself** (JIRA polling) and **send Slack messages**.

## Files

```
src/
  index.js          CLI entry, JIRA poll, spawn Claude, parse result, trigger Slack
  slack.js          Slack DM via Web API (conversations.open + chat.postMessage)
  agent.prompt.md   Agent persona — workflow, rules, pipeline verification loop, output format
config.json         JIRA creds, service mapping, ADO config, Slack config, AI provider settings
```

## What Claude Handles

1. Fetch JIRA ticket (via `jira-cli`)
2. Validate ticket (single system, single version, has description/comments)
3. Map Affected System to repo (falls back to using the system name as repo if not in config)
4. Clone repo, create feature branch
5. Implement changes
6. Commit, push, create PR on Azure DevOps
7. **Poll the Merge Pipeline** — wait for CI, read failure logs, fix code, re-push (up to 3 attempts)
8. Print structured `RESULT_JSON` for JS to parse

## What JS Handles

1. **JIRA polling** — daemon mode searches JIRA for tickets with the configured label
2. **Spawn Claude** — creates temp dir, builds prompt (persona + pipeline context), spawns `claude -p`
3. **Slack notification** — parses Claude's `RESULT_JSON` output and sends a DM (success/bailout/failure)
4. **Cleanup** — removes temp working directory after run

## Pipeline Flow

```
JIRA poll → find ticket → create tmp dir → spawn Claude
  Claude: fetch ticket → validate → clone → implement → PR → poll merge pipeline → fix if needed
JS: parse RESULT_JSON → send Slack DM → cleanup tmp dir
```

## Rules

1. Use `pnpm` (not npm/yarn).
2. Zero runtime dependencies — just Node.js built-ins + `fetch`.
3. Keep it minimal. If Claude can do it, don't write JS for it.
