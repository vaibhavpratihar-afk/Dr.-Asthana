/**
 * Pipeline Orchestrator.
 *
 * Knows about all modules. Runs steps in sequence.
 * Each step: log start → post JIRA step comment → execute → save checkpoint → handle result.
 *
 * Steps 1-2 run once. Steps 3-7 loop for each (service, branch) combo. Step 8 runs once at end.
 */

import { getTicketDetails, parseTicket, displayTicketDetails } from '../jira/index.js';
import { transitionToInProgress, transitionToLeadReview, postComment, addLabel, removeLabel } from '../jira/index.js';
import { getServiceConfig, getRepoUrl } from '../utils/config.js';
import { cloneAndBranch, commitAndPush, cleanup } from '../service/index.js';
import { createPR } from '../service/azure.js';
import { handleBaseTag } from '../service/base-tagger.js';
import { buildCheatsheet, validateExecution } from '../prompt/index.js';
import { execute } from '../agent/index.js';
import {
  postJiraStep,
  postFinalJiraReport,
  notifySlackSuccess,
  notifySlackFailure,
  notifySlackRejection,
  postInProgressComment,
  postLeadReviewComment,
  uploadLogFile,
} from '../notification/index.js';
import { startServices, stopServices } from '../infra/index.js';
import { saveCheckpoint, loadCheckpoint, clearCheckpoint, getCheckpointPath } from './checkpoint.js';
import { STEPS, STEP_ORDER, getStepNumber } from './steps.js';
import * as logger from '../utils/logger.js';

const { log, ok, warn, err, debug, logData, startStep, endStep, initRun, finalizeRun, getRunLogPath } = logger;

/**
 * Run the full pipeline for a ticket.
 *
 * @param {object} config - Full config object
 * @param {string|object} ticketOrKey - Ticket key string or ticket object from search
 * @returns {Promise<{success: boolean, prs?: object[], errors?: string[]}>}
 */
