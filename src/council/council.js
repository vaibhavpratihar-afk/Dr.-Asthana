/**
 * Council — a group of AI agents that collaborate, discuss, and produce
 * actionable outputs. Discussions happen via files for full visibility.
 * Agents have session memory to avoid rework across rounds.
 *
 * Flow per round:
 *   1. Proposer (agent-0): proposes strategy (round 1) or revises (round 2+)
 *   2. Critics (agent-1..N): each critiques, sees prior critics' outputs
 *   3. Agreement: proposer synthesizes critiques → AGREED/DISAGREE
 *   4. Evaluate: structural + AI quality gate
 *
 * The caller defines: goal, context, role instructions, evaluation criteria,
 * and output format. The council handles the rest.
 */

import { isGarbageOutput } from '../ai-provider/provider.js';
import { runAgent } from './runner.js';
import { evaluate } from './evaluator.js';
import { initWorkspace, writeRoundFile, updateStatus, checkHumanFeedback } from './workspace.js';
import { log, warn } from '../utils/logger.js';

/**
 * Create a configured council instance.
 *
 * @param {object} opts
 * @param {string} opts.goal - What the council should achieve
 * @param {string} opts.context - All context the agents need
 * @param {string} opts.workingDir - Working directory for tool access
 * @param {{proposer: string, critic: string, agreement?: string}} opts.roles - Role instructions
 * @param {object} opts.prompts - Prompt builder functions (owned by caller)
 * @param {function} opts.prompts.buildProposer - (round, baseContext, proposerOutput, criticOutputs, role, feedback) => string
 * @param {function} opts.prompts.buildCritic - (round, baseContext, proposerOutput, criticOutputs, criticIndex, role) => string
 * @param {function} opts.prompts.buildAgreement - (baseContext, proposerOutput, criticOutputs, agreementRole) => string
 * @param {object} opts.evaluation - Evaluation configuration
 * @param {function} [opts.evaluation.structural] - (output) => {passed, feedback}
 * @param {function} opts.evaluation.buildAiPrompt - (councilOutput, context, force) => prompt
 * @param {{start: string, end: string}} opts.evaluation.outputMarkers - Extraction markers
 * @param {string} [opts.evaluation.approvalKeyword] - Default: 'APPROVED'
 * @param {string} [opts.evaluation.rejectionKeyword] - Default: 'REJECTED'
 * @param {string} [opts.evaluation.feedbackMarker] - Default: '=== FEEDBACK ==='
 * @param {boolean} [opts.evaluation.forceOnLastRound] - Default: true
 * @param {object} opts.config - Full config object (aiProvider section used)
 * @param {string} opts.label - Label for logs and workspace files
 * @param {string} [opts.checkpointDir] - Directory for workspace artifacts
 * @param {string} [opts.feedback] - Initial feedback from prior failed run
 * @returns {{run: function(): Promise<{passed: boolean, output: string|null, feedback: string|null, rounds: number}>}}
 */
export function createCouncil(opts) {
  const {
    goal,
    context,
    workingDir,
    roles,
    prompts,
    evaluation,
    config,
    label = 'council',
    checkpointDir,
    feedback,
  } = opts;

  if (!goal) throw new Error('Council requires a goal');
  if (!context) throw new Error('Council requires context');
  if (!roles?.proposer) throw new Error('Council requires roles.proposer');
  if (!roles?.critic) throw new Error('Council requires roles.critic');
  if (!prompts?.buildProposer) throw new Error('Council requires prompts.buildProposer');
  if (!prompts?.buildCritic) throw new Error('Council requires prompts.buildCritic');
  if (!prompts?.buildAgreement) throw new Error('Council requires prompts.buildAgreement');
  if (!evaluation?.buildAiPrompt) throw new Error('Council requires evaluation.buildAiPrompt');
  if (!evaluation?.outputMarkers) throw new Error('Council requires evaluation.outputMarkers');
  if (!config) throw new Error('Council requires config');

  return {
    run: () => runCouncil({
      goal,
      context,
      workingDir,
      roles,
      prompts,
      evaluation,
      config,
      label,
      checkpointDir,
      initialFeedback: feedback,
    }),
  };
}

// --- Internal orchestrator ---

