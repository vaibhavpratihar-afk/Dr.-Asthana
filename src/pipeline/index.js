import { ensureArtifactDir, getTicketKey, resolveServiceTarget, toServiceFailure } from './core/support.js';
import {
  fetchTicketPhase,
  validateTicketPhase,
  processServiceBranchPhase,
  buildArtifactPhase,
  publishOutcomePhase,
  notifyFailurePhase,
} from './phases.js';
import * as logger from '../utils/logger.js';

const { log, ok, err, initRun, finalizeRun } = logger;

export async function runPipeline(config, ticketOrKey) {
  const ticketKey = getTicketKey(ticketOrKey);
  if (!ticketKey) throw new Error('runPipeline requires a ticket key');

  const prevTicketKey = config._currentTicketKey;
  const prevArtifactDir = config._artifactDir;
  config._currentTicketKey = ticketKey;

  const runId = initRun(ticketKey, config.agent.logDir);
  log(`Processing: ${ticketKey} (Run ID: ${runId})`);

  let didFinalize = false;
  const finalizeOnce = (success, summary) => {
    if (didFinalize) return;
    didFinalize = true;
    finalizeRun(success, summary);
  };

  try {
    const ticket = await fetchTicketPhase({ config, ticketKey, logger });
    const artifactDir = ensureArtifactDir(ticketKey, config);

    const validation = await validateTicketPhase({ config, ticketKey, ticket, logger });
    if (!validation.ok) {
      const reason = validation.errors.join('; ');
      await notifyFailurePhase({ config, ticketKey, error: new Error(reason), logger });
      finalizeOnce(false, 'Validation failed');
      return { success: false, reason: 'validation_failed', errors: validation.errors };
    }

    const serviceTarget = resolveServiceTarget(config, ticket);
    if (!serviceTarget.ok) {
      err(serviceTarget.reason);
      await notifyFailurePhase({ config, ticketKey, error: new Error(serviceTarget.reason), logger });
      finalizeOnce(false, serviceTarget.reason);
      return { success: false, reason: 'invalid_service_config', errors: [serviceTarget.reason] };
    }

    log(`\n--- Processing ${serviceTarget.serviceName} / ${serviceTarget.baseBranch} ---`);

    let branchResult;
    try {
      branchResult = await processServiceBranchPhase({ config, ticket, serviceTarget, ticketKey, logger });
    } catch (branchError) {
      err(`Failed to process ${serviceTarget.serviceName}/${serviceTarget.baseBranch}: ${branchError.message}`);
      branchResult = { pr: null, error: branchError.message };
    }

    const prs = branchResult.pr ? [{ service: serviceTarget.serviceName, ...branchResult.pr }] : [];
    const failures = branchResult.error
      ? [toServiceFailure(serviceTarget.serviceName, serviceTarget.baseBranch, branchResult.error)]
      : [];

    const artifactUrl = await buildArtifactPhase({ ticketKey, artifactDir, logger });
    const outcome = await publishOutcomePhase({ config, ticketKey, ticket, prs, failures, artifactUrl, logger });

    if (!outcome.success) {
      const failureReason = failures[0]?.error || 'No PRs created';
      await notifyFailurePhase({ config, ticketKey, error: new Error(failureReason), logger });
      finalizeOnce(false, 'No PRs created');
      return outcome;
    }

    ok(`Successfully processed ${ticketKey} — ${prs.length} PR(s) created`);
    finalizeOnce(true, `${prs.length} PR(s) created`);
    return outcome;
  } catch (error) {
    err(`Error processing ${ticketKey}: ${error.message}`);
    err(`Stack trace: ${error.stack}`);
    await notifyFailurePhase({ config, ticketKey, error, logger });
    finalizeOnce(false, `Error: ${error.message}`);
    return { success: false, reason: 'error', error: error.message };
  } finally {
    config._currentTicketKey = prevTicketKey;
    config._artifactDir = prevArtifactDir;
  }
}
