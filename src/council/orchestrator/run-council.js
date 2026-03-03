/**
 * Council Orchestrator - file-backed facade with markdown/json state transfer.
 *
 * Responsibility:
 * - Run proposer -> critics -> agreement -> evaluation pipeline per round.
 * - Use shared artifacts as the only cross-member state channel.
 */

import { evaluate } from '../evaluator/evaluator.js';
import fs from 'fs';
import path from 'path';
import { resolveAgents } from '../config/agents.js';
import { initWorkspace, updateStatus } from '../runtime/workspace.js';
import { initArtifacts, roundArtifacts } from '../runtime/artifacts.js';
import { readJson, readText } from '../runtime/files.js';
import { runProposerStage } from '../stages/proposer.js';
import { runCriticsStage } from '../stages/critics.js';
import { runAgreementStage } from '../stages/agreement.js';
import { runEvaluationStage } from '../stages/evaluation.js';
import { log } from '../../utils/logger.js';

const DEFAULT_POLICY = Object.freeze({ failClosed: true, forceBestEffortOnMaxRounds: false });
const withWriteTool = (allowedTools) => (!allowedTools ? 'Read,Write,Glob,Grep' : (allowedTools.includes('Write') ? allowedTools : `${allowedTools},Write`));

const readPolicy = (councilConfig = {}) => ({
  failClosed: councilConfig.failClosed !== false,
  forceBestEffortOnMaxRounds: councilConfig.forceBestEffortOnMaxRounds === true,
});

const buildFailure = (rounds) => ({ passed: false, output: null, feedback: 'Council failed to produce acceptable output', rounds });

const buildRuntime = ({ evaluation, context, config, label, workspace, workingDir, agents }) => {
  const sessions = new Map();
  return {
    sessions,
    agentsWithWrite: agents.map((agent) => ({ ...agent, allowedTools: withWriteTool(agent.allowedTools) })),
    agentOpts: { agents, sessions, config, councilLabel: label, workingDir },
    evalOpts: { ...evaluation, context, config, label, workspace, workingDir },
  };
};

const logAgents = (agents, maxRounds, goal) => {
  log(`Council: ${agents.length} agents, ${maxRounds} max rounds, goal: ${goal.substring(0, 80)}...`);
  for (let i = 0; i < agents.length; i++) log(`  agent-${i}: provider=${agents[i].provider}, model=${agents[i].model || 'default'} (${i === 0 ? 'proposer' : 'critic'})`);
};

const runRound = async ({ round, maxRounds, label, workspace, baseContext, roles, prompts, runtime, artifacts, initialFeedback }) => {
  const stageBase = {
    round,
    workspace,
    label,
    maxRounds,
    prompts,
    baseContext,
    roles,
    sessions: runtime.sessions,
    artifacts,
  };

  const proposer = await runProposerStage({ ...stageBase, initialFeedback, agentOpts: { ...runtime.agentOpts, agents: runtime.agentsWithWrite } });
  if (!proposer.ok) return { done: true, passed: false, reason: proposer.reason };

  const critics = await runCriticsStage({ ...stageBase, agents: runtime.agentsWithWrite, agentOpts: { ...runtime.agentOpts, agents: runtime.agentsWithWrite } });
  if (!critics.ok) return { done: true, passed: false, reason: critics.reason };

  const agreement = await runAgreementStage({ ...stageBase, agentOpts: { ...runtime.agentOpts, agents: runtime.agentsWithWrite } });
  if (!agreement.ok) return { done: true, passed: false, reason: agreement.reason };

  const agreementControl = readJson(artifacts.round.control, {});
  if (agreementControl.nextAction === 'next_round') return { done: false, passed: false, reason: 'agreement_disagreed' };

  const evaluation = await runEvaluationStage({
    round,
    maxRounds,
    workspace,
    label,
    evalOpts: runtime.evalOpts,
    isLastRound: round === maxRounds,
    artifacts,
  });
  if (!evaluation.ok) return { done: true, passed: false, reason: evaluation.reason };

  return evaluation.data.evaluation.passed
    ? { done: true, passed: true, output: evaluation.data.evaluation.output }
    : { done: false, passed: false, reason: 'evaluation_rejected' };
};

const forceBestEffort = async ({ policy, artifacts, runtime, label, workspace, maxRounds }) => {
  if (!policy.forceBestEffortOnMaxRounds) return null;
  const lastAgreementPath = roundArtifacts(artifacts, maxRounds, Math.max(runtime.agentsWithWrite.length - 1, 0)).files.agreement;
  const fallbackSource = readText(lastAgreementPath, '');
  if (!fallbackSource.trim()) return null;
  const forceResult = await evaluate(fallbackSource, runtime.evalOpts, true);
  if (!forceResult.output) return null;
  updateStatus(workspace, label, maxRounds, maxRounds, 'done', { result: 'forced-pass' });
  return { passed: true, output: forceResult.output, feedback: 'Forced after max rounds', rounds: maxRounds };
};

export async function runCouncil({ goal, context, workingDir, roles, prompts, evaluation, config, label, checkpointDir, initialFeedback }) {
  const councilConfig = config.council || {};
  const maxRounds = councilConfig.maxRounds || 3;
  const policy = readPolicy(councilConfig);
  const agents = resolveAgents(councilConfig);
  const workspace = initWorkspace(checkpointDir, label, maxRounds)
    || path.join(workingDir || process.cwd(), '.council-workspace', label);
  fs.mkdirSync(workspace, { recursive: true });
  const artifacts = initArtifacts({ workspace, goal, context, roles });
  const runtime = buildRuntime({ evaluation, context, config, label, workspace, workingDir, agents });
  const baseContext = `Use shared artifact files under \`${workspace}\` as single source of truth.\n\nYour working directory is \`${workingDir}\`. Use it for all source code reads and git verification. Paths in ticket context may reference the developer's local clone — always verify against your own working directory instead.`;

  logAgents(agents, maxRounds, goal);

  for (let round = 1; round <= maxRounds; round++) {
    log(`=== Council Round ${round}/${maxRounds} ===`);
    const current = { shared: artifacts.files, round: roundArtifacts(artifacts, round, Math.max(agents.length - 1, 0)).files };
    const outcome = await runRound({
      round,
      maxRounds,
      label,
      workspace,
      baseContext,
      roles,
      prompts,
      runtime,
      artifacts: current,
      initialFeedback,
    });

    if (outcome.done && outcome.passed) return { passed: true, output: outcome.output, feedback: null, rounds: round };
    if (outcome.done && !outcome.passed) break;
    log(`[Round ${round}] ${outcome.reason}; continuing.`);
  }

  const forced = await forceBestEffort({ policy, artifacts, runtime, label, workspace, maxRounds });
  if (forced) return forced;
  if (policy.failClosed) log('Max rounds reached without evaluator approval. Failing closed.');
  updateStatus(workspace, label, maxRounds, maxRounds, 'done', { result: 'failed' });
  return buildFailure(maxRounds);
}
