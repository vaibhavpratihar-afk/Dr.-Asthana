/**
 * Default values for council configuration.
 *
 * Callers can override any of these via createCouncil() options.
 */

export const DEFAULT_AGREEMENT_ROLE =
  'Review all critique(s) of your proposal. ' +
  'If you can incorporate their feedback into a single unified plan, ' +
  'respond with AGREED on the first line followed by the complete unified plan. ' +
  'If you fundamentally disagree with key points, respond with DISAGREE on the first line ' +
  'followed by your reasons and your revised position.\n\n' +
  'Your response MUST start with either AGREED or DISAGREE.';

export const DEFAULT_APPROVAL_KEYWORD = 'APPROVED';
export const DEFAULT_REJECTION_KEYWORD = 'REJECTED';
export const DEFAULT_FEEDBACK_MARKER = '=== FEEDBACK ===';

/**
 * Default structural pre-check: minimum length, file paths, action verbs.
 * @param {string} output - Debate output to check
 * @returns {{passed: boolean, feedback: string}}
 */
export function defaultStructuralCheck(output) {
  if (!output || output.trim().length < 200) {
    return { passed: false, feedback: 'Debate output too short (< 200 chars)' };
  }

  const filePathPattern = /[\w\-./]+\.(js|ts|jsx|tsx|json|yml|yaml|md|css|html|py|go|rs|sh)/g;
  const filePaths = output.match(filePathPattern) || [];
  if (filePaths.length < 2) {
    return { passed: false, feedback: 'Debate output mentions fewer than 2 file paths' };
  }

  const actionPatterns = /\b(create|modify|add|remove|update|change|replace|delete|implement|refactor)\b/gi;
  const actionCount = (output.match(actionPatterns) || []).length;
  if (actionCount < 3) {
    return { passed: false, feedback: 'Debate output lacks actionable language (fewer than 3 action verbs)' };
  }

  return { passed: true, feedback: '' };
}
