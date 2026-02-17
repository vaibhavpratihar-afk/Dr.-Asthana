/**
 * JIRA CLI Operations
 *
 * Uses jira-cli.mjs for transitions and comments. The CLI handles:
 *   - REST API first (fast path)
 *   - Automatic browser fallback for hasScreen transitions (Dev Testing, etc.)
 *   - QC Report validators, attachment fields, etc.
 *   - Markdown → ADF conversion for comments
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { log, warn, debug } from '../logger.js';

const JIRA_CREATOR_DIR = process.env.JIRA_CREATOR_DIR || path.join(os.homedir(), 'Desktop', 'jira-creator');
const TRANSITION_TIMEOUT = 2 * 60 * 1000; // 2 minutes per transition
const COMMENT_TIMEOUT = 60 * 1000; // 1 minute for comments

/**
 * Generic runner for jira-cli.mjs commands.
 * Never throws; returns { success, output, exitCode }.
 */
async function runJiraCli(args, label, timeoutMs = COMMENT_TIMEOUT) {
  log(`[jira-cli:${label}] Running: node jira-cli.mjs ${args.join(' ').substring(0, 80)}...`);

  try {
    const result = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const proc = spawn('node', ['jira-cli.mjs', ...args], {
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
        reject(new Error(`jira-cli (${label}) timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeoutId);
        log(`[jira-cli:${label}] finished: exit=${code}`);
        if (stderr.trim()) {
          debug(`[jira-cli:${label}:stderr] ${stderr.trim().substring(0, 500)}`);
        }
        resolve({ output: stdout, exitCode: code });
      });

      proc.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to spawn jira-cli.mjs (${label}): ${error.message}`));
      });
    });

    const success = result.exitCode === 0;
    if (!success) {
      warn(`[jira-cli:${label}] exited with code ${result.exitCode}`);
      debug(`[jira-cli:${label}] Output: ${result.output.substring(0, 500)}`);
    }

    return { success, output: result.output, exitCode: result.exitCode };

  } catch (error) {
    warn(`[jira-cli:${label}] Failed: ${error.message}`);
    return { success: false, output: error.message, exitCode: null };
  }
}

/**
 * Run a JIRA transition via jira-cli.mjs.
 * Thin wrapper around runJiraCli for transitions.
 */
function runJiraCliTransition(ticketKey, transitionName, label) {
  return runJiraCli(['transition', ticketKey, transitionName], label, TRANSITION_TIMEOUT);
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

/**
 * Post a Markdown comment to a JIRA ticket via jira-cli.mjs.
 * Writes markdown to a temp file, passes it with --file flag.
 * Non-blocking: catches all errors, logs warnings, never throws.
 *
 * @param {string} ticketKey - e.g. "JCP-1234"
 * @param {string} markdownText - Comment body in Markdown
 * @returns {Promise<boolean>} true if posted successfully
 */
export async function postComment(ticketKey, markdownText) {
  const tmpFile = path.join(os.tmpdir(), `jira-comment-${ticketKey}-${Date.now()}.md`);

  try {
    await fs.writeFile(tmpFile, markdownText, 'utf-8');

    const result = await runJiraCli(
      ['comment', 'add', ticketKey, '--file', tmpFile],
      `comment-${ticketKey}`,
      COMMENT_TIMEOUT
    );

    return result.success;
  } catch (error) {
    warn(`Failed to post comment to ${ticketKey}: ${error.message}`);
    return false;
  } finally {
    try {
      await fs.unlink(tmpFile);
    } catch { /* temp file cleanup is best-effort */ }
  }
}
