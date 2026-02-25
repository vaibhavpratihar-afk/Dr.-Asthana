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
import { buildProposerPrompt, buildCriticPrompt, buildAgreementPrompt } from './council-prompts.js';
import { validateExecution } from './validator.js';
import { log, warn } from '../utils/logger.js';

// --- Ticket-specific council configuration ---

const CHEATSHEET_MARKERS = {
  start: '=== CHEATSHEET START ===',
  end: '=== CHEATSHEET END ===',
};

const PROPOSER_ROLE =
  'Explore the codebase using Read/Glob/Grep tools. ' +
  'Propose a detailed implementation strategy for this ticket. ' +
  'List every file to change, what to change, and in what order. ' +
  'For core logic changes, provide exact code snippets. ' +
  'For boilerplate, provide directional guidance. ' +
  'Include test file updates: find existing spec/test files for the modules you change and describe what test cases need updating.';

const CRITIC_ROLE =
  'Read the Proposer\'s proposal. ' +
  'Explore the codebase to verify their claims. ' +
  'Critique: what did they miss? What\'s wrong? What\'s a better approach? ' +
  'Propose your own complete strategy. ' +
  'Pay special attention to test coverage: if the proposal changes source files, verify that corresponding spec/test files are also updated. Check for files that import the changed modules — they may need updates too.';

function buildExtractorPrompt(councilOutput, ticketContext, force) {
  const modeInstruction = force
    ? 'You MUST produce a cheatsheet even if the debate output is imperfect. Do your best.'
    : 'Only approve if the debate output contains a clear, actionable implementation plan.';

  return `You are a quality evaluator for an AI code implementation debate.

## Ticket Context
${ticketContext}

## Debate Output
${councilOutput}

## Your Task
${modeInstruction}

Evaluate the debate output and either:
1. Write "APPROVED" followed by a clean, actionable cheatsheet extracted from the debate, OR
2. Write "REJECTED" followed by specific feedback about what's missing.

The cheatsheet must be:
- A step-by-step implementation guide
- Reference specific files and code changes
- Be self-contained (readable by someone who hasn't seen the debate)

Format your cheatsheet between === CHEATSHEET START === and === CHEATSHEET END === markers.
Format your feedback after === FEEDBACK === marker.`;
}

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
      proposer: PROPOSER_ROLE,
      critic: CRITIC_ROLE,
    },
    prompts: {
      buildProposer: buildProposerPrompt,
      buildCritic: buildCriticPrompt,
      buildAgreement: buildAgreementPrompt,
    },
    evaluation: {
      buildAiPrompt: buildExtractorPrompt,
      outputMarkers: CHEATSHEET_MARKERS,
      forceOnLastRound: true,
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

export { validateExecution, reviewDiff } from './validator.js';
