/**
 * Main ticket processing workflow
 *
 * Processes each service and branch sequentially:
 *   For each service in ticket.affectedSystems:
 *     For each branch in ticket.targetBranches:
 *       Clone → [Infra if AGENT_RUN_TESTS] → AI provider → [shouldRunTests + Infra + Test if external] → Commit → Push → Base tag → PR
 *
 *   When AGENT_RUN_TESTS=true:  infra starts once (before first provider run), tests run internally, external test step is skipped.
 *   When AGENT_RUN_TESTS=false: infra starts lazily on first branch where shouldRunTests() detects code changes.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parseTicket, displayTicketDetails } from './ticket.js';
import { scoreComplexity } from './complexity.js';
import { detectAndFilterRetrigger } from './retrigger.js';
import { getTicketDetails, addComment, addLabel, removeLabel } from '../services/jira.js';
import { cloneAndBranch, commitAndPush, cleanup } from '../services/git.js';
import { handleBaseTag } from '../services/base-tagger.js';
import { runAgentProvider, getProviderLabel } from '../services/ai-provider.js';
import { createPR } from '../services/azure.js';
import { buildJiraComment, buildPRDescription, buildInProgressComment, buildLeadReviewComment, notifyAllPRs, notifyFailure } from '../services/notifications.js';
import { transitionToInProgress, transitionToLeadReview } from '../services/jira-transitions.js';
import { startServices, stopServices } from '../services/infra.js';
import { runTests, formatTestResults, shouldRunTests } from '../services/test-runner.js';
import { getServiceConfig } from '../config.js';
import * as logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const { log, ok, warn, err, debug, logData, startStep, endStep, initRun, finalizeRun } = logger;

/**
 * Detect target Node.js version from ticket context or Dockerfile.base.
 * Returns major version string (e.g. "24") or null.
 */
function detectTargetNodeVersion(tmpDir, ticket) {
  // Priority 1: Parse ticket title + description for node version patterns
  const textToSearch = `${ticket.summary || ''} ${ticket.description || ''}`;
  const versionPatterns = [
    /node(?:\.?js)?\s+(?:to\s+)?v?(\d{2,})/i,
    /upgrade\s+(?:to\s+)?node\s+v?(\d{2,})/i,
    /node\s+v?(\d{2,})\s+upgrade/i,
    /v(\d{2,})\s+(?:node|upgrade)/i,
  ];

  for (const pattern of versionPatterns) {
    const match = textToSearch.match(pattern);
    if (match) {
      log(`Detected target Node.js version v${match[1]} from ticket text`);
      return match[1];
    }
  }

  // Priority 2: Parse Dockerfile.base for nodeXX-builder pattern
  try {
    const dockerBasePath = path.join(tmpDir, 'Dockerfile.base');
    if (fs.existsSync(dockerBasePath)) {
      const content = fs.readFileSync(dockerBasePath, 'utf-8');
      const nodeMatch = content.match(/node(\d{2,})-builder/);
      if (nodeMatch) {
        log(`Detected current Node.js version v${nodeMatch[1]} from Dockerfile.base`);
        return nodeMatch[1];
      }
    }
  } catch (e) {
    debug(`Could not read Dockerfile.base: ${e.message}`);
  }

  return null;
}

/**
 * Get the bin directory for a specific Node.js major version via nvm.
 * Returns the bin directory path or null if nvm/version not available.
 */
function getNvmBinDir(majorVersion) {
  try {
    const nodePath = execSync(
      `source ~/.nvm/nvm.sh && nvm which ${majorVersion}`,
      { encoding: 'utf-8', shell: '/bin/bash', stdio: 'pipe', timeout: 15000 }
    ).trim();

    if (nodePath && fs.existsSync(nodePath)) {
      const binDir = path.dirname(nodePath);
      log(`nvm Node v${majorVersion} bin dir: ${binDir}`);
      return binDir;
    }
  } catch (e) {
    warn(`nvm could not resolve Node v${majorVersion}: ${e.message}`);
  }
  return null;
}

/**
 * Append agent standing rules to the clone's provider instructions file.
 * Picks the correct rules file based on whether the selected provider should run tests.
 * Optionally adds nvm switching instructions for target Node.js version.
 */
