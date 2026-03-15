import fs from 'fs';
import path from 'path';
import { cloneAndBranch } from '../../service/index.js';
import { execute } from '../../prompt/index.js';
import { STEP_NUMBER_BY_PHASE } from '../core/support.js';

export const STEP_STATUS = Object.freeze({ OK: 'ok', FAIL: 'fail' });

export function stepOk(data = {}) {
  return { status: STEP_STATUS.OK, ...data };
}

export function stepFail(error, data = {}) {
  return { status: STEP_STATUS.FAIL, error, ...data };
}

export const SERVICE_STEP_HANDLERS = Object.freeze([
  runCloneStep,
  runExecuteStep,
]);

async function runCloneStep(context) {
  const { logger, serviceTarget, ticketKey, ticket } = context;
  const { startStep, endStep, log } = logger;
  const { serviceConfig, repoUrl, baseBranch, version } = serviceTarget;

  startStep(STEP_NUMBER_BY_PHASE.CLONE_REPO, `Clone ${serviceConfig.repo} (${baseBranch})`);
  const cloneResult = await cloneAndBranch(repoUrl, baseBranch, ticketKey, ticket.summary, version);

  context.tmpDir = cloneResult.tmpDir;
  context.featureBranch = cloneResult.featureBranch;

  const pnpmLockPath = path.join(cloneResult.tmpDir, 'pnpm-lock.yaml');
  if (!fs.existsSync(pnpmLockPath)) {
    endStep(false, 'No pnpm-lock.yaml found — only pnpm projects are supported');
    return stepFail('No pnpm-lock.yaml found — only pnpm projects are supported');
  }

  log(`Feature branch: ${context.featureBranch}`);
  endStep(true, `Branch created: ${context.featureBranch}`);

  return stepOk();
}

async function runExecuteStep(context) {
  const { logger, serviceTarget, ticket, tmpDir, config, ticketKey, featureBranch } = context;
  const { startStep, endStep, warn } = logger;

  startStep(STEP_NUMBER_BY_PHASE.EXECUTE, `Execute for ${serviceTarget.serviceConfig.repo}/${serviceTarget.baseBranch}`);

  const ship = {
    featureBranch,
    baseBranch: serviceTarget.baseBranch,
    repoName: serviceTarget.serviceConfig.repo,
    org: config.azureDevOps.org,
    project: config.azureDevOps.project,
    ticketKey,
    ticketSummary: ticket.summary,
  };

  const execResult = await execute(ticket, tmpDir, config, { ticketKey, ship });

  if (execResult.status === 'failed') {
    warn(`Executor failed: ${execResult.reason}`);
    endStep(false, execResult.reason);
    return stepFail(execResult.reason);
  }

  const pr = parsePrFromOutput(execResult.output, serviceTarget.baseBranch);
  endStep(true, pr ? `PR created: ${pr.prUrl}` : 'Execution complete (no PR URL found in output)');
  return stepOk({ pr });
}

function parsePrFromOutput(output, baseBranch) {
  if (!output) return null;
  const match = output.match(/\*\*PR URL:\*\*\s*(https?:\/\/[^\s\n]+)/);
  if (!match) return null;
  const prUrl = match[1].trim();
  const idMatch = prUrl.match(/\/pullrequest\/(\d+)/i);
  return { prId: idMatch ? idMatch[1] : null, prUrl, baseBranch };
}
