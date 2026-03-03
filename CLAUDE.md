# CLAUDE Agent Guide

This repository runs an autonomous JIRA-to-PR pipeline.

## Non-Negotiable Rules

1. Read before writing.
2. Keep diffs minimal and ticket-scoped.
3. Do not add placeholder code.
4. Prefer deterministic, auditable behavior.
5. Use `pnpm` (not npm/yarn).
6. Do not use destructive git commands.

## Council Architecture (Important)

Council communication is artifact-only:
- Markdown (`.md`) for reasoning and planning.
- JSON (`.json`) only for deterministic control operations.

Do not rely on hidden semantic summaries between stages.
Every stage must read shared artifacts directly.

### Shared Council Files
- `context/ticket-context.md`
- `context/roles.md`
- `shared/scope-lock.md`
- `shared/blockers.md`
- `shared/decisions.md`
- `shared/evaluator-feedback.md`
- `shared/protocol.md`

### Round Files
- `rounds/round-N/proposer.md`
- `rounds/round-N/critic-1.md` ...
- `rounds/round-N/evaluation.md`
- `rounds/round-N/control.json`

### Contract Files
- `rounds/round-N/evaluation-contract.json`

## Cheatsheet + Evaluation Rules

- Proposer must emit a complete cheatsheet between:
  - `=== CHEATSHEET START ===`
  - `=== CHEATSHEET END ===`
- Evaluator may approve without re-emitting cheatsheet; evaluator output markers are optional.
- Evaluation reads combined proposer + critic content.
- On forced last-round evaluation, output still prefers extracted cheatsheet markers when present.

## Prompt/Runtime Expectations

- Agents are instructed to treat local `workingDir` as source of truth for code and git checks.
- Artifact prompts define required reads and writable artifacts; round files are read only when they exist.
- Main agent response is captured by orchestrator; direct writes to shared artifacts are allowed.

## Pipeline Steps

- Fetch ticket
- Validate ticket
- Clone/setup branch
- Build cheatsheet via council
- Execute
- Validate
- Ship PR
- Notify

## Output Expectations

- High signal, low noise.
- Explicit scope and risks.
- Reproducible artifact trail.