function injectAgentRules(tmpDir, config, nodeVersion = null) {
  const rulesFile = config.AGENT_RUN_TESTS
    ? 'agent-rules-with-tests.md'
    : 'agent-rules-no-tests.md';
  const rulesPath = path.join(PROJECT_ROOT, rulesFile);

  let rulesContent;
  try {
    rulesContent = fs.readFileSync(rulesPath, 'utf-8');
  } catch (e) {
    warn(`Could not read ${rulesFile}: ${e.message}`);
    return;
  }

  // Add nvm instructions if a target Node version was detected
  if (nodeVersion) {
    rulesContent += `\n\n## Node.js Version\nThis ticket targets Node.js v${nodeVersion}. Before running any npm or node commands:\n` +
      '```bash\n' +
      `source ~/.nvm/nvm.sh && nvm use ${nodeVersion} || nvm install ${nodeVersion}\n` +
      '```\n' +
      'ALWAYS verify with `node --version` before proceeding.\n';
  }

  const instructionFile = config.AGENT_INSTRUCTIONS_FILE || 'CLAUDE.md';
  const instructionPath = path.join(tmpDir, instructionFile);
  let existing = '';
  try {
    existing = fs.readFileSync(instructionPath, 'utf-8');
  } catch { /* file may not exist */ }

  const combined = existing
    ? existing + '\n\n' + rulesContent
    : rulesContent;

  fs.writeFileSync(instructionPath, combined);
  log(`Injected agent rules (${rulesFile}${nodeVersion ? `, node=${nodeVersion}` : ''}) into ${instructionPath}`);
}

/**
 * Validate ticket has required fields for processing
 */
function validateTicket(config, ticket) {
  const errors = [];

  if (ticket.affectedSystems.length === 0) {
    errors.push('No Affected Systems specified');
  }

  if (!ticket.targetBranch) {
    errors.push('No Fix Version specified');
  }

  // Validate all affected systems are known
  for (const system of ticket.affectedSystems) {
    const serviceConfig = getServiceConfig(config, system);
    if (!serviceConfig) {
      errors.push(`Unknown service: ${system}. Supported: ${Object.keys(config.SERVICES).join(', ')}`);
    }
  }

  return errors;
}

/**
 * Process a single ticket through the full pipeline.
 *
 * Loops over all affected services, processes each one sequentially,
 * then sends a single JIRA comment and Slack notification with all results.
 */
