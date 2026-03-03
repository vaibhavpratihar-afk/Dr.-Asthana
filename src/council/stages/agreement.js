/**
 * Agreement Stage - writes round decision from proposer arbitration.
 *
 * Responsibility:
 * - Run agreement prompt with full shared artifact access.
 * - Persist markdown output and deterministic control decision JSON.
 */

import fs from 'fs';
import path from 'path';
import { isGarbageOutput } from '../../ai-provider/provider.js';
import { runAgent } from '../runtime/runner.js';
import { buildAgreementContractPrompt, readAgreementContract } from '../contract/index.js';
import { appendHumanFeedback } from '../utils/feedback.js';
import { updateStatus } from '../runtime/workspace.js';
import { appendText, readText, writeJson, writeText } from '../runtime/files.js';
import { log, warn } from '../../utils/logger.js';

const AGREED = 'AGREED';
const DISAGREE = 'DISAGREE';
const addWriteTool = (allowedTools) => (!allowedTools ? 'Read,Write,Glob,Grep' : (allowedTools.includes('Write') ? allowedTools : `${allowedTools},Write`));
const stageSuccess = (reason, data = {}) => ({ ok: true, reason, data });
const stageFailure = (reason) => ({ ok: false, reason, data: {} });
const roundMeta = (round, maxRounds, artifacts) => ({ round, maxRounds, roundsLeft: Math.max(maxRounds - round, 0), artifacts });

const appendDecisionLog = (shared, round, body) => appendText(shared.decisions, `\n## Round ${round} - agreement\n\n${body}\n`);

const resolveContractPath = ({ workspace, round }) =>
  path.join(workspace, `rounds/round-${round}/agreement-contract.json`);

const resetContract = (contractPath) => {
  try { fs.unlinkSync(contractPath); } catch { /* ignore */ }
};

const readDecision = ({ output, contractPath, round }) => {
  const parsed = readAgreementContract(contractPath);
  if (parsed.valid) {
    log(`[Round ${round}] Agreement via contract: ${parsed.decision}`);
    return parsed.decision;
  }
  warn(`[Round ${round}] Agreement contract invalid (${parsed.reason}); using regex fallback`);
  return /^\s*AGREED/i.test(output) ? AGREED : DISAGREE;
};

export async function runAgreementStage({ round, workspace, label, maxRounds, prompts, baseContext, roles, agentOpts, sessions, artifacts }) {
  updateStatus(workspace, label, maxRounds, round, 'agreement');
  const contractPath = resolveContractPath({ workspace, round });
  resetContract(contractPath);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });

  const prompt = `${appendHumanFeedback(
    prompts.buildAgreement(baseContext, '', [], roles.agreement, roundMeta(round, maxRounds, artifacts)),
    workspace,
  )}${buildAgreementContractPrompt(contractPath)}`;

  const agents = agentOpts.agents.map((agent, index) => (index === 0 ? { ...agent, allowedTools: addWriteTool(agent.allowedTools) } : agent));
  log(`[Round ${round}] Running agreement check...${sessions.has(0) ? ' (resuming proposer session)' : ''}`);
  const result = await runAgent({ prompt, label: `council-r${round}-agreement`, agentIndex: 0, ...agentOpts, agents });
  if (result.rateLimited) return stageFailure('agreement_rate_limited');
  if (result.failed) return stageFailure('agreement_failed');

  if (isGarbageOutput(result.output)) warn(`Agreement round ${round} produced garbage output`);
  const decision = readDecision({ output: result.output, contractPath, round });
  const nextAction = decision === AGREED ? 'evaluate' : 'next_round';
  // Preserve agent-written artifact; fall back to stdout capture if empty.
  const existing = readText(artifacts.round.agreement, '');
  if (!existing.trim()) writeText(artifacts.round.agreement, `${decision}\n\n${result.output}`);
  writeJson(artifacts.round.control, { round, agreementDecision: decision, nextAction });
  appendDecisionLog(artifacts.shared, round, `Decision: ${decision}. Next action: ${nextAction}.`);
  return stageSuccess('agreement_recorded', { decision, nextAction });
}
