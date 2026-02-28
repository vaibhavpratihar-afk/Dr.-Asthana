/**
 * Critics Stage - sequential critic pass over shared file-backed artifacts.
 *
 * Responsibility:
 * - Run critics in order.
 * - Persist each critic markdown file for agreement/evaluator consumption.
 */

import { isGarbageOutput } from '../../ai-provider/provider.js';
import { runAgent } from '../runtime/runner.js';
import { appendHumanFeedback } from '../utils/feedback.js';
import { updateStatus } from '../runtime/workspace.js';
import { appendText, writeText } from '../runtime/files.js';
import { log, warn } from '../../utils/logger.js';

const stageSuccess = (reason, data = {}) => ({ ok: true, reason, data });
const roundMeta = (round, maxRounds, artifacts) => ({ round, maxRounds, roundsLeft: Math.max(maxRounds - round, 0), artifacts });

const appendDecisionLog = (shared, round, body) => appendText(shared.decisions, `\n## Round ${round} - critics\n\n${body}\n`);

export async function runCriticsStage({ round, workspace, label, maxRounds, prompts, baseContext, roles, agentOpts, sessions, agents, artifacts }) {
  let skipped = 0;
  const written = [];

  for (let ci = 1; ci < agents.length; ci++) {
    updateStatus(workspace, label, maxRounds, round, `agent-${ci}`);
    const criticFile = artifacts.round.critics[ci - 1];
    const prompt = appendHumanFeedback(
      prompts.buildCritic(round, baseContext, '', [], ci, roles.critic, roundMeta(round, maxRounds, { ...artifacts, round: { ...artifacts.round, criticCurrent: criticFile } })),
      workspace,
    );

    log(`[Round ${round}] Running Critic ${ci} (agent-${ci})...${sessions.has(ci) ? ' (resuming session)' : ''}`);
    const result = await runAgent({ prompt, label: `council-r${round}-agent-${ci}`, agentIndex: ci, ...agentOpts });
    if (result.failed || result.rateLimited || isGarbageOutput(result.output)) {
      warn(`Critic ${ci} round ${round} ${result.rateLimited ? 'rate limited' : result.failed ? 'failed' : 'produced garbage output'}, skipping`);
      skipped++;
      continue;
    }

    writeText(criticFile, result.output);
    written.push(criticFile);
  }

  appendDecisionLog(artifacts.shared, round, `Critic artifacts written: ${written.length}. Skipped: ${skipped}.`);
  return stageSuccess('critiques_collected', { criticFiles: written, skipped });
}
