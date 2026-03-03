/**
 * Agent Runner - resilient runAI wrapper.
 *
 * Responsibility:
 * - Execute one agent call with provider config and logging metadata.
 *
 * Contract:
 * - Never throws; always returns { output, rateLimited, failed }.
 * - Failure modes are normalized for deterministic stage handling.
 */

import { runAI } from '../../ai-provider/index.js';
import { warn } from '../../utils/logger.js';

const toAgentResult = (result) => ({
  output: result.output || '',
  rateLimited: Boolean(result.rateLimited),
  failed: false,
});
const toFailedAgentResult = () => ({ output: '', rateLimited: false, failed: true });

/**
 * Run a single council agent (proposer or critic phase)
 * with error handling.
 *
 * @param {object} opts
 * @param {string} opts.prompt - The prompt to send
 * @param {string} opts.workingDir - Working directory for tool access
 * @param {string} opts.label - Log label for this call
 * @param {number} opts.agentIndex - Index in the agents array
 * @param {object[]} opts.agents - Resolved agent configs
 * @param {object} opts.config - Full config object
 * @param {string} opts.councilLabel - Council label for log filenames
 * @returns {Promise<{output: string, rateLimited: boolean, failed: boolean}>}
 */
export async function runAgent({ prompt, workingDir, label, agentIndex, agents, config, councilLabel }) {
  try {
    const result = await runAI({
      prompt,
      workingDir,
      mode: 'debate',
      label,
      logDir: config.agent.logDir,
      ticketKey: councilLabel,
      config,
      providerConfig: agents[agentIndex],
    });

    return toAgentResult(result);
  } catch (err) {
    warn(`[${label}] Failed: ${err.message}`);
    return toFailedAgentResult();
  }
}
