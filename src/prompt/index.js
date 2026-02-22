/**
 * Prompt Module — orchestrates the full prompt pipeline.
 *
 * The brain: expensive models debate and produce a cheatsheet.
 * The cheatsheet is the most valuable artifact — persisted to disk.
 */

import { buildTicketContext } from './ticket-context.js';
import { buildCodebaseContext } from './codebase-context.js';
import { runDebate } from './debate.js';
import { validateExecution } from './validator.js';
import { log, warn } from '../utils/logger.js';

/**
 * Build a cheatsheet for a ticket via the debate pipeline.
 *
 * @param {object} ticketData - Parsed ticket object from jira/parser.js
 * @param {string} cloneDir - Path to cloned repo
 * @param {object} config - Full config object
 * @param {object} [options]
 * @param {string} [options.checkpointDir] - Directory to save debate artifacts
 * @param {string} [options.ticketKey] - JIRA ticket key
 * @returns {Promise<{status: 'approved'|'rejected', cheatsheet?: string, summary?: string, reason?: string, phase?: 'early'|'late'}>}
 */
export async function buildCheatsheet(ticketData, cloneDir, config, options = {}) {
  const { checkpointDir, ticketKey } = options;

  // 1. Build ticket context
  log('Building ticket context...');
  const ticketContext = buildTicketContext(ticketData);

  // 2. Read codebase context
  log('Building codebase context...');
  const codebaseContext = buildCodebaseContext(cloneDir);

  // 3. Run debate
  log('Starting debate...');
  const debateResult = await runDebate(ticketContext, codebaseContext, cloneDir, config, {
    checkpointDir,
    ticketKey,
  });

  // 4. Evaluate (late rejection gate)
  if (!debateResult.passed || !debateResult.cheatsheet) {
    return {
      status: 'rejected',
      reason: debateResult.feedback || 'Debate failed to produce an acceptable cheatsheet',
      phase: 'late',
    };
  }

  log(`Cheatsheet produced (${debateResult.cheatsheet.length} chars, ${debateResult.rounds} rounds)`);

  return {
    status: 'approved',
    cheatsheet: debateResult.cheatsheet,
    summary: `Debate completed in ${debateResult.rounds} round(s)`,
  };
}

export { validateExecution } from './validator.js';
