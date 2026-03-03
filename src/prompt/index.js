/**
 * Prompt Module — orchestrates the full prompt pipeline.
 *
 * The brain: configures a council of AI agents with ticket-specific roles
 * and evaluation criteria, then runs it to produce a cheatsheet.
 * The cheatsheet is the most valuable artifact — persisted to disk.
 */

import { buildTicketContext } from './ticket-context.js';
import { buildCodebaseContext, extractFilePaths } from './codebase-context.js';
import { createCouncil } from '../council/index.js';
import { buildProposerPrompt, buildCriticPrompt } from './council-prompts.js';
import { getPersona, buildCouncilEvaluatorPrompt } from '../personas/index.js';
import { validateExecution } from './validator.js';
import { log, warn } from '../utils/logger.js';

// --- Ticket-specific council configuration ---

const CHEATSHEET_MARKERS = {
  start: '=== CHEATSHEET START ===',
  end: '=== CHEATSHEET END ===',
};

/**
 * Build a cheatsheet for a ticket via the council pipeline.
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

  // 2. Read codebase context (pre-include files referenced in ticket)
  log('Building codebase context...');
  const ticketText = `${ticketData.description || ''}\n${(ticketData.comments || []).map(c => c.text).join('\n')}`;
  const referencedFiles = extractFilePaths(ticketText);
  if (referencedFiles.length > 0) {
    log(`Found ${referencedFiles.length} file paths in ticket — pre-loading contents`);
  }
  const codebaseContext = buildCodebaseContext(cloneDir, { referencedFiles });

  // 3. Configure and run council
  log('Starting council...');
  const council = createCouncil({
    goal: 'Propose a detailed implementation strategy for this ticket.',
    context: `${ticketContext}\n\n## Codebase Context\n\n${codebaseContext}`,
    workingDir: cloneDir,
    roles: {
      proposer: getPersona('councilProposer'),
      critic: getPersona('councilCriticDiscovery'),
    },
    prompts: {
      buildProposer: buildProposerPrompt,
      buildCritic: buildCriticPrompt,
    },
    evaluation: {
      buildAiPrompt: (councilOutput, ticketContext, force) => buildCouncilEvaluatorPrompt({ councilOutput, ticketContext, force, cheatsheetMarkers: CHEATSHEET_MARKERS }),
      outputMarkers: CHEATSHEET_MARKERS,
      forceOnLastRound: config.council?.forceOnLastRound === true,
    },
    config,
    label: ticketKey || 'cheatsheet',
    checkpointDir,
    feedback: options.feedback,
  });

  const result = await council.run();

  // 4. Map council result to prompt module return format
  if (!result.passed || !result.output) {
    return {
      status: 'rejected',
      reason: result.feedback || 'Council failed to produce an acceptable cheatsheet',
      phase: 'late',
    };
  }

  log(`Cheatsheet produced (${result.output.length} chars, ${result.rounds} rounds)`);

  return {
    status: 'approved',
    cheatsheet: result.output,
    summary: `Council completed in ${result.rounds} round(s)`,
  };
}

export { validateExecution } from './validator.js';
