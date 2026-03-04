/**
 * Pipeline Orchestrator.
 *
 * Knows about all modules. Runs steps in sequence.
 * Each step: log start → post JIRA step comment → execute → save checkpoint → handle result.
 *
 * Steps 1-2 run once. Steps 3-7 process a single service/branch. Step 8 runs once at end.
 */

import fs from 'fs';
import path from 'path';
import { getTicketDetails, parseTicket, displayTicketDetails, validateTicket, deleteStaleAgentComments } from '../jira/index.js';
import { transitionToInProgress, transitionToLeadReview, postComment, addLabel, removeLabel } from '../jira/index.js';
import { getServiceConfig, getRepoUrl } from '../utils/config.js';
import { cloneAndBranch, commitAndPush, cleanup } from '../service/index.js';
import { createPR } from '../service/azure.js';
import { handleBaseTag } from '../service/base-tagger.js';
import { execute } from '../prompt/index.js';
import {
  postJiraStep,
  postFinalJiraReport,
  notifySlackSuccess,
  notifySlackFailure,
  postInProgressComment,
  postLeadReviewComment,
} from '../notification/index.js';
import { saveCheckpoint, clearCheckpoint, getCheckpointPath } from './checkpoint.js';
import { bundleRunArtifact } from './bundler.js';
import { runDiffReviewLoop } from './diff-review.js';
import { STEPS } from './steps.js';
import * as logger from '../utils/logger.js';

const { log, ok, warn, err, startStep, endStep, initRun, finalizeRun, getRunLogPaths } = logger;

/** Guard: skip all JIRA comment/notification calls when muteComments is set. */
function isMuted(config) {
  if (config.jira?.muteComments) {
    warn('[jira] muteComments=true — skipping JIRA comment');
    return true;
  }
  return false;
}

/**
 * Run the full pipeline for a ticket.
 *
 * @param {object} config - Full config object
 * @param {string|object} ticketOrKey - Ticket key string or ticket object from search
 * @returns {Promise<{success: boolean, prs?: object[], errors?: string[]}>}
 */
