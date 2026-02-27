/**
 * PR review council prompt builders and evaluation guards.
 *
 * Pure prompt/validation helpers: no I/O, no git operations.
 */

import { buildProposerPrompt, buildCriticPrompt, buildAgreementPrompt } from './council-prompts.js';

export const REVIEW_MARKERS = {
  start: '=== PR REVIEW START ===',
  end: '=== PR REVIEW END ===',
};

const REVIEW_PROPOSER_ROLE =
  'You are a strict PR reviewer. Review only the provided git diff and changed files. ' +
  'Identify correctness risks, regressions, missing tests, incomplete updates, and unsafe behavior. ' +
  'Do not suggest broad refactors unrelated to the diff. ' +
  'Output findings with severity as CRITICAL or WARNING, each with file path and exact reason.';

const REVIEW_CRITIC_ROLE =
  'You are an adversarial PR reviewer. Challenge the proposer and find misses. ' +
  'You must verify claims directly against the diff/context and add missing findings. ' +
  'Prioritize concrete, merge-blocking defects over style nits. ' +
  'Each finding must include severity (CRITICAL/WARNING), file path, and rationale.';

export function getReviewRoles() {
  return {
    proposer: REVIEW_PROPOSER_ROLE,
    critic: REVIEW_CRITIC_ROLE,
  };
}

// Thin wrappers keep PR review coupling explicit and allow future divergence.
export function buildReviewProposerPrompt(...args) {
  return buildProposerPrompt(...args);
}

export function buildReviewCriticPrompt(...args) {
  return buildCriticPrompt(...args);
}

export function buildReviewAgreementPrompt(...args) {
  return buildAgreementPrompt(...args);
}

export function buildReviewExtractorPrompt(councilOutput, context, force) {
  const modeInstruction = force
    ? 'Produce best-effort review output even if debate quality is imperfect.'
    : 'Reject if findings are vague or missing file-specific evidence.';

  return `You are evaluating a PR review debate output.

## Context
${context}

## Debate Output
${councilOutput}

## Task
${modeInstruction}

Return exactly one of:
1. "APPROVED" + a review report between markers, or
2. "REJECTED" + feedback after === FEEDBACK ===.

The review report MUST be between ${REVIEW_MARKERS.start} and ${REVIEW_MARKERS.end} and follow:
- Verdict: APPROVE or REJECT
- Critical Findings:
  - <file>: <issue>
- Warning Findings:
  - <file>: <issue>
- Summary: <short sentence>

If no findings exist, use "None" under each findings section and verdict APPROVE.`;
}

export function reviewStructuralCheck(output) {
  if (!output || output.trim().length < 50) {
    return { passed: false, feedback: 'Review output too short' };
  }
  if (!/verdict\s*:/i.test(output)) {
    return { passed: false, feedback: 'Missing Verdict section' };
  }
  if (!/(critical|warning)\s+findings\s*:/i.test(output)) {
    return { passed: false, feedback: 'Missing findings section' };
  }
  return { passed: true, feedback: '' };
}
