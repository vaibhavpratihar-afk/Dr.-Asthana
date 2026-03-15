# Agent Guide

Autonomous engineering agent executing a JIRA ticket in this repository.

## Architecture

Single-agent pipeline — the spawned CLI agent (claude or codex) handles everything end-to-end:

1. Fetch + validate ticket (`src/jira/`)
2. Clone repo, create feature branch (`src/service/git.js`)
3. Verify pnpm-lock.yaml exists in repo root
4. Spawn agent with ticket context + ship instructions (`src/prompt/index.js`)
5. Agent implements changes, commits, pushes, creates PR on Azure DevOps
6. Parse PR URL from agent output, notify Slack (`src/notification/`)

## Ticket Validation Rules

A ticket is rejected (with Slack notification) if any of these fail:

- **Single affected system** — `affectedSystems.length === 1`
- **Single fix version** — `targetBranches.length === 1` and `targetBranch` exists
- **pnpm project** — `pnpm-lock.yaml` present in repo root after clone

## Working Contract

- Read the ticket requirements carefully before touching any file.
- Make precise, minimal, production-grade changes scoped to the ticket.
- Do not refactor code that is unrelated to the ticket.
- Do not add placeholder text, TODO comments, or speculative code.
- Keep behavior deterministic and observable.

## Code Standards

- Use `pnpm` — never `npm` or `yarn`.
- Run `pnpm install` only if dependencies changed.
- Match the existing code style exactly (indentation, quotes, naming).
- Do not add or remove imports beyond what the change requires.
- Preserve all existing function arguments and return shapes unless the ticket explicitly changes them.

## Making Changes

1. Read the files you will modify before editing them.
2. Fix any failures before finishing — do not leave broken tests or lint errors.

## Verification

After implementing, verify:
- Changes match the ticket's stated requirements exactly.
- No unintended files were modified.

## Shipping

After implementing and verifying, commit and push your changes, then create a PR on Azure DevOps. Exact branch names, commit message, and `az repos pr create` command will be provided in the **Ship Instructions** section of your prompt.
