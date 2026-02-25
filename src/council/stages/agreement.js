/**
 * Agreement stage.
 *
 * Synthesizes proposer + critic outputs into AGREED/DISAGREE and decides if
 * the council should evaluate now or continue to the next round.
 */

import { isGarbageOutput } from '../../ai-provider/provider.js';
import { runAgent } from '../runtime/runner.js';
import { appendHumanFeedback } from '../utils/feedback.js';
import { updateStatus, writeRoundFile } from '../runtime/workspace.js';
import { log, warn } from '../../utils/logger.js';

/**
 * Execute agreement stage.
 *
 * @returns {Promise<{
 *   halt: boolean,
 *   continueNextRound?: boolean,
 *   lastCouncilOutput?: string,
 *   nextProposerOutput?: string|null,
 * }>}
 */
export async function runAgreementStage({ round, workspace, label, maxRounds, prompts, baseContext, proposerOutput, criticOutputs, roles, agentOpts, sessions }) {
  if (criticOutputs.length === 0) {
    warn(`[Round ${round}] No critics succeeded, using proposer output directly for evaluation`);
    return {
      halt: false,
      continueNextRound: false,
      lastCouncilOutput: `## Proposal (Proposer Only)\n\n${proposerOutput}`,
      nextProposerOutput: null,
    };
  }

  updateStatus(workspace, label, maxRounds, round, 'agreement');
  const prompt = appendHumanFeedback(prompts.buildAgreement(baseContext, proposerOutput, criticOutputs, roles.agreement), workspace);

  log(`[Round ${round}] Running agreement check...${sessions.has(0) ? ' (resuming proposer session)' : ''}`);
  const result = await runAgent({ prompt, label: `council-r${round}-agreement`, agentIndex: 0, ...agentOpts });
  if (result.failed) {
    warn(`Agreement check failed in round ${round}`);
    return { halt: true };
  }
  if (result.rateLimited) {
    warn(`Agreement check rate limited in round ${round}`);
    return { halt: true };
  }

  if (isGarbageOutput(result.output)) warn(`Agreement check round ${round} produced garbage output`);

  const agreed = /^\s*AGREED/i.test(result.output);
  writeRoundFile(workspace, round, 'agreement.md', `${agreed ? 'AGREED' : 'DISAGREE'}\n\n${result.output}`);
  if (agreed) {
    return {
      halt: false,
      continueNextRound: false,
      lastCouncilOutput: `## Unified Plan (Agreed)\n\n${result.output}`,
      nextProposerOutput: null,
    };
  }

  const criticSummary = criticOutputs.map((c) => `## Critic ${c.index}'s Position\n\n${c.output}`).join('\n\n');
  const lastCouncilOutput = `## Proposer's Final Proposal\n\n${proposerOutput}\n\n${criticSummary}\n\n## Disagreement\n\n${result.output}`;
  if (round < maxRounds) log(`[Round ${round}] Agents disagree, continuing to next round...`);

  return {
    halt: false,
    continueNextRound: round < maxRounds,
    lastCouncilOutput,
    nextProposerOutput: result.output,
  };
}
