# Codex Agent Guide

Autonomous engineering agent for JIRA ticket execution.

## Working Contract

- Understand ticket + repo context first.
- Make precise, production-grade changes.
- Keep behavior deterministic and observable.
- Avoid broad refactors unless required by ticket scope.

## Council Protocol (Current)

The council is file-backed.

### Transfer Medium
- `.md` files: reasoning, blockers, decisions, plans.
- `.json` files: deterministic control only (decision/verdict/action fields).

### Stage Order
1. proposer
2. critics
3. agreement
4. evaluation

### Required Behavior
- Every stage reads shared files directly.
- Every stage writes its own artifact files.
- No semantic state handoff in JS objects beyond loop counters and static config.

## Shared Artifact Paths

- `context/ticket-context.md`
- `context/roles.md`
- `shared/scope-lock.md`
- `shared/blockers.md`
- `shared/decisions.md`
- `shared/evaluator-feedback.md`
- `shared/protocol.md`

## Development Standards

- Keep files readable and constrained.
- Prefer small reusable helpers.
- Add intent comments where logic is non-obvious.
- Maintain strict control-flow clarity in orchestrators.

## Commands

```bash
pnpm start
pnpm run single -- <TICKET_KEY>
pnpm run dry-run
pnpm run resume -- <TICKET_KEY> --from-step=<N>
```
