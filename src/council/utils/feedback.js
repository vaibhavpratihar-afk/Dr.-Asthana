/**
 * Feedback Utility - optional human-in-loop prompt augmentation.
 *
 * Responsibility:
 * - Read consumed human feedback from workspace helper.
 * - Append a canonical feedback section to the active prompt.
 *
 * Contract:
 * - No feedback means prompt is returned unchanged.
 * - Does not own file IO logic; delegates to workspace runtime module.
 */
import { checkHumanFeedback } from '../runtime/workspace.js';

const HUMAN_FEEDBACK_SECTION = '## Human Feedback';

/**
 * Append human feedback from workspace, if present.
 *
 * @param {string} prompt
 * @param {string|null} workspace
 * @returns {string}
 */
export function appendHumanFeedback(prompt, workspace) {
  const feedback = checkHumanFeedback(workspace);
  if (!feedback) return prompt;
  return `${prompt}\n\n${HUMAN_FEEDBACK_SECTION}\n${feedback}`;
}
