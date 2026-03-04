# Codex Agent Guide

Autonomous engineering agent executing a JIRA ticket in this repository.

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
2. Run the relevant test commands from `package.json` scripts after making changes.
3. Run a linter if one is configured (`pnpm lint` or similar).
4. Fix any failures before finishing — do not leave broken tests or lint errors.

## Verification

After implementing, verify:
- Changes match the ticket's stated requirements exactly.
- No unintended files were modified.
- Tests pass.
- No new lint errors.

## Git

Do not commit. The pipeline handles commits after review.
