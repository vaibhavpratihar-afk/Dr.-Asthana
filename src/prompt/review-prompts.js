/**
 * PR review council prompt builders and evaluation guards.
 *
 * Pure prompt/validation helpers: no I/O, no git operations.
 */

import { buildProposerPrompt, buildCriticPrompt, buildAgreementPrompt } from './council-prompts.js';
import { getPersona, renderPersonaTemplate } from '../personas/index.js';

export const REVIEW_MARKERS = {
  start: '=== PR REVIEW START ===',
  end: '=== PR REVIEW END ===',
};

export function getReviewRoles() {
  return {
    proposer: getPersona('reviewProposer'),
    critic: getPersona('reviewCritic'),
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

  return renderPersonaTemplate('reviewEvaluatorTemplate', {
    CONTEXT: context,
    COUNCIL_OUTPUT: councilOutput,
    MODE_INSTRUCTION: modeInstruction,
    START_MARKER: REVIEW_MARKERS.start,
    END_MARKER: REVIEW_MARKERS.end,
  });
}

/**
 * Structural pre-check for PR review council output.
 *
 * This runs on councilOutput (agreement-stage text), NOT the final extracted
 * report. Validate debate quality here — file references, actionable language,
 * minimum length. Report-shape validation (Verdict/Findings sections) belongs
 * in the evaluator output after extraction/contract parsing.
 */
export function reviewStructuralCheck(output) {
  if (!output || output.trim().length < 100) {
    return { passed: false, feedback: 'Review debate output too short (< 100 chars)' };
  }

  // Generic file-reference detection: paths with / separators OR dotted extensions.
  // Avoids a hardcoded extension whitelist that misses Dockerfile, Makefile, lockfiles, etc.
  const slashPaths = output.match(/[\w\-.]+(?:\/[\w\-.]+)+/g) || [];
  const dottedPaths = output.match(/[\w\-./]+\.\w{1,10}/g) || [];
  if (slashPaths.length + dottedPaths.length < 1) {
    return { passed: false, feedback: 'Review debate output does not reference any file paths' };
  }

  return { passed: true, feedback: '' };
}