export async function runPipeline(config, ticketOrKey) {
  const ticketKey = typeof ticketOrKey === 'string' ? ticketOrKey : ticketOrKey.key;
  const runCtx = { infraStarted: false };

  // Set _currentTicketKey so downstream modules (agent, debate) can use it for log filenames
  config._currentTicketKey = ticketKey;

  const runId = initRun(ticketKey, config.agent.logDir);
  log(`Processing: ${ticketKey} (Run ID: ${runId})`);

  try {
    // ══════ Step 1: FETCH_TICKET ══════
    startStep(1, 'Fetch and parse ticket');
    const rawTicket = await getTicketDetails(config, ticketKey);
    const ticket = parseTicket(config, rawTicket);
    displayTicketDetails(ticket, logger);
    saveCheckpoint(ticketKey, STEPS.FETCH_TICKET, { ticketData: ticket });
    endStep(true, `Ticket fetched: ${ticket.summary.substring(0, 50)}...`);

    // ══════ Step 2: VALIDATE_TICKET ══════
    startStep(2, 'Validate ticket fields');
    const validationErrors = validateTicket(config, ticket);
    if (validationErrors.length > 0) {
      for (const error of validationErrors) warn(`Validation failed: ${error}`);
      await postComment(ticketKey, `Dr. Asthana: Cannot process ticket.\n\nValidation errors:\n${validationErrors.map(e => '- ' + e).join('\n')}`);
      endStep(false, `Validation failed: ${validationErrors.join(', ')}`);
      finalizeRun(false, 'Validation failed');
      return { success: false, reason: 'validation_failed', errors: validationErrors };
    }
    saveCheckpoint(ticketKey, STEPS.VALIDATE_TICKET, { ticketData: ticket });
    endStep(true, 'All required fields present');

    // Transition to In-Progress + comment
    try {
      const transitioned = await transitionToInProgress(config, ticketKey);
      if (transitioned) {
        await postInProgressComment(config, ticketKey, ticket);
        log(`In-Progress transition and comment posted for ${ticketKey}`);
      }
    } catch (e) {
      warn(`In-Progress transition failed (non-blocking): ${e.message}`);
    }

    // ══════ Steps 3-7: Loop per (service, branch) ══════
    const allPRs = [];
    const allFailures = [];
    let firstCheatsheetSummary = '';

    for (const serviceName of ticket.affectedSystems) {
      const serviceConfig = getServiceConfig(config, serviceName);
      if (!serviceConfig) {
        allFailures.push({ service: serviceName, baseBranch: 'all', error: `Unknown service: ${serviceName}` });
        continue;
      }

      const repoUrl = getRepoUrl(config, serviceName);
      const branches = ticket.targetBranches && ticket.targetBranches.length > 0
        ? ticket.targetBranches
        : [{ branch: ticket.targetBranch, versionName: ticket.fixVersion, version: null }];

      for (const branchInfo of branches) {
        log(`\n--- Processing ${serviceName} / ${branchInfo.branch} ---`);

        try {
          const result = await processServiceBranch(
            config, ticket, serviceConfig, repoUrl, ticketKey,
            branchInfo.branch, branchInfo.version, runCtx
          );

          if (result.pr) {
            allPRs.push({ service: serviceName, ...result.pr });
          } else if (result.error) {
            allFailures.push({ service: serviceName, baseBranch: branchInfo.branch, error: result.error });
          }

          if (result.cheatsheetSummary && !firstCheatsheetSummary) {
            firstCheatsheetSummary = result.cheatsheetSummary;
          }
        } catch (branchError) {
          err(`Failed to process ${serviceName}/${branchInfo.branch}: ${branchError.message}`);
          allFailures.push({ service: serviceName, baseBranch: branchInfo.branch, error: branchError.message });
        }
      }
    }

    // ══════ Step 8: NOTIFY ══════
    startStep(8, 'Update JIRA and send notifications');
    const logUrl = uploadLogFile(getRunLogPath());

    if (allPRs.length === 0) {
      warn('No PRs created across any service/branch');
      const noPrMsg = logUrl
        ? `Dr. Asthana: No PRs created. Manual implementation may be needed.\n\nRun Log: ${logUrl}`
        : 'Dr. Asthana: No PRs created. Manual implementation may be needed.';
      await postComment(ticketKey, noPrMsg);
      endStep(false, 'No PRs created');
      finalizeRun(false, 'No PRs created');
      return { success: false, reason: 'no_prs_created' };
    }

    // Transition to LEAD REVIEW
    try {
      const transitionResult = await transitionToLeadReview(config, ticketKey);
      if (transitionResult.emReviewDone) {
        await postLeadReviewComment(config, ticketKey, allPRs, firstCheatsheetSummary);
      }
    } catch (e) {
      warn(`LEAD REVIEW transition failed (non-blocking): ${e.message}`);
    }

    // Post final JIRA comment
    await postFinalJiraReport(config, ticketKey, allPRs, allFailures, firstCheatsheetSummary, logUrl);

    // Update labels
    await removeLabel(ticketKey, config.jira.label);
    const addedLabels = new Set();
    for (const pr of allPRs) {
      const versionMatch = pr.baseBranch.match(/version\/(.+)/);
      const processedLabel = versionMatch
        ? `${config.jira.labelProcessed}-${versionMatch[1]}`
        : config.jira.labelProcessed;
      if (!addedLabels.has(processedLabel)) {
        await addLabel(ticketKey, processedLabel);
        addedLabels.add(processedLabel);
      }
    }

    // Slack notification
    await notifySlackSuccess(config, ticketKey, ticket.summary, allPRs, allFailures, firstCheatsheetSummary, logUrl);
    endStep(true, 'JIRA comment and Slack notification sent');

    saveCheckpoint(ticketKey, STEPS.NOTIFY, { allPRs, allFailures });
    clearCheckpoint(ticketKey);

    ok(`Successfully processed ${ticketKey} — ${allPRs.length} PR(s) created`);
    finalizeRun(true, `${allPRs.length} PR(s) created`);

    return { success: true, prs: allPRs };

  } catch (error) {
    err(`Error processing ${ticketKey}: ${error.message}`);
    err(`Stack trace: ${error.stack}`);
    try {
      const logUrl = uploadLogFile(getRunLogPath());
      const failMsg = logUrl
        ? `Dr. Asthana failed: ${error.message}\n\nRun Log: ${logUrl}`
        : `Dr. Asthana failed: ${error.message}`;
      await postComment(ticketKey, failMsg);
      await notifySlackFailure(config, ticketKey, { key: ticketKey, summary: ticketKey }, error, logUrl);
    } catch (e) {
      err(`Failed to send failure notification: ${e.message}`);
    }
    finalizeRun(false, `Error: ${error.message}`);
    return { success: false, reason: 'error', error: error.message };
  } finally {
    if (runCtx.infraStarted) {
      await stopServices(config);
    }
  }
}