export async function processTicket(config, ticketOrKey) {
  let ticketKey = typeof ticketOrKey === 'string' ? ticketOrKey : ticketOrKey.key;

  // Infrastructure is started lazily — only when tests are actually needed.
  // Declared outside try so finally can always access it for cleanup.
  const runCtx = { infraStarted: false };

  // Initialize run logging
  const runId = initRun(ticketKey, config.LOG_DIR);

  log(`\n${'═'.repeat(60)}`);
  log(`Processing: ${ticketKey}`);
  log(`Run ID: ${runId}`);
  log(`${'═'.repeat(60)}`);

  try {
    // Step 1: Fetch and parse ticket details
    startStep(1, 'Fetch and parse ticket details');
    const rawTicket = await getTicketDetails(config, ticketKey);
    const ticket = parseTicket(config, rawTicket);
    logData('Parsed ticket', {
      key: ticket.key,
      summary: ticket.summary,
      affectedSystems: ticket.affectedSystems,
      targetBranch: ticket.targetBranch,
    });

    displayTicketDetails(ticket, logger);
    endStep(true, `Ticket fetched: ${ticket.summary.substring(0, 50)}...`);

    // Score complexity and build effective config (scales UP from baseline, never down)
    const complexity = scoreComplexity(ticket, config);
    logData('Complexity scoring', {
      level: complexity.level,
      score: complexity.score,
      signals: complexity.signals,
      enablePhases: complexity.enablePhases,
    });
    log(`Complexity: ${complexity.level} (score=${complexity.score}, phases=${complexity.enablePhases})`);

    const effectiveConfig = config.AGENT_COMPLEXITY_SCALING
      ? {
          ...config,
          AGENT_MAX_TURNS: Math.max(config.AGENT_MAX_TURNS, complexity.recommendedMaxTurns),
          AGENT_PLAN_TURNS: Math.max(config.AGENT_PLAN_TURNS, complexity.recommendedPlanTurns),
          AGENT_MAX_CONTINUATIONS: Math.max(config.AGENT_MAX_CONTINUATIONS || 0, complexity.recommendedMaxContinuations),
          AGENT_ENABLE_PHASES: complexity.enablePhases,
          CLAUDE_MAX_TURNS: Math.max(config.AGENT_MAX_TURNS, complexity.recommendedMaxTurns),
          CLAUDE_PLAN_TURNS: Math.max(config.AGENT_PLAN_TURNS, complexity.recommendedPlanTurns),
          CLAUDE_MAX_CONTINUATIONS: Math.max(config.AGENT_MAX_CONTINUATIONS || 0, complexity.recommendedMaxContinuations),
          CLAUDE_ENABLE_PHASES: complexity.enablePhases,
        }
      : { ...config, AGENT_ENABLE_PHASES: false, CLAUDE_ENABLE_PHASES: false };

    // Step 2: Validate ticket
    startStep(2, 'Validate ticket fields');
    const validationErrors = validateTicket(config, ticket);
    if (validationErrors.length > 0) {
      for (const error of validationErrors) {
        warn(`Validation failed: ${error}`);
      }
      await addComment(config, ticketKey, `Dr. Asthana: Cannot process ticket.\n\nValidation errors:\n${validationErrors.map(e => '- ' + e).join('\n')}`);
      endStep(false, `Validation failed: ${validationErrors.join(', ')}`);
      finalizeRun(false, 'Validation failed');
      return { success: false, reason: 'validation_failed', errors: validationErrors };
    }
    endStep(true, 'All required fields present');

    // Step 2.5: Transition to In-Progress + detailed comment
    try {
      const transitioned = await transitionToInProgress(config, ticketKey);
      if (transitioned) {
        const inProgressComment = buildInProgressComment(config, ticket);
        await addComment(config, ticketKey, inProgressComment);
        log(`In-Progress transition and comment posted for ${ticketKey}`);
      }
    } catch (transitionError) {
      warn(`In-Progress transition failed (non-blocking): ${transitionError.message}`);
    }

    // Step 3: Check for re-trigger
    startStep(3, 'Check for re-trigger');
    const retrigger = await detectAndFilterRetrigger(config, ticket);

    if (retrigger.isRetrigger) {
      log(`Re-trigger detected — done labels: ${retrigger.doneLabels?.join(', ') || config.JIRA_LABEL_PROCESSED}`);

      if (retrigger.filteredBranches) {
        // Filtered re-trigger — only process identified versions
        const versionsToProcess = retrigger.filteredBranches.map(tb => tb.version);
        const skippedVersions = (ticket.targetBranches || [])
          .map(tb => tb.version)
          .filter(v => !versionsToProcess.includes(v));

        log(`Analysis: process ${retrigger.filteredBranches.map(tb => tb.branch).join(', ')} (reasoning: ${retrigger.reasoning || 'N/A'})`);

        for (const v of skippedVersions) {
          log(`Skipping: version/${v} (already done)`);
        }

        // Remove done labels for versions being re-processed
        for (const tb of retrigger.filteredBranches) {
          const versionedLabel = `${config.JIRA_LABEL_PROCESSED}-${tb.version}`;
          if (ticket.labels.includes(versionedLabel)) {
            log(`Removing done label: ${versionedLabel}`);
            await removeLabel(config, ticket.key, versionedLabel);
          }
          // Also remove bare done label if present
          if (ticket.labels.includes(config.JIRA_LABEL_PROCESSED)) {
            await removeLabel(config, ticket.key, config.JIRA_LABEL_PROCESSED);
          }
        }

        // Mutate ticket to only process filtered branches
        ticket.targetBranches = retrigger.filteredBranches;
        if (retrigger.filteredBranches.length === 1) {
          ticket.targetBranch = retrigger.filteredBranches[0].branch;
        }

        endStep(true, `Re-trigger: processing ${retrigger.filteredBranches.length} of ${retrigger.filteredBranches.length + skippedVersions.length} versions`);
      } else {
        // Processing all versions — remove all done labels
        log('Re-trigger: processing all versions');
        for (const label of (ticket.labels || [])) {
          if (label === config.JIRA_LABEL_PROCESSED || label.startsWith(config.JIRA_LABEL_PROCESSED + '-')) {
            log(`Removing done label: ${label}`);
            await removeLabel(config, ticket.key, label);
          }
        }
        endStep(true, 'Re-trigger: processing all versions (fallback)');
      }
    } else {
      log('First run — no prior done labels');
      endStep(true, 'First run');
    }

    // Process each service sequentially
    const allPRs = [];       // { service, prId, prUrl, baseBranch, version }
    const allFailures = [];  // { service, baseBranch, error }
    let firstClaudeSummary = '';
    let firstPlanOutput = '';

    for (const serviceName of ticket.affectedSystems) {
      const serviceConfig = getServiceConfig(config, serviceName);
      const repoUrl = `${config.AZDO_REPO_BASE_URL}/${serviceConfig.repo}`;

      log(`\n${'─'.repeat(60)}`);
      log(`Service: ${serviceConfig.name} (${serviceConfig.repo})`);
      log(`${'─'.repeat(60)}`);

      try {
        let result;
        if (ticket.targetBranches && ticket.targetBranches.length > 1) {
          result = await processServiceMultiBranch(effectiveConfig, ticket, serviceConfig, repoUrl, ticketKey, runCtx);
        } else {
          result = await processServiceSingleBranch(effectiveConfig, ticket, serviceConfig, repoUrl, ticketKey, runCtx);
        }

        if (result.claudeSummary && !firstClaudeSummary) {
          firstClaudeSummary = result.claudeSummary;
        }
        if (result.planOutput && !firstPlanOutput) {
          firstPlanOutput = result.planOutput;
        }

        for (const pr of (result.prs || [])) {
          allPRs.push({ service: serviceName, ...pr });
        }
        for (const failure of (result.failures || [])) {
          allFailures.push({ service: serviceName, ...failure });
        }
      } catch (serviceError) {
        err(`Failed to process service ${serviceName}: ${serviceError.message}`);
        allFailures.push({ service: serviceName, baseBranch: 'all', error: serviceError.message });
      }
    }

    // Step 8.5: Transition to LEAD REVIEW + detailed comment (only if PRs exist)
    if (allPRs.length > 0) {
      try {
        const transitionResult = await transitionToLeadReview(config, ticketKey);
        if (transitionResult.emReviewDone) {
          const reviewComment = buildLeadReviewComment(config, allPRs, firstClaudeSummary, firstPlanOutput);
          await addComment(config, ticketKey, reviewComment);
          log(`LEAD REVIEW transition and comment posted for ${ticketKey}`);
        }
      } catch (transitionError) {
        warn(`LEAD REVIEW transition failed (non-blocking): ${transitionError.message}`);
      }
    }

    // Aggregate results and report
    if (allPRs.length === 0) {
      warn('No PRs created across any service/branch');
      await addComment(config, ticketKey, 'Dr. Asthana: No PRs created. Manual implementation may be needed.');
      finalizeRun(false, 'No PRs created');
      return { success: false, reason: 'no_prs_created' };
    }

    // JIRA comment — structured ADF with PR table and summary
    startStep(9, 'Update JIRA and send notifications');

    const jiraComment = buildJiraComment(config, allPRs, allFailures, firstClaudeSummary);
    await addComment(config, ticketKey, jiraComment);

    // Update labels
    await removeLabel(config, ticketKey, config.JIRA_LABEL);
    const addedLabels = new Set();
    for (const pr of allPRs) {
      const versionMatch = pr.baseBranch.match(/version\/(.+)/);
      const processedLabel = versionMatch
        ? `${config.JIRA_LABEL_PROCESSED}-${versionMatch[1]}`
        : config.JIRA_LABEL_PROCESSED;
      if (!addedLabels.has(processedLabel)) {
        await addLabel(config, ticketKey, processedLabel);
        addedLabels.add(processedLabel);
      }
    }

    // Slack notification — all PRs with links
    await notifyAllPRs(config, ticketKey, ticket.summary, allPRs, allFailures, firstClaudeSummary);
    endStep(true, 'JIRA comment and Slack notification sent');

    const allPrIds = allPRs.map(pr => pr.prId);
    ok(`Successfully processed ${ticketKey} — ${allPRs.length} PR(s) created: ${allPrIds.join(', ')}`);
    finalizeRun(true, `${allPRs.length} PR(s) created: ${allPrIds.join(', ')}`);

    return {
      success: true,
      prs: allPRs,
      testsPassed: true, // individual results logged per-branch
    };

  } catch (error) {
    err(`Error processing ${ticketKey}: ${error.message}`);
    err(`Stack trace: ${error.stack}`);
    try {
      await addComment(config, ticketKey, `Dr. Asthana failed: ${error.message}`);
      await notifyFailure(config, ticketKey, ticketOrKey.fields?.summary || ticketKey, error.message);
    } catch (commentError) {
      err(`Failed to add error comment: ${commentError.message}`);
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
 * Process a single branch of a service: Clone → Provider → Test → Commit → Push → Base tag → PR → Cleanup.
 * Each branch gets a completely fresh clone — no shared git state.
 *
 * @returns {{ pr: object|null, error: string|null, claudeSummary: string }}
 */
async function processBranch(config, ticket, serviceConfig, repoUrl, ticketKey, baseBranch, version = null, runCtx = {}) {
  let tmpDir = null;
  const providerLabel = getProviderLabel(config);

  try {
    // Clone and create feature branch
    startStep(4, `Clone ${serviceConfig.repo} (${baseBranch})`);
    const { tmpDir: dir, featureBranch, serviceHasInstructionFile, instructionFile } = await cloneAndBranch(
      config,
      repoUrl,
      baseBranch,
      ticketKey,
      ticket.summary,
      version
    );
    tmpDir = dir;
    log(`Feature branch: ${featureBranch}`);
    endStep(true, `Branch created: ${featureBranch}`);

    // Detect target Node.js version for nvm
    const nodeVersion = detectTargetNodeVersion(tmpDir, ticket);
    const nvmBinDir = nodeVersion ? getNvmBinDir(nodeVersion) : null;

    // Inject agent standing rules into the clone's provider instructions file
    injectAgentRules(tmpDir, config, nodeVersion);

    // When provider runs tests internally, it needs infra up before it starts.
    // Start infra lazily (once across all branches) before the first provider run.
    if (config.AGENT_RUN_TESTS && !runCtx.infraStarted) {
      startStep(4.5, `Start infrastructure services (${providerLabel} will run tests)`);
      const started = await startServices(config);
      runCtx.infraStarted = true;
      if (started) {
        endStep(true, 'MongoDB, Redis, Kafka ready');
      } else {
        endStep(false, 'Infrastructure start failed (continuing anyway)');
      }
    }

    // Run selected AI provider
    startStep(5, `Run ${providerLabel} on ${serviceConfig.repo}/${baseBranch}`);
    const claudeResult = await runAgentProvider(
      config,
      tmpDir,
      ticketKey,
      ticket.summary,
      ticket.description,
      ticket.comments,
      { nvmBinDir, instructionFile }
    );
    const claudeSummary = claudeResult.output;
    const planOutput = claudeResult.planOutput || '';

    if (!claudeSummary || claudeSummary.trim() === '') {
      warn(`${providerLabel} produced no output on ${serviceConfig.repo}/${baseBranch}`);
      endStep(false, `No output from ${providerLabel}`);
      return { pr: null, error: `No ${providerLabel} output`, claudeSummary: '', planOutput };
    }

    if (claudeResult.rateLimited) {
      warn(`${providerLabel} hit API rate limit on ${serviceConfig.repo}/${baseBranch}`);
    }
    if (claudeResult.maxTurnsReached) {
      warn(`${providerLabel} hit max turns (${claudeResult.numTurns}) — output may be incomplete`);
    }

    logData(`${providerLabel} summary`, claudeSummary.substring(0, 1000));
    endStep(true, claudeResult.completedNormally ? `${providerLabel} completed` : `${providerLabel} finished (exit=${claudeResult.exitCode}, turns=${claudeResult.numTurns})`);

    // Run external tests — only trust provider's internal tests when it completed normally
    let testResults;
    if (config.AGENT_RUN_TESTS && claudeResult.completedNormally) {
      log(`Skipping external test step — ${providerLabel} completed and ran tests internally`);
      testResults = { passed: true, skipped: true, results: [], source: config.AGENT_PROVIDER || 'provider' };
    } else {
      if (config.AGENT_RUN_TESTS && !claudeResult.completedNormally) {
        warn(`${providerLabel} did not complete normally — falling back to external test validation`);
      }
      startStep(6, `Run tests on ${serviceConfig.repo}/${baseBranch}`);
      const testCheck = shouldRunTests(tmpDir);
      if (!testCheck.needed) {
        log(`Skipping tests: ${testCheck.reason}`);
        testResults = { passed: true, skipped: true, results: [], source: 'none' };
        endStep(true, `Tests skipped — ${testCheck.reason}`);
      } else {
        log(`Tests needed: ${testCheck.reason}`);

        // Start infrastructure on first branch that actually needs tests (lazy)
        if (!runCtx.infraStarted) {
          startStep(3, 'Start infrastructure services');
          const started = await startServices(config);
          runCtx.infraStarted = true;
          if (started) {
            endStep(true, 'MongoDB, Redis, Kafka ready');
          } else {
            endStep(false, 'Infrastructure start failed (continuing anyway)');
          }
        }

        testResults = await runTests(tmpDir, { nvmBinDir, instructionFile: config.AGENT_INSTRUCTIONS_FILE });
        log(formatTestResults(testResults));
        if (testResults.skipped) {
          endStep(true, 'No test commands found - skipped');
        } else if (testResults.passed) {
          endStep(true, 'All tests passed');
        } else {
          endStep(false, 'Some tests failed');
        }
      }
    }

    // Commit and push
    startStep(7, `Commit and push ${serviceConfig.repo}/${baseBranch}`);
    const { pushed } = await commitAndPush(tmpDir, featureBranch, ticketKey, ticket.summary, serviceHasInstructionFile, instructionFile);
    if (!pushed) {
      warn('No changes to commit');
      endStep(false, 'No changes');
      return { pr: null, error: 'No changes', claudeSummary, planOutput };
    }
    endStep(true, 'Pushed');

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
    startStep(8, `Create PR for ${serviceConfig.repo}/${baseBranch}`);
    const prDescription = buildPRDescription(claudeSummary, testResults);
    const prResult = await createPR(
      config,
      tmpDir,
      featureBranch,
      baseBranch,
      ticketKey,
      ticket.summary,
      prDescription
    );

    if (prResult?.prId) {
      const action = prResult.alreadyExists ? 'updated' : 'created';
      log(`PR #${prResult.prId} ${action}`);
      endStep(true, `PR #${prResult.prId} (${action})`);
      return { pr: { prId: prResult.prId, prUrl: prResult.prUrl, baseBranch, version }, claudeSummary, planOutput };
    }

    warn('PR creation failed');
    endStep(false, 'PR creation failed');
    return { pr: null, error: 'PR creation failed', claudeSummary, planOutput };

  } finally {
    if (tmpDir) {
      cleanup(tmpDir);
    }
  }
}

/**
 * Process a single service with a single target branch.
 *
 * Returns { prs: [...], failures: [...], claudeSummary }
 */
async function processServiceSingleBranch(config, ticket, serviceConfig, repoUrl, ticketKey, runCtx = {}) {
  const result = await processBranch(config, ticket, serviceConfig, repoUrl, ticketKey, ticket.targetBranch, null, runCtx);
  return {
    prs: result.pr ? [result.pr] : [],
    failures: result.error ? [{ baseBranch: ticket.targetBranch, error: result.error }] : [],
    claudeSummary: result.claudeSummary || '',
    planOutput: result.planOutput || '',
  };
}

/**
 * Process a single service with multiple target branches.
 * Each branch gets a fresh clone, fully processes, and cleans up before the next starts.
 *
 * Returns { prs: [...], failures: [...], claudeSummary }
 */
async function processServiceMultiBranch(config, ticket, serviceConfig, repoUrl, ticketKey, runCtx = {}) {
  const prs = [];
  const failures = [];
  let claudeSummary = '';
  let planOutput = '';

  for (const branchInfo of ticket.targetBranches) {
    log(`\n  Processing ${serviceConfig.repo} / ${branchInfo.branch}`);

    try {
      const result = await processBranch(
        config, ticket, serviceConfig, repoUrl, ticketKey, branchInfo.branch, branchInfo.version, runCtx
      );

      if (result.pr) {
        prs.push(result.pr);
      } else if (result.error) {
        failures.push({ baseBranch: branchInfo.branch, error: result.error });
      }

      if (result.claudeSummary && !claudeSummary) {
        claudeSummary = result.claudeSummary;
      }
      if (result.planOutput && !planOutput) {
        planOutput = result.planOutput;
      }
    } catch (branchError) {
      err(`Failed to process ${branchInfo.branch}: ${branchError.message}`);
      failures.push({ baseBranch: branchInfo.branch, error: branchError.message });
    }
  }

  return { prs, failures, claudeSummary, planOutput };
}

export default { processTicket };
