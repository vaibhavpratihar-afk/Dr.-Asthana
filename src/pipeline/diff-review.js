/**
 * Post-execution diff review loop.
 *
 * Completely isolated from council context — sees only the raw diff and original
 * ticket requirements. Acts as an independent adversarial reviewer before PR creation.
 *
 * Loop: review → targeted fix → review → ... until APPROVED or maxRetries exhausted.
 * If maxRetries exhausted without approval, the run fails — no PR is created.
 */

import { execSync } from 'child_process';
import { runAI } from '../ai-provider/index.js';
import { getPersona } from '../personas/index.js';
import * as logger from '../utils/logger.js';

const MAX_DIFF_BYTES = 150_000;
const DEFAULT_MAX_RETRIES = 5;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run the adversarial diff review loop.
 * Keeps fixing and re-reviewing until APPROVED or maxRetries hit.
 *
 * @param {string} tmpDir   - Working directory with uncommitted executor changes
 * @param {object} ticket   - Parsed ticket object
 * @param {object} config   - Full pipeline config
 * @returns {Promise<{approved: boolean, attempts: number, finalIssues: string, skipped: boolean}>}
 */
export async function runDiffReviewLoop(tmpDir, ticket, config) {
  const maxRetries = config.diffReview?.maxRetries ?? DEFAULT_MAX_RETRIES;

  // First check: is there even a diff?
  const diff = getDiff(tmpDir);
  if (!diff) {
    logger.warn('[diff-review] Empty diff — skipping loop');
    return { approved: true, attempts: 0, finalIssues: '', skipped: true };
  }

  let attempt = 0;
  let lastIssues = '';

  while (attempt <= maxRetries) {
    attempt++;
    logger.log(`[diff-review] Review attempt ${attempt}/${maxRetries + 1}`);

    const review = await review_once(tmpDir, ticket, config, `diff-review-r${attempt}`);

    if (review.skipped) {
      return { approved: true, attempts: attempt, finalIssues: '', skipped: true };
    }

    if (review.approved) {
      logger.ok(`[diff-review] APPROVED after ${attempt} attempt(s)`);
      return { approved: true, attempts: attempt, finalIssues: '', skipped: false };
    }

    lastIssues = review.issues;
    logger.warn(`[diff-review] NEEDS_CHANGES (attempt ${attempt})`);

    if (attempt > maxRetries) break;

    // Run a targeted fix pass for the flagged issues
    logger.log(`[diff-review] Running targeted fix pass ${attempt}...`);
    await runFixPass(tmpDir, review.issues, config, attempt);
  }

  logger.err(`[diff-review] Could not reach APPROVED after ${maxRetries + 1} attempts — run will fail`);
  return { approved: false, attempts: attempt, finalIssues: lastIssues, skipped: false };
}

// ─── Internal ────────────────────────────────────────────────────────────────

function getDiff(tmpDir) {
  try {
    const stat = execSync('git diff --stat HEAD', { cwd: tmpDir, encoding: 'utf8', timeout: 15_000 }).trim();
    return stat || null;
  } catch {
    return null;
  }
}

async function review_once(tmpDir, ticket, config, label) {
  let diffStat, diffFull;

  try {
    diffStat = execSync('git diff --stat HEAD', { cwd: tmpDir, encoding: 'utf8', timeout: 15_000 }).trim();
    diffFull = execSync('git diff HEAD --unified=3', { cwd: tmpDir, encoding: 'utf8', timeout: 30_000 });
  } catch (e) {
    logger.warn(`[diff-review] Could not get git diff: ${e.message} — skipping`);
    return { approved: true, issues: '', skipped: true };
  }

  if (!diffFull.trim()) {
    return { approved: true, issues: '', skipped: true };
  }

  const truncated = diffFull.length > MAX_DIFF_BYTES;
  const diffContent = truncated
    ? diffFull.slice(0, MAX_DIFF_BYTES) + `\n\n[DIFF TRUNCATED — showing first ${MAX_DIFF_BYTES.toLocaleString()} of ${diffFull.length.toLocaleString()} bytes]`
    : diffFull;

  logger.log(`[diff-review] Diff: ${diffFull.length.toLocaleString()} chars${truncated ? ' (truncated)' : ''}`);

  const persona = getPersona('diffReviewer');
  const prompt = buildReviewPrompt(persona, ticket, diffStat, diffContent);

  const reviewerConfig = { provider: 'codex', model: 'gpt-5.3-codex', timeoutMinutes: 10 };

  const result = await runAI({
    prompt,
    workingDir: tmpDir,
    mode: 'execute',
    label,
    logDir: config.agent.logDir,
    ticketKey: config._currentTicketKey,
    config,
    providerConfig: reviewerConfig,
  });

  const output = result.output || '';
  const approved = /\bAPPROVED\b/m.test(output) && !/\bNEEDS_CHANGES\b/m.test(output);
  const issues = output.replace(/\n*\b(APPROVED|NEEDS_CHANGES)\b[^\n]*$/m, '').trim();

  if (!approved && issues) {
    logger.warn(`[diff-review] Issues:\n${issues.slice(0, 500)}${issues.length > 500 ? '…' : ''}`);
  }

  return { approved, issues, skipped: false };
}

async function runFixPass(tmpDir, issues, config, attempt) {
  const executorPersona = getPersona('executorPrompt');
  const prompt = buildFixPrompt(executorPersona, issues);

  const executorConfig = config.aiProvider?.execute?.codex
    ? { provider: 'codex', ...config.aiProvider.execute.codex }
    : { provider: 'codex', model: 'gpt-5.3-codex', timeoutMinutes: 15 };

  const result = await runAI({
    prompt,
    workingDir: tmpDir,
    mode: 'execute',
    label: `diff-fix-r${attempt}`,
    logDir: config.agent.logDir,
    ticketKey: config._currentTicketKey,
    config,
    providerConfig: executorConfig,
  });

  if (!result.output) {
    logger.warn(`[diff-fix] Fix pass ${attempt} produced no output`);
  } else {
    logger.log(`[diff-fix] Fix pass ${attempt} complete (${result.output.length} chars)`);
  }
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

function buildReviewPrompt(persona, ticket, diffStat, diffContent) {
  return [
    persona,
    '',
    '---',
    '',
    '## Ticket Requirements (your only source of truth for what should have been done)',
    '',
    ticket.description,
    '',
    '---',
    '',
    '## Diff Statistics',
    '',
    diffStat,
    '',
    '---',
    '',
    '## Full Diff',
    '',
    '```diff',
    diffContent,
    '```',
  ].join('\n');
}

function buildFixPrompt(executorPersona, issues) {
  return [
    executorPersona,
    '',
    '---',
    '',
    '## Your task: fix the following specific issues only',
    '',
    'An adversarial reviewer found these problems in the code changes already made.',
    'Fix ONLY the issues listed below. Do not re-run any previous transformation.',
    'Do not change any lines not directly related to the listed issues.',
    'For each issue you are given: the file path, the broken code, and the reason it is wrong.',
    '',
    '---',
    '',
    issues,
    '',
    '---',
    '',
    'After fixing, run the verification commands from the issue descriptions (if any) to confirm the fixes are correct.',
    'Do not introduce any new logic, imports, or refactoring beyond the minimal fix for each listed issue.',
  ].join('\n');
}