export async function runPipeline(config, ticketOrKey) {
  const ticketKey = typeof ticketOrKey === 'string' ? ticketOrKey : ticketOrKey.key;

  // Set _currentTicketKey so downstream modules can use it for log filenames
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

    // Set artifact directory so downstream modules write AI call logs there
    const artifactDir = getCheckpointPath(ticketKey);
    config._artifactDir = artifactDir;
    const aiCallsDir = path.join(artifactDir, 'ai-calls');
    if (!fs.existsSync(aiCallsDir)) fs.mkdirSync(aiCallsDir, { recursive: true });

    // ══════ Step 2: VALIDATE_TICKET ══════
    startStep(2, 'Validate ticket fields');
    const validationErrors = validateTicket(config, ticket);
    if (validationErrors.length > 0) {
      for (const error of validationErrors) warn(`Validation failed: ${error}`);
      if (!isMuted(config)) await postComment(ticketKey, `Dr. Asthana: Cannot process ticket.\n\nValidation errors:\n${validationErrors.map(e => '- ' + e).join('\n')}`);
      endStep(false, `Validation failed: ${validationErrors.join(', ')}`);
      finalizeRun(false, 'Validation failed');
      return { success: false, reason: 'validation_failed', errors: validationErrors };
    }
    saveCheckpoint(ticketKey, STEPS.VALIDATE_TICKET, { ticketData: ticket });
    endStep(true, 'All required fields present');

    // Clean up stale agent comments from previous failed runs
    try {
      await deleteStaleAgentComments(config, ticketKey);
    } catch (e) {
      warn(`Stale comment cleanup failed (non-blocking): ${e.message}`);
    }

    // Transition to In-Progress + comment (both non-blocking, independent)
    try {
      if (!isMuted(config)) await transitionToInProgress(ticketKey);
    } catch (e) {
      warn(`In-Progress transition failed (non-blocking): ${e.message}`);
    }
    try {
      if (!isMuted(config)) await postInProgressComment(config, ticketKey, ticket);
      log(`In-Progress comment posted for ${ticketKey}`);
    } catch (e) {
      warn(`In-Progress comment failed (non-blocking): ${e.message}`);
    }

    // ══════ Steps 3-7: Single service, single branch ══════
    const serviceName = ticket.affectedSystems[0];
    const serviceConfig = getServiceConfig(config, serviceName);
    const repoUrl = getRepoUrl(config, serviceName);
    const baseBranch = ticket.targetBranch;
    const version = ticket.targetBranches?.[0]?.version || null;

    let pr = null;
    let failure = null;

    log(`\n--- Processing ${serviceName} / ${baseBranch} ---`);

    try {
      const result = await processServiceBranch(
        config, ticket, serviceConfig, repoUrl, ticketKey,
        baseBranch, version
      );

      if (result.pr) {
        pr = { service: serviceName, ...result.pr };
      } else if (result.error) {
        failure = { service: serviceName, baseBranch, error: result.error };
      }
    } catch (branchError) {
      err(`Failed to process ${serviceName}/${baseBranch}: ${branchError.message}`);
      failure = { service: serviceName, baseBranch, error: branchError.message };
    }

    const allPRs = pr ? [pr] : [];
    const allFailures = failure ? [failure] : [];

    // ══════ Step 7: NOTIFY ══════
    startStep(7, 'Update JIRA and send notifications');

    // Bundle run artifact: copy run logs into artifact dir, tar, upload
    const runLogPaths = getRunLogPaths();
    const bundle = await bundleRunArtifact(ticketKey, artifactDir, runLogPaths);
    const artifactUrl = bundle.url || null;

    if (allPRs.length === 0) {
      warn('No PRs created across any service/branch');
      const noPrMsg = artifactUrl
        ? `Dr. Asthana: No PRs created. Manual implementation may be needed.\n\nRun Artifact: ${artifactUrl}`
        : 'Dr. Asthana: No PRs created. Manual implementation may be needed.';
      if (!isMuted(config)) await postComment(ticketKey, noPrMsg);
      endStep(false, 'No PRs created');
      finalizeRun(false, 'No PRs created');
      return { success: false, reason: 'no_prs_created' };
    }

    // Transition to LEAD REVIEW + comment (both non-blocking, independent)
    try {
      if (!isMuted(config)) await transitionToLeadReview(ticketKey);
    } catch (e) {
      warn(`LEAD REVIEW transition failed (non-blocking): ${e.message}`);
    }
    try {
      if (!isMuted(config)) await postLeadReviewComment(config, ticketKey, allPRs);
    } catch (e) {
      warn(`Lead review comment failed (non-blocking): ${e.message}`);
    }

    // Post final JIRA comment
    if (!isMuted(config)) await postFinalJiraReport(config, ticketKey, allPRs, allFailures, artifactUrl);

    // Update labels
    if (!isMuted(config)) await removeLabel(ticketKey, config.jira.label);
    const versionMatch = pr.baseBranch.match(/version\/(.+)/);
    const processedLabel = versionMatch
      ? `${config.jira.labelProcessed}-${versionMatch[1]}`
      : config.jira.labelProcessed;
    if (!isMuted(config)) await addLabel(ticketKey, processedLabel);

    // Slack notification
    if (!isMuted(config)) await notifySlackSuccess(config, ticketKey, ticket.summary, allPRs, allFailures, artifactUrl);
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
      let failArtifactUrl = null;
      try {
        const failArtifactDir = config._artifactDir;
        if (failArtifactDir) {
          const failBundle = await bundleRunArtifact(ticketKey, failArtifactDir, getRunLogPaths());
          failArtifactUrl = failBundle.url;
        }
      } catch (bundleErr) {
        warn(`Artifact bundling failed in error handler: ${bundleErr.message}`);
      }

      const failMsg = failArtifactUrl
        ? `Dr. Asthana failed: ${error.message}\n\nRun Artifact: ${failArtifactUrl}`
        : `Dr. Asthana failed: ${error.message}`;
      if (!isMuted(config)) await postComment(ticketKey, failMsg);
      if (!isMuted(config)) await notifySlackFailure(config, ticketKey, { key: ticketKey, summary: ticketKey }, error, failArtifactUrl);
    } catch (e) {
      err(`Failed to send failure notification: ${e.message}`);
    }
    finalizeRun(false, `Error: ${error.message}`);
    return { success: false, reason: 'error', error: error.message };
  }
}

