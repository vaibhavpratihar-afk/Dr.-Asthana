/**
 * JIRA Status Transitions
 *
 * Uses direct REST API calls with status verification.
 * Falls back to Claude Code headless subprocess only for Dev Testing
 * (which requires browser-based form submission).
 *
 * Two transitions:
 *   1. In-Progress  — direct REST API + verify
 *   2. LEAD REVIEW  — two-step: Dev Testing (browser) → EM Review (API + verify)
 */

import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { log, warn, debug } from '../logger.js';
import { transitionTicket, getTicketStatus } from './jira.js';

const JIRA_CREATOR_DIR = path.join(os.homedir(), 'Desktop', 'jira-creator');
const TRANSITION_TIMEOUT = 2 * 60 * 1000; // 2 minutes per transition

/**
 * Core spawner — runs Claude Code headless against jira-creator directory.
 * Still needed for Dev Testing (browser-based transition).
 * Never throws; returns { success, output, exitCode }.
 */
async function spawnClaudeForTransition(prompt, label) {
  log(`[transition:${label}] Spawning Claude for JIRA transition...`);
  debug(`[transition:${label}] Prompt: ${prompt.substring(0, 200)}...`);

  const args = [
    '-p', prompt,
    '--max-turns', '3',
    '--output-format', 'text',
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  try {
    const result = await new Promise((resolve, reject) => {
      let rawOutput = '';

      const proc = spawn('claude', args, {
        cwd: JIRA_CREATOR_DIR,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      proc.stdin.end();

      proc.stdout.on('data', (data) => {
        rawOutput += data.toString();
      });

      proc.stderr.on('data', (data) => {
        debug(`[transition:${label}:stderr] ${data.toString().trim().substring(0, 200)}`);
      });

      const timeoutId = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Transition (${label}) timed out after 2 minutes`));
      }, TRANSITION_TIMEOUT);

      proc.on('close', (code) => {
        clearTimeout(timeoutId);
        log(`[transition:${label}] Claude finished: exit=${code}`);
        resolve({ output: rawOutput, exitCode: code });
      });

      proc.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to spawn Claude for transition (${label}): ${error.message}`));
      });
    });

    const success = result.exitCode === 0;
    if (!success) {
      warn(`[transition:${label}] Claude exited with code ${result.exitCode}`);
      debug(`[transition:${label}] Output: ${result.output.substring(0, 500)}`);
    }

    return { success, output: result.output, exitCode: result.exitCode };

  } catch (error) {
    warn(`[transition:${label}] Failed: ${error.message}`);
    return { success: false, output: error.message, exitCode: null };
  }
}

/**
 * Transition ticket to In-Progress via direct REST API.
 * Verifies actual status after transition.
 *
 * @param {object} config - Configuration object with JIRA credentials
 * @param {string} ticketKey - e.g. "JCP-1234"
 * @returns {Promise<boolean>} true if transitioned (or already in status)
 */
export async function transitionToInProgress(config, ticketKey) {
  log(`Transitioning ${ticketKey} to In-Progress...`);

  // Check current status first
  const currentStatus = await getTicketStatus(config, ticketKey);
  if (currentStatus) {
    log(`${ticketKey} current status: "${currentStatus}"`);
    if (currentStatus.toLowerCase().includes('in-progress') || currentStatus.toLowerCase().includes('in progress')) {
      log(`${ticketKey} is already In-Progress`);
      return true;
    }
  }

  // Attempt direct API transition
  const transitioned = await transitionTicket(config, ticketKey, 'In-Progress');

  if (!transitioned) {
    // May already be in a status where In-Progress isn't available
    warn(`Could not transition ${ticketKey} to In-Progress via API`);
    return false;
  }

  // Verify the transition actually took effect
  const newStatus = await getTicketStatus(config, ticketKey);
  if (newStatus) {
    const isInProgress = newStatus.toLowerCase().includes('in-progress') || newStatus.toLowerCase().includes('in progress');
    if (isInProgress) {
      log(`${ticketKey} verified In-Progress (status: "${newStatus}")`);
      return true;
    }
    warn(`${ticketKey} transition reported success but status is "${newStatus}" (expected In-Progress)`);
    return false;
  }

  // Could not verify but API said success — trust it
  log(`${ticketKey} transition API succeeded (could not verify status)`);
  return true;
}

/**
 * Transition ticket to LEAD REVIEW via two steps:
 *   Step 1: Dev Testing (browser-based via jira-transition.mjs — still uses Claude subprocess)
 *   Step 2: EM Review (direct API + verify)
 *
 * @param {object} config - Configuration object with JIRA credentials
 * @param {string} ticketKey - e.g. "JCP-1234"
 * @returns {Promise<{devTestingDone: boolean, emReviewDone: boolean}>}
 */
export async function transitionToLeadReview(config, ticketKey) {
  log(`Transitioning ${ticketKey} to LEAD REVIEW (Dev Testing → EM Review)...`);

  // Step 1: Dev Testing (browser-based — requires Claude subprocess)
  const devTestingPrompt = `Run the following command to transition JIRA ticket ${ticketKey} to "Dev Testing":

node jira-transition.mjs ${ticketKey} "Dev Testing"

This uses a headless browser to perform the transition. Wait for the command to complete and report whether it succeeded.`;

  const devResult = await spawnClaudeForTransition(devTestingPrompt, `dev-testing-${ticketKey}`);

  if (!devResult.success) {
    warn(`Dev Testing transition failed for ${ticketKey} — skipping EM Review`);
    warn(`Dev Testing output: ${devResult.output.substring(0, 300)}`);
    return { devTestingDone: false, emReviewDone: false };
  }

  // Verify Dev Testing actually changed the status
  const postDevStatus = await getTicketStatus(config, ticketKey);
  if (postDevStatus) {
    log(`${ticketKey} status after Dev Testing: "${postDevStatus}"`);
    if (!postDevStatus.toLowerCase().includes('dev testing') && !postDevStatus.toLowerCase().includes('testing')) {
      warn(`Dev Testing reported success but status is "${postDevStatus}" — attempting EM Review anyway`);
    }
  }

  log(`${ticketKey} Dev Testing transition done, waiting 3s for JIRA to process...`);
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Step 2: EM Review (direct API)
  const emTransitioned = await transitionTicket(config, ticketKey, 'EM Review');

  if (!emTransitioned) {
    warn(`EM Review transition failed for ${ticketKey} via API`);
    return { devTestingDone: true, emReviewDone: false };
  }

  // Verify EM Review status
  const postEmStatus = await getTicketStatus(config, ticketKey);
  if (postEmStatus) {
    const isEmReview = postEmStatus.toLowerCase().includes('em review') || postEmStatus.toLowerCase().includes('lead review');
    if (isEmReview) {
      log(`${ticketKey} verified EM Review (status: "${postEmStatus}")`);
    } else {
      warn(`${ticketKey} EM Review transition reported success but status is "${postEmStatus}"`);
    }
  }

  log(`${ticketKey} transitioned to EM Review (LEAD REVIEW)`);
  return { devTestingDone: true, emReviewDone: true };
}
