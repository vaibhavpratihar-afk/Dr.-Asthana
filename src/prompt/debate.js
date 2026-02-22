/**
 * The debate engine. Spawns two AI agents that argue.
 *
 * Flow:
 *   Round 1: Agent A proposes strategy -> Agent B critiques and counter-proposes
 *   Round 2-N: Agent A revises -> Agent B refines
 *   After each round: evaluator judges. If approved, stop.
 *   After max rounds: force evaluator to produce best-effort cheatsheet.
 *
 * Both agents use read-only tools (Read, Glob, Grep).
 * Agents run sequentially (A then B per round), not in parallel.
 *
 * All AI spawning goes through the AI Provider module via runAI().
 */

import fs from 'fs';
import path from 'path';
import { runAI } from '../ai-provider/index.js';
import { isGarbageOutput } from '../ai-provider/provider.js';
import { evaluate } from './evaluator.js';
import { log, warn, debug } from '../utils/logger.js';

/**
 * Save a debate round output to the checkpoint directory.
 */
function saveRoundOutput(checkpointDir, round, agent, output) {
  try {
    const roundDir = path.join(checkpointDir, 'debate-rounds');
    if (!fs.existsSync(roundDir)) {
      fs.mkdirSync(roundDir, { recursive: true });
    }
    const filePath = path.join(roundDir, `round-${round}-${agent.toLowerCase()}.md`);
    fs.writeFileSync(filePath, output);
    debug(`Saved debate round ${round} ${agent} output to ${filePath}`);
  } catch { /* non-critical */ }
}

/**
 * Run the debate engine.
 *
 * @param {string} ticketContext - From buildTicketContext()
 * @param {string} codebaseContext - From buildCodebaseContext()
 * @param {string} cloneDir - Path to cloned repo
 * @param {object} config - Full config object
 * @param {object} [options]
 * @param {string} [options.feedback] - Feedback from evaluator or manual guidance
 * @param {string} [options.checkpointDir] - Directory to save round outputs
 * @param {string} [options.ticketKey] - JIRA ticket key
 * @returns {Promise<{passed: boolean, cheatsheet: string|null, feedback: string|null, rounds: number}>}
 */
export async function runDebate(ticketContext, codebaseContext, cloneDir, config, options = {}) {
  const { feedback: initialFeedback, checkpointDir, ticketKey = 'debate' } = options;
  const maxRounds = config.aiProvider?.debate?.maxRounds || config.debate?.maxRounds || 3;

  const baseContext = `${ticketContext}\n\n## Codebase Context\n\n${codebaseContext}`;

  let agentAOutput = '';
  let agentBOutput = '';
  let lastDebateOutput = '';

  for (let round = 1; round <= maxRounds; round++) {
    log(`=== Debate Round ${round}/${maxRounds} ===`);

    // --- Agent A ---
    let agentAPrompt;
    if (round === 1) {
      agentAPrompt = `${baseContext}\n\n` +
        'You are Agent A. Explore the codebase using Read/Glob/Grep tools. ' +
        'Propose a detailed implementation strategy for this ticket. ' +
        'List every file to change, what to change, and in what order. ' +
        'For core logic changes, provide exact code snippets. ' +
        'For boilerplate, provide directional guidance.';
      if (initialFeedback) {
        agentAPrompt += `\n\n## Previous Feedback\n${initialFeedback}`;
      }
    } else {
      agentAPrompt = `${baseContext}\n\n` +
        '## Your Previous Proposal\n' + agentAOutput + '\n\n' +
        '## Agent B\'s Critique\n' + agentBOutput + '\n\n' +
        'Agent B critiqued your approach. Respond to their points. ' +
        'Revise your strategy or defend it with evidence from the codebase. ' +
        'Converge toward a final unified plan.';
    }

    log(`[Round ${round}] Running Agent A...`);
    try {
      const aResult = await runAI({
        prompt: agentAPrompt,
        workingDir: cloneDir,
        mode: 'debate',
        label: `debate-r${round}-a`,
        logDir: config.agent.logDir,
        ticketKey,
        config,
      });
      agentAOutput = aResult.output || '';

      if (isGarbageOutput(agentAOutput)) {
        warn(`Agent A round ${round} produced garbage output`);
      }

      if (aResult.rateLimited) {
        warn(`Agent A rate limited in round ${round}`);
        break;
      }
    } catch (err) {
      warn(`Agent A failed in round ${round}: ${err.message}`);
      break;
    }

    if (checkpointDir) {
      saveRoundOutput(checkpointDir, round, 'a', agentAOutput);
    }

    // --- Agent B ---
    let agentBPrompt;
    if (round === 1) {
      agentBPrompt = `${baseContext}\n\n` +
        '## Agent A\'s Proposal\n' + agentAOutput + '\n\n' +
        'You are Agent B. Read Agent A\'s proposal. ' +
        'Explore the codebase to verify their claims. ' +
        'Critique: what did they miss? What\'s wrong? What\'s a better approach? ' +
        'Propose your own complete strategy.';
    } else {
      agentBPrompt = `${baseContext}\n\n` +
        '## Agent A\'s Latest Proposal\n' + agentAOutput + '\n\n' +
        '## Your Previous Critique\n' + agentBOutput + '\n\n' +
        'Agent A responded. Continue refining. ' +
        'Focus on producing a final cheatsheet.';
    }

    log(`[Round ${round}] Running Agent B...`);
    try {
      const bResult = await runAI({
        prompt: agentBPrompt,
        workingDir: cloneDir,
        mode: 'debate',
        label: `debate-r${round}-b`,
        logDir: config.agent.logDir,
        ticketKey,
        config,
      });
      agentBOutput = bResult.output || '';

      if (isGarbageOutput(agentBOutput)) {
        warn(`Agent B round ${round} produced garbage output`);
      }

      if (bResult.rateLimited) {
        warn(`Agent B rate limited in round ${round}`);
        break;
      }
    } catch (err) {
      warn(`Agent B failed in round ${round}: ${err.message}`);
      break;
    }

    if (checkpointDir) {
      saveRoundOutput(checkpointDir, round, 'b', agentBOutput);
    }

    // Combine debate output for evaluation
    lastDebateOutput = `## Agent A's Final Proposal\n\n${agentAOutput}\n\n## Agent B's Final Position\n\n${agentBOutput}`;

    // --- Evaluate ---
    log(`[Round ${round}] Evaluating debate output...`);
    const isLastRound = round === maxRounds;
    const evalResult = await evaluate(lastDebateOutput, ticketContext, config, {
      force: isLastRound,
      ticketKey,
    });

    if (evalResult.passed) {
      log(`Debate approved after round ${round}`);
      return {
        passed: true,
        cheatsheet: evalResult.cheatsheet,
        feedback: null,
        rounds: round,
      };
    }

    if (!isLastRound) {
      log(`Debate round ${round} rejected: ${evalResult.feedback}`);
    }
  }

  // Max rounds exhausted — force evaluator in last-resort mode
  if (lastDebateOutput) {
    log('Max debate rounds reached. Forcing best-effort cheatsheet...');
    const forceResult = await evaluate(lastDebateOutput, ticketContext, config, {
      force: true,
      ticketKey,
    });
    if (forceResult.cheatsheet) {
      return {
        passed: true,
        cheatsheet: forceResult.cheatsheet,
        feedback: 'Forced after max rounds',
        rounds: maxRounds,
      };
    }
  }

  return {
    passed: false,
    cheatsheet: null,
    feedback: 'Debate failed to produce an acceptable cheatsheet',
    rounds: maxRounds,
  };
}
