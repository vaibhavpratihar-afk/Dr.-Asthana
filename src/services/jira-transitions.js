/**
 * JIRA Status Transitions
 *
 * Uses jira-cli.mjs for all transitions. The CLI handles:
 *   - REST API first (fast path)
 *   - Automatic browser fallback for hasScreen transitions (Dev Testing, etc.)
 *   - QC Report validators, attachment fields, etc.
 *
 * Two transitions:
 *   1. In-Progress  — jira-cli.mjs transition
 *   2. LEAD REVIEW  — two-step: Dev Testing → EM Review (both via jira-cli.mjs)
 */

import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { log, warn, debug } from '../logger.js';

const JIRA_CREATOR_DIR = process.env.JIRA_CREATOR_DIR || path.join(os.homedir(), 'Desktop', 'jira-creator');
const TRANSITION_TIMEOUT = 2 * 60 * 1000; // 2 minutes per transition

/**
 * Run a JIRA transition via jira-cli.mjs.
 * Handles API-first with automatic browser fallback.
 * Never throws; returns { success, output, exitCode }.
 */
async function runJiraCliTransition(ticketKey, transitionName, label) {
  log(`[transition:${label}] Running jira-cli.mjs transition "${transitionName}"...`);

  const args = ['jira-cli.mjs', 'transition', ticketKey, transitionName];

  try {
    const result = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const proc = spawn('node', args, {
        cwd: JIRA_CREATOR_DIR,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      proc.stdin.end();

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeoutId = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Transition (${label}) timed out after 2 minutes`));
      }, TRANSITION_TIMEOUT);

      proc.on('close', (code) => {
        clearTimeout(timeoutId);
        log(`[transition:${label}] jira-cli.mjs finished: exit=${code}`);
        if (stderr.trim()) {
          debug(`[transition:${label}:stderr] ${stderr.trim().substring(0, 500)}`);
        }
        resolve({ output: stdout, exitCode: code });
      });

      proc.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to spawn jira-cli.mjs for transition (${label}): ${error.message}`));
      });
    });

    const success = result.exitCode === 0;
    if (!success) {
      warn(`[transition:${label}] jira-cli.mjs exited with code ${result.exitCode}`);
      debug(`[transition:${label}] Output: ${result.output.substring(0, 500)}`);
    }

    return { success, output: result.output, exitCode: result.exitCode };

  } catch (error) {
    warn(`[transition:${label}] Failed: ${error.message}`);
    return { success: false, output: error.message, exitCode: null };
  }
}

/**
 * Transition ticket to In-Progress via jira-cli.mjs.
 *
 * @param {object} config - Configuration object (unused, kept for interface compat)
 * @param {string} ticketKey - e.g. "JCP-1234"
 * @returns {Promise<boolean>} true if transitioned successfully
 */
export async function transitionToInProgress(config, ticketKey) {
  log(`Transitioning ${ticketKey} to In-Progress...`);

  const result = await runJiraCliTransition(ticketKey, 'In-Progress', `in-progress-${ticketKey}`);

  if (result.success) {
    log(`${ticketKey} transitioned to In-Progress`);
    return true;
  }

  warn(`Could not transition ${ticketKey} to In-Progress`);
  return false;
}

/**
 * Transition ticket to LEAD REVIEW via two steps:
 *   Step 1: Dev Testing (jira-cli.mjs handles browser fallback automatically)
 *   Step 2: EM Review (jira-cli.mjs handles API call)
 *
 * @param {object} config - Configuration object (unused, kept for interface compat)
 * @param {string} ticketKey - e.g. "JCP-1234"
 * @returns {Promise<{devTestingDone: boolean, emReviewDone: boolean}>}
 */
export async function transitionToLeadReview(config, ticketKey) {
  log(`Transitioning ${ticketKey} to LEAD REVIEW (Dev Testing → EM Review)...`);

  // Step 1: Dev Testing
  const devResult = await runJiraCliTransition(ticketKey, 'Dev Testing', `dev-testing-${ticketKey}`);

  if (!devResult.success) {
    warn(`Dev Testing transition failed for ${ticketKey} — skipping EM Review`);
    return { devTestingDone: false, emReviewDone: false };
  }

  log(`${ticketKey} Dev Testing done, waiting 3s for JIRA to process...`);
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Step 2: EM Review
  const emResult = await runJiraCliTransition(ticketKey, 'EM Review', `em-review-${ticketKey}`);

  if (!emResult.success) {
    warn(`EM Review transition failed for ${ticketKey}`);
    return { devTestingDone: true, emReviewDone: false };
  }

  log(`${ticketKey} transitioned to EM Review (LEAD REVIEW)`);
  return { devTestingDone: true, emReviewDone: true };
}