/**
 * Resume a failed run from a specific step.
 *
 * @param {object} config
 * @param {string} ticketKey
 * @param {number|string} fromStep - Step number or name to resume from
 */
export async function resume(config, ticketKey, fromStep) {
  const checkpoint = loadCheckpoint(ticketKey);
  if (!checkpoint) {
    throw new Error(`No checkpoint found for ${ticketKey}`);
  }

  log(`Resuming ${ticketKey} from step ${fromStep}`);
  log(`Checkpoint timestamp: ${checkpoint.timestamp}`);

  // If resuming from step 5+, verify cheatsheet exists
  const stepNum = typeof fromStep === 'number' ? fromStep : getStepNumber(fromStep);
  if (stepNum >= 5 && !checkpoint.cheatsheet) {
    throw new Error(`Cannot resume from step ${fromStep}: no cheatsheet found in checkpoint`);
  }

  // If resuming from step 3+, verify clone dir exists (or re-clone)
  if (stepNum >= 3 && checkpoint.cloneDir) {
    const { existsSync } = await import('fs');
    if (!existsSync(checkpoint.cloneDir)) {
      log(`Clone dir ${checkpoint.cloneDir} no longer exists, will re-clone at step 3`);
      checkpoint.cloneDir = null;
    }
  }

  // Re-run pipeline with checkpoint data
  // For now, re-run from the beginning with saved ticket data
  if (checkpoint.ticketData) {
    return runPipeline(config, ticketKey);
  }

  throw new Error('Cannot resume: insufficient checkpoint data');
}

/**
 * Process a single (service, branch) combination through steps 3-7.
 */
