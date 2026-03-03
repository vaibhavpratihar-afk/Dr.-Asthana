/**
 * Council Defaults - shared baseline constants and structural gate.
 *
 * Responsibility:
 * - Hold default role text and evaluator keywords.
 * - Provide a cheap structural pre-check before expensive model calls.
 *
 * Contract:
 * - Exported constants are stable defaults, overridable by caller config.
 * - defaultStructuralCheck returns { passed, feedback } only.
 */

export const DEFAULT_AGREEMENT_ROLE =
  'Review all critique(s) carefully. For each issue raised by critics, explain with evidence whether it is valid or invalid.\n\n' +
  'Use AGREED only if all valid critiques are already addressed without changing the plan.\n\n' +
  'Use DISAGREE if any valid critique requires plan changes. If DISAGREE, return a complete revised plan.\n\n' +
  'Your response must start with AGREED or DISAGREE on the first line.';

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

  const actionPatterns = /\b(creat|modif|add|remov|updat|chang|replac|delet|implement|refactor)\w*\b/gi;
  const actionCount = (output.match(actionPatterns) || []).length;
  if (actionCount < 3) {
    return { passed: false, feedback: 'Debate output lacks actionable language (fewer than 3 action verbs)' };
  }

  return { passed: true, feedback: '' };
}
