import { notifySlackSuccess, notifySlackFailure, notifySlackBailout } from '../../notification/index.js';
import { bundleRunArtifact } from '../core/bundler.js';
import { STEP_NUMBER_BY_PHASE, runNonBlocking } from '../core/support.js';

export async function buildArtifactPhase({ ticketKey, artifactDir, logger }) {
  const runLogPaths = logger.getRunLogPaths();
  const bundle = await bundleRunArtifact(ticketKey, artifactDir, runLogPaths);
  return bundle.url || null;
}

export async function publishOutcomePhase({ config, ticketKey, ticket, prs, failures, artifactUrl, logger }) {
  const { startStep, endStep, warn } = logger;

  startStep(STEP_NUMBER_BY_PHASE.NOTIFY, 'Send Slack notification');

  if (prs.length === 0) {
    warn('No PRs created');
    endStep(false, 'No PRs created');
    return { success: false, reason: 'no_prs_created' };
  }

  await notifySlackSuccess(config, ticketKey, ticket.summary, prs, failures, artifactUrl);

  endStep(true, 'Slack notification sent');
  return { success: true, prs };
}

export async function notifyBailoutPhase({ config, ticketKey, ticket, bailout, artifactUrl, logger }) {
  const { startStep, endStep } = logger;

  startStep(STEP_NUMBER_BY_PHASE.NOTIFY, 'Send bailout notification');
  await runNonBlocking('Failed to send bailout notification', async () => {
    await notifySlackBailout(config, ticketKey, ticket, bailout, artifactUrl);
  });
  endStep(true, 'Bailout notification sent');
}

export async function notifyFailurePhase({ config, ticketKey, error, logger }) {
  let artifactUrl = null;
  await runNonBlocking('Artifact bundling failed in error handler', async () => {
    const artifactDir = config._artifactDir;
    if (!artifactDir) return;
    const failBundle = await bundleRunArtifact(ticketKey, artifactDir, logger.getRunLogPaths());
    artifactUrl = failBundle.url || null;
  });

  await runNonBlocking('Failed to send failure notification', async () => {
    await notifySlackFailure(config, ticketKey, { key: ticketKey, summary: ticketKey }, error, artifactUrl);
  });
}
