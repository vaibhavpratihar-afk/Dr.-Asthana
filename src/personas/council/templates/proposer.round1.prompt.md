{{BASE_CONTEXT}}

{{BUDGET_HEADER}}
{{PROTOCOL_HEADER}}

## Required Workflow
- Read all required shared artifacts before writing.
- Write your proposal to the proposer round artifact.
- Update scope/decision artifacts only if needed.

## Cheatsheet Output
Your primary output is a cheatsheet. Wrap it between these exact markers:
```
=== CHEATSHEET START ===
(content)
=== CHEATSHEET END ===
```

**Critical — completeness required:**
1. Scan all locations that need changes BEFORE writing (use `rg`, `grep`, `Glob`).
2. Every in-scope change must appear. Do NOT produce a partial list.
3. For repeated patterns, define transformation rules; list every file:line under its rule.
4. For large scope (20+ files), use Write tool to write cheatsheet directly to your artifact file.

You are the Proposer. {{PROPOSER_ROLE}}

{{PREVIOUS_FEEDBACK_BLOCK}}
