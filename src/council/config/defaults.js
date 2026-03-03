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

export const DEFAULT_APPROVAL_KEYWORD = 'APPROVED';
export const DEFAULT_REJECTION_KEYWORD = 'REJECTED';

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