async function runCouncil({ goal, context, workingDir, roles, prompts, evaluation, config, label, checkpointDir, initialFeedback }) {
  const debateConfig = config.aiProvider?.debate || {};
  const maxRounds = debateConfig.maxRounds || 3;

  const agents = resolveAgents(debateConfig);
  const useProviderConfig = Array.isArray(debateConfig.debaters) && debateConfig.debaters.length >= 2;

  log(`Council: ${agents.length} agents, ${maxRounds} max rounds, goal: ${goal.substring(0, 80)}...`);
  for (let i = 0; i < agents.length; i++) {
    log(`  agent-${i}: provider=${agents[i].provider}, model=${agents[i].model || 'default'}${i === 0 ? ' (proposer)' : ' (critic)'}`);
  }

  const baseContext = `${context}\n\n## Goal\n\n${goal}`;
  const workspace = initWorkspace(checkpointDir, label, maxRounds);
  const sessions = new Map(); // Agent memory — session IDs persist across rounds
  const agentOpts = { agents, useProviderConfig, sessions, config, councilLabel: label, workingDir };

  let proposerOutput = '';
  let criticOutputs = [];
  let lastCouncilOutput = '';

  for (let round = 1; round <= maxRounds; round++) {
    log(`=== Council Round ${round}/${maxRounds} ===`);

    // --- Proposer ---
    updateStatus(workspace, label, maxRounds, round, 'agent-0');
    const proposerPrompt = appendHumanFeedback(
      prompts.buildProposer(round, baseContext, proposerOutput, criticOutputs, roles.proposer, initialFeedback),
      workspace,
    );

    log(`[Round ${round}] Running Proposer (agent-0)...${sessions.has(0) ? ' (resuming session)' : ''}`);
    const pRes = await runAgent({ prompt: proposerPrompt, label: `council-r${round}-agent-0`, agentIndex: 0, ...agentOpts });
    if (pRes.failed) { warn(`Proposer failed in round ${round}`); break; }
    if (pRes.rateLimited) { warn(`Proposer rate limited in round ${round}`); break; }
    proposerOutput = pRes.output;
    if (isGarbageOutput(proposerOutput)) warn(`Proposer round ${round} produced garbage output`);
    writeRoundFile(workspace, round, 'agent-0-proposal.md', proposerOutput);

    // --- Critics ---
    criticOutputs = [];
    let criticsSkipped = 0;

    for (let ci = 1; ci < agents.length; ci++) {
      updateStatus(workspace, label, maxRounds, round, `agent-${ci}`);
      const criticPrompt = appendHumanFeedback(
        prompts.buildCritic(round, baseContext, proposerOutput, criticOutputs, ci, roles.critic),
        workspace,
      );

      log(`[Round ${round}] Running Critic ${ci} (agent-${ci})...${sessions.has(ci) ? ' (resuming session)' : ''}`);
      const cRes = await runAgent({ prompt: criticPrompt, label: `council-r${round}-agent-${ci}`, agentIndex: ci, ...agentOpts });

      if (cRes.failed || cRes.rateLimited || isGarbageOutput(cRes.output)) {
        warn(`Critic ${ci} round ${round} ${cRes.rateLimited ? 'rate limited' : cRes.failed ? 'failed' : 'produced garbage output'}, skipping`);
        criticsSkipped++;
        continue;
      }

      criticOutputs.push({ index: ci, output: cRes.output });
      writeRoundFile(workspace, round, `agent-${ci}-critique.md`, cRes.output);
    }

    if (criticsSkipped > 0) {
      log(`[Round ${round}] ${criticsSkipped} critic(s) skipped, ${criticOutputs.length} succeeded`);
    }

    // --- Agreement Check ---
    if (criticOutputs.length === 0) {
      warn(`[Round ${round}] No critics succeeded, using proposer output directly for evaluation`);
      lastCouncilOutput = `## Proposal (Proposer Only)\n\n${proposerOutput}`;
    } else {
      updateStatus(workspace, label, maxRounds, round, 'agreement');
      const agreementPrompt = appendHumanFeedback(
        prompts.buildAgreement(baseContext, proposerOutput, criticOutputs, roles.agreement),
        workspace,
      );

      log(`[Round ${round}] Running agreement check...${sessions.has(0) ? ' (resuming proposer session)' : ''}`);
      const agRes = await runAgent({ prompt: agreementPrompt, label: `council-r${round}-agreement`, agentIndex: 0, ...agentOpts });

      if (agRes.failed) { warn(`Agreement check failed in round ${round}`); break; }
      if (agRes.rateLimited) { warn(`Agreement check rate limited in round ${round}`); break; }
      if (isGarbageOutput(agRes.output)) warn(`Agreement check round ${round} produced garbage output`);

      const agreed = /^\s*AGREED/i.test(agRes.output);
      writeRoundFile(workspace, round, 'agreement.md', `${agreed ? 'AGREED' : 'DISAGREE'}\n\n${agRes.output}`);

      if (agreed) {
        lastCouncilOutput = `## Unified Plan (Agreed)\n\n${agRes.output}`;
      } else {
        const criticSummary = criticOutputs.map(c => `## Critic ${c.index}'s Position\n\n${c.output}`).join('\n\n');
        lastCouncilOutput = `## Proposer's Final Proposal\n\n${proposerOutput}\n\n${criticSummary}\n\n## Disagreement\n\n${agRes.output}`;
        proposerOutput = agRes.output;
      }

      if (!agreed && round < maxRounds) {
        log(`[Round ${round}] Agents disagree, continuing to next round...`);
        continue;
      }
    }

    // --- Evaluate ---
    const isLastRound = round === maxRounds;
    const forceEval = isLastRound && (evaluation.forceOnLastRound !== false);
    updateStatus(workspace, label, maxRounds, round, 'evaluating', { agreed: criticOutputs.length === 0 ? undefined : /AGREED/i.test(lastCouncilOutput) });

    log(`[Round ${round}] Evaluating council output${forceEval && !/Agreed/.test(lastCouncilOutput) ? ' (forced, last round)' : ''}...`);
    const evalResult = await evaluate(lastCouncilOutput, {
      ...evaluation,
      context,
      config,
      label,
    }, forceEval);

    writeRoundFile(workspace, round, 'evaluation.md',
      `# Evaluation\n\n**Passed:** ${evalResult.passed}\n\n${evalResult.feedback || evalResult.output || ''}`);

    if (evalResult.passed) {
      log(`Council approved after round ${round}`);
      updateStatus(workspace, label, maxRounds, round, 'done', { agreed: true, result: 'passed' });
      return { passed: true, output: evalResult.output, feedback: null, rounds: round };
    }

    if (!isLastRound) {
      log(`Council round ${round} rejected: ${evalResult.feedback}`);
    }
  }

  // Max rounds exhausted — force evaluator in last-resort mode
  if (lastCouncilOutput) {
    log('Max council rounds reached. Forcing best-effort output...');
    const forceResult = await evaluate(lastCouncilOutput, {
      ...evaluation,
      context,
      config,
      label,
    }, true);
    if (forceResult.output) {
      updateStatus(workspace, label, maxRounds, maxRounds, 'done', { result: 'forced-pass' });
      return { passed: true, output: forceResult.output, feedback: 'Forced after max rounds', rounds: maxRounds };
    }
  }

  updateStatus(workspace, label, maxRounds, maxRounds, 'done', { result: 'failed' });
  return { passed: false, output: null, feedback: 'Council failed to produce acceptable output', rounds: maxRounds };
}

// --- Human-in-the-loop ---

function appendHumanFeedback(prompt, workspace) {
  const feedback = checkHumanFeedback(workspace);
  return feedback ? `${prompt}\n\n## Human Feedback\n${feedback}` : prompt;
}

// --- Config helpers ---

/**
 * Resolve agent list from config.
 * If debaters[] array exists, use it (minimum 2 enforced).
 * Otherwise build 2-element array from legacy config.
 */
function resolveAgents(debateConfig) {
  if (Array.isArray(debateConfig.debaters) && debateConfig.debaters.length >= 2) {
    return debateConfig.debaters;
  }
  const provider = debateConfig.provider || 'claude';
  const providerSettings = debateConfig[provider] || {};
  return [
    { provider, ...providerSettings },
    { provider, ...providerSettings },
  ];
}
