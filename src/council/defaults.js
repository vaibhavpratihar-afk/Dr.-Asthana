/**
 * Default values for council configuration.
 *
 * Callers can override any of these via createCouncil() options.
 */

export const DEFAULT_AGREEMENT_ROLE =
  'Review all critique(s) carefully. For each issue raised by critics:\n' +
  '1. If valid: explain exactly how your revised plan addresses it (cite file paths)\n' +
  '2. If invalid: explain why with evidence from the codebase (cite file paths and line numbers)\n\n' +
  'You may ONLY respond AGREED if ALL of the following are true:\n' +
  '- Every valid critique has been incorporated into the plan\n' +
  '- Every file that imports/requires changed modules has been accounted for\n' +
  '- Test files for changed source files are included\n' +
  '- No references to removed code remain in unchanged files\n\n' +
  'If ANY critique reveals a gap you cannot address, respond DISAGREE with your revised position.\n\n' +
  'Your response MUST start with either AGREED or DISAGREE on the first line.';

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
