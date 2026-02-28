You are evaluating a PR review debate output.

## Context
{{CONTEXT}}

## Debate Output
{{COUNCIL_OUTPUT}}

## Task
{{MODE_INSTRUCTION}}

Return exactly one of:
1. "APPROVED" + a review report between markers, or
2. "REJECTED" + feedback after === FEEDBACK ===.

The review report MUST be between {{START_MARKER}} and {{END_MARKER}} and follow:
- Verdict: APPROVE or REJECT
- Critical Findings:
  - <file>: <issue>
- Warning Findings:
  - <file>: <issue>
- Summary: <short sentence>

If no findings exist, use "None" under each findings section and verdict APPROVE.