/**
 * Process a single (service, branch) combination through steps 3-5.
 */
async function processServiceBranch(config, ticket, serviceConfig, repoUrl, ticketKey, baseBranch, version) {
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

    // Guard: reject services that use npm instead of pnpm
    const hasPnpmLock = fs.existsSync(path.join(tmpDir, 'pnpm-lock.yaml'));
    const hasNpmLock = fs.existsSync(path.join(tmpDir, 'package-lock.json'));
    if (!hasPnpmLock && hasNpmLock) {
      const reason = `Service ${serviceConfig.repo} uses npm (package-lock.json found, no pnpm-lock.yaml). Only pnpm services are supported.`;
      warn(reason);
      endStep(false, reason);
      return { pr: null, error: reason };
    }

    // Step 4: EXECUTE — direct execution, no council debate
    startStep(4, `Execute for ${serviceConfig.repo}/${baseBranch}`);
    const execResult = await execute(ticket, tmpDir, config, { ticketKey });

    if (execResult.status === 'failed') {
      warn(`Executor failed: ${execResult.reason}`);
      endStep(false, execResult.reason);
      return { pr: null, error: execResult.reason, executorOutput: '' };
    }

    const executorOutput = execResult.output;
    saveCheckpoint(ticketKey, STEPS.EXECUTE, {
      ticketData: ticket,
      cloneDir: tmpDir,
      featureBranch,
      executorOutput,
    });
    endStep(true, `Execution complete (${executorOutput.length} chars)`);

    // Step 5: DIFF_REVIEW — adversarial closed-loop review; fix until APPROVED or fail hard
    startStep(5, 'Diff review (adversarial closed-loop)');
    const diffReview = await runDiffReviewLoop(tmpDir, ticket, config);

    if (diffReview.skipped) {
      endStep(true, 'Skipped (empty diff)');
    } else if (diffReview.approved) {
      endStep(true, `Approved after ${diffReview.attempts} attempt(s)`);
    } else {
      // Loop exhausted without approval — hard failure, no PR
      const summary = `Diff review could not reach APPROVED after ${diffReview.attempts} attempt(s)`;
      endStep(false, summary);
      await postJiraStep(ticketKey, 'Diff Review Failed', `${summary}\n\n${diffReview.finalIssues}`, config);
      return { pr: null, error: summary, executorOutput };
    }

    // Step 6: SHIP
    startStep(6, `Commit and push ${serviceConfig.repo}/${baseBranch}`);
    const { pushed } = await commitAndPush(tmpDir, featureBranch, ticketKey, ticket.summary, serviceHasInstructionFile, instructionFile);

    if (!pushed) {
      warn('No changes to commit');
      endStep(false, 'No changes');
      return { pr: null, error: 'No changes to commit' };
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
      executorOutput
    );

    if (prResult?.prId) {
      const action = prResult.alreadyExists ? 'updated' : 'created';
      log(`PR #${prResult.prId} ${action}`);
      saveCheckpoint(ticketKey, STEPS.SHIP, {
        ticketData: ticket,
        prData: { prId: prResult.prId, prUrl: prResult.prUrl, baseBranch },
      });
      endStep(true, `PR #${prResult.prId} (${action})`);
      return { pr: { prId: prResult.prId, prUrl: prResult.prUrl, baseBranch } };
    }

    warn('PR creation failed');
    endStep(false, 'PR creation failed');
    return { pr: null, error: 'PR creation failed' };

  } finally {
    if (tmpDir) {
      cleanup(tmpDir);
    }
  }
}
