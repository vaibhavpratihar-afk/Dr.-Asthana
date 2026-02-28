import { getPersona } from '../personas/index.js';

/**
 * Static agentic system prompt for the executor.
 * The rules the dumb executor must follow.
 */

export function getStaticPrompt() {
  return getPersona('executorPrompt');
}
