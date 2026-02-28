/**
 * Proposer Stage - generates round proposal using shared artifact context.
 *
 * Responsibility:
 * - Run proposer agent with file-backed context references.
 * - Persist proposer markdown artifact for downstream members.
 */

import { isGarbageOutput } from '../../ai-provider/provider.js';
import { runAgent } from '../runtime/runner.js';
import { appendHumanFeedback } from '../utils/feedback.js';
import { updateStatus } from '../runtime/workspace.js';
import { appendText, writeText } from '../runtime/files.js';
import { log, warn } from '../../utils/logger.js';

const stageSuccess = (reason, data = {}) => ({ ok: true, reason, data });
const stageFailure = (reason) => ({ ok: false, reason, data: {} });
const roundMeta = (round, maxRounds, artifacts) => ({ round, maxRounds, roundsLeft: Math.max(maxRounds - round, 0), artifacts });

const appendDecisionLog = (shared, round, body) => appendText(shared.decisions, `\n## Round ${round} - proposer\n\n${body}\n`);

export async function runProposerStage({ round, workspace, label, maxRounds, prompts, baseContext, roles, initialFeedback, agentOpts, sessions, artifacts }) {
  updateStatus(workspace, label, maxRounds, round, 'agent-0');

  const prompt = appendHumanFeedback(
    prompts.buildProposer(round, baseContext, '', [], roles.proposer, initialFeedback, roundMeta(round, maxRounds, artifacts)),
    workspace,
  );

  log(`[Round ${round}] Running Proposer (agent-0)...${sessions.has(0) ? ' (resuming session)' : ''}`);
  const result = await runAgent({ prompt, label: `council-r${round}-agent-0`, agentIndex: 0, ...agentOpts });
  if (result.rateLimited) return stageFailure('proposer_rate_limited');
  if (result.failed) return stageFailure('proposer_failed');

  if (isGarbageOutput(result.output)) warn(`Proposer round ${round} produced garbage output`);
  writeText(artifacts.round.proposer, result.output);
  appendDecisionLog(artifacts.shared, round, `Proposal written to \`${artifacts.round.proposer}\`.`);
  return stageSuccess('proposal_ready', { proposalPath: artifacts.round.proposer });
}
