/**
 * Council Factory - validates setup and returns runnable council instance.
 *
 * Responsibility:
 * - Validate required caller inputs once.
 * - Provide a thin { run() } API that delegates orchestration.
 *
 * Contract:
 * - Throws early if required fields are missing.
 * - Does not execute any stage work until run() is called.
 */

import { runCouncil } from './orchestrator/run-council.js';
import { warn } from '../utils/logger.js';

const REQUIRED_PATHS = Object.freeze([
  'goal',
  'context',
  'roles.proposer',
  'roles.critic',
  'prompts.buildProposer',
  'prompts.buildCritic',
  'evaluation.buildAiPrompt',
  'evaluation.outputMarkers',
  'config',
]);

/**
 * Create a configured council instance.
 *
 * @param {object} opts
 * @param {string} opts.goal - What the council should achieve
 * @param {string} opts.context - All context the agents need
 * @param {string} opts.workingDir - Working directory for tool access
 * @param {{proposer: string, critic: string}} opts.roles - Role instructions
 * @param {object} opts.prompts - Prompt builder functions (owned by caller)
 * @param {function} opts.prompts.buildProposer - (round, baseContext, proposerOutput, criticOutputs, role, feedback) => string
 * @param {function} opts.prompts.buildCritic - (round, baseContext, proposerOutput, criticOutputs, criticIndex, role) => string
 * @param {object} opts.evaluation - Evaluation configuration
 * @param {function} [opts.evaluation.structural] - (output) => {passed, feedback}
 * @param {function} opts.evaluation.buildAiPrompt - (councilOutput, context, force) => prompt
 * @param {{start: string, end: string}} opts.evaluation.outputMarkers - Extraction markers
 * @param {string} [opts.evaluation.approvalKeyword] - Default: 'APPROVED'
 * @param {string} [opts.evaluation.rejectionKeyword] - Default: 'REJECTED'
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
  } = opts || {};

  const root = { goal, context, roles, prompts, evaluation, config };
  const missing = findMissingRequiredPaths(root, REQUIRED_PATHS);
  if (missing.length > 0) throw new Error(`Council requires: ${missing.join(', ')}`);
  if (!workingDir) warn('Council created without workingDir; tooling may run in process cwd');

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

const findMissingRequiredPaths = (root, requiredPaths) => requiredPaths.filter((fieldPath) => !readPath(root, fieldPath));
const readPath = (target, fieldPath) => fieldPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), target);