async function processServiceBranch(config, ticket, serviceConfig, repoUrl, ticketKey, baseBranch, version, runCtx) {
  let tmpDir = null;

  try {
    // Step 3: CLONE_REPO
    startStep(3, `Clone ${serviceConfig.repo} (${baseBranch})`);
    const cloneResult = await cloneAndBranch(config, repoUrl, baseBranch, ticketKey, ticket.summary, version);
    tmpDir = cloneResult.tmpDir;
    const { featureBranch, serviceHasInstructionFile, instructionFile } = cloneResult;
    log(`Feature branch: ${featureBranch}`);
    saveCheckpoint(ticketKey, STEPS.CLONE_REPO, {
      ticketData: ticket,
      cloneDir: tmpDir,
      featureBranch,
      serviceName: serviceConfig.name,
      branchName: baseBranch,
    });
    endStep(true, `Branch created: ${featureBranch}`);

    // Step 4: BUILD_CHEATSHEET
    startStep(4, `Build cheatsheet for ${serviceConfig.repo}/${baseBranch}`);
    const checkpointDir = getCheckpointPath(ticketKey);
    const cheatsheetResult = await buildCheatsheet(ticket, tmpDir, config, {
      checkpointDir,
      ticketKey,
    });

    if (cheatsheetResult.status === 'rejected') {
      warn(`Cheatsheet rejected (${cheatsheetResult.phase}): ${cheatsheetResult.reason}`);
      endStep(false, `Rejected: ${cheatsheetResult.reason}`);
      await postJiraStep(ticketKey, 'Cheatsheet Rejected', cheatsheetResult.reason);
      return { pr: null, error: `Cheatsheet rejected: ${cheatsheetResult.reason}`, cheatsheetSummary: '' };
    }

    const cheatsheet = cheatsheetResult.cheatsheet;
    saveCheckpoint(ticketKey, STEPS.BUILD_CHEATSHEET, {
      ticketData: ticket,
      cloneDir: tmpDir,
      featureBranch,
      cheatsheet,
      cheatsheetPath: `${checkpointDir}/cheatsheet.md`,
    });
    endStep(true, `Cheatsheet ready (${cheatsheet.length} chars)`);

    // Step 5: EXECUTE (with retries)
    let executionResult;
    const maxRetries = config.agent.executionRetries || 1;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      startStep(5, `Execute cheatsheet (attempt ${attempt}/${maxRetries})`);
      executionResult = await execute(cheatsheet, tmpDir, config);

      if (!executionResult.output || executionResult.output.trim() === '') {
        warn(`Execution attempt ${attempt} produced no output`);
        endStep(false, 'No output');
        if (attempt < maxRetries) continue;
        return { pr: null, error: 'Execution produced no output', cheatsheetSummary: cheatsheet };
      }

      saveCheckpoint(ticketKey, STEPS.EXECUTE, {
        ticketData: ticket,
        cloneDir: tmpDir,
        featureBranch,
        cheatsheet,
        executionOutput: executionResult.output.substring(0, 5000),
      });
      endStep(true, executionResult.completedNormally ? 'Execution completed' : `Exit code ${executionResult.exitCode}`);

      // Step 6: VALIDATE_EXECUTION
      startStep(6, 'Validate execution result');
      const validationResult = await validateExecution(cheatsheet, tmpDir);

      if (!validationResult.valid && attempt < maxRetries) {
        warn(`Execution validation failed (attempt ${attempt}): ${validationResult.issues.join(', ')}`);
        endStep(false, 'Validation failed, retrying...');
        continue;
      }

      if (validationResult.issues.length > 0) {
        warn(`Validation issues: ${validationResult.issues.join(', ')}`);
      }
      endStep(validationResult.valid, validationResult.valid ? 'Validation passed' : `Issues: ${validationResult.issues.join(', ')}`);
      break;
    }

    // Step 7: SHIP
    startStep(7, `Commit and push ${serviceConfig.repo}/${baseBranch}`);
    const { pushed } = await commitAndPush(tmpDir, featureBranch, ticketKey, ticket.summary, serviceHasInstructionFile, instructionFile);

    if (!pushed) {
      warn('No changes to commit');
      endStep(false, 'No changes');
      return { pr: null, error: 'No changes to commit', cheatsheetSummary: cheatsheet };
    }

    // Handle base tag
    try {
      const baseTagResult = handleBaseTag(tmpDir, baseBranch, serviceConfig.repo);
      if (baseTagResult.tagged) {
        log(`Base tag created: ${baseTagResult.tag}`);
        await commitAndPush(tmpDir, featureBranch, ticketKey, `Update base image tag to ${baseTagResult.tag}`, serviceHasInstructionFile, instructionFile);
      }
    } catch (baseTagError) {
      warn(`Base tag handling failed: ${baseTagError.message}`);
    }

    // Create PR
    const prResult = await createPR(
      config, tmpDir, featureBranch, baseBranch, ticketKey, ticket.summary,
      executionResult?.output || cheatsheet
    );

    if (prResult?.prId) {
      const action = prResult.alreadyExists ? 'updated' : 'created';
      log(`PR #${prResult.prId} ${action}`);
      saveCheckpoint(ticketKey, STEPS.SHIP, {
        ticketData: ticket,
        prData: { prId: prResult.prId, prUrl: prResult.prUrl, baseBranch, version },
      });
      endStep(true, `PR #${prResult.prId} (${action})`);
      return { pr: { prId: prResult.prId, prUrl: prResult.prUrl, baseBranch, version }, cheatsheetSummary: cheatsheet };
    }

    warn('PR creation failed');
    endStep(false, 'PR creation failed');
    return { pr: null, error: 'PR creation failed', cheatsheetSummary: cheatsheet };

  } finally {
    if (tmpDir) {
      cleanup(tmpDir);
    }
  }
}

/**
 * Validate ticket has required fields for processing.
 */
function validateTicket(config, ticket) {
  const errors = [];

  if (ticket.affectedSystems.length === 0) {
    errors.push('No Affected Systems specified');
  }

  if (!ticket.targetBranch) {
    errors.push('No Fix Version specified');
  }

  for (const system of ticket.affectedSystems) {
    const serviceConfig = getServiceConfig(config, system);
    if (!serviceConfig) {
      errors.push(`Unknown service: ${system}. Supported: ${Object.keys(config.services).join(', ')}`);
    }
  }

  return errors;
}
