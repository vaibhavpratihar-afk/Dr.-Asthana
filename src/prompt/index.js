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

  // 3. Early rejection gate — basic validation
  const earlyReject = earlyRejectionGate(ticketData);
  if (earlyReject) {
    return { status: 'rejected', reason: earlyReject, phase: 'early' };
  }

  // 4. Run debate
  log('Starting debate...');
  const debateResult = await runDebate(ticketContext, codebaseContext, cloneDir, config, {
    checkpointDir,
    ticketKey,
  });

  // 5. Evaluate (late rejection gate)
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

/**
 * Early rejection gate — validates ticket has minimum viable data.
 * Returns rejection reason string, or null if passed.
 */
function earlyRejectionGate(ticketData) {
  if (!ticketData.summary || ticketData.summary === 'No summary') {
    return 'Ticket has no summary';
  }

  if (!ticketData.description || ticketData.description === 'No description provided') {
    // Not a hard reject — some tickets rely on comments
    if (!ticketData.comments || ticketData.comments.length === 0) {
      return 'Ticket has no description and no comments';
    }
  }

  if (!ticketData.affectedSystems || ticketData.affectedSystems.length === 0) {
    return 'No Affected Systems specified';
  }

  if (!ticketData.targetBranch) {
    return 'No Fix Version specified';
  }

  return null;
}

export { validateExecution } from './validator.js';
