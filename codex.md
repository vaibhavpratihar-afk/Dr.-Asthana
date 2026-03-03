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
- Stage outputs are captured to round artifacts by orchestrator fallback.
- If an agent already wrote its artifact file, stage code preserves that file and does not overwrite it.
- No semantic state handoff in JS objects beyond loop counters and static config.

## Cheatsheet Contract

- Proposer output must include markers:
  - `=== CHEATSHEET START ===`
  - `=== CHEATSHEET END ===`
- Evaluators approve/reject via contract; on approval, cheatsheet extraction prefers evaluator markers, then proposer/council markers.
- Force-mode fallback also extracts the marked cheatsheet when present.

## Contract Files

- Agreement contract: `rounds/round-N/agreement-contract.json`
- Evaluation contract: `rounds/round-N/evaluation-contract.json`

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

## Runtime Notes

- Council prompts explicitly tell agents to use the local `workingDir` for source reads and git checks.
- Codex provider cannot combine `exec resume` with `--add-dir`; when additional writable dirs are required, a fresh Codex session is started.
- Proposer defaults: `maxTurns=50`, `timeoutMinutes=15`.

## Commands

```bash
pnpm start
pnpm run single -- <TICKET_KEY>
pnpm run dry-run
pnpm run resume -- <TICKET_KEY> --from-step=<N>
```
