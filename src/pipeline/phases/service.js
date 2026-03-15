/**
 * File: src/pipeline/phases/service.js
 * Module: pipeline
 * Purpose: Service phase coordinator that dispatches step handlers and maps outcomes.
 * Key Exports: processServiceBranchPhase
 * Integration Points: Integrates with Jira, service, prompt, notification, and logger modules.
 * Data Flow: Keep side effects explicit; keep pure transformations isolated where possible.
 * Maintenance Notes: Header intentionally documents file intent for fast onboarding and review.
 */
import { cleanup } from '../../service/index.js';
import { SERVICE_STEP_HANDLERS, STEP_STATUS } from './service-steps.js';

export async function processServiceBranchPhase({ config, ticket, serviceTarget, ticketKey, logger }) {
  const context = {
    config,
    ticket,
    serviceTarget,
    ticketKey,
    logger,
    tmpDir: null,
    featureBranch: null,
  };

  try {
    for (let index = 0; index < SERVICE_STEP_HANDLERS.length; index += 1) {
      const outcome = await SERVICE_STEP_HANDLERS[index](context);

      switch (outcome.status) {
        case STEP_STATUS.OK:
          if (outcome.pr) {
            return { pr: outcome.pr };
          }
          break;
        case STEP_STATUS.FAIL:
          return { pr: null, error: outcome.error };
        default:
          throw new Error(`Unknown service step outcome: ${outcome.status}`);
      }
    }

    return { pr: null, error: 'Service workflow ended without a terminal result' };
  } finally {
    if (context.tmpDir) cleanup(context.tmpDir);
  }
}
