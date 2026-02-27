/**
 * PR review via an independent council.
 *
 * This council is separate from the feature-planning council and only sees
 * ticket + diff context needed for code review.
 */

import { execSync } from 'child_process';
import path from 'path';
import { createCouncil } from '../council/index.js';
import { buildTicketContext } from './ticket-context.js';
import { buildProposerPrompt, buildCriticPrompt, buildAgreementPrompt } from './council-prompts.js';
import { log, warn } from '../utils/logger.js';

const REVIEW_MARKERS = {
  start: '=== PR REVIEW START ===',
  end: '=== PR REVIEW END ===',
};

const REVIEW_PROPOSER_ROLE =
  'You are a strict PR reviewer. Review only the provided git diff and changed files. ' +
  'Identify correctness risks, regressions, missing tests, incomplete updates, and unsafe behavior. ' +
  'Do not suggest broad refactors unrelated to the diff. ' +
  'Output findings with severity as CRITICAL or WARNING, each with file path and exact reason.';

const REVIEW_CRITIC_ROLE =
  'You are an adversarial PR reviewer. Challenge the proposer and find misses. ' +
  'You must verify claims directly against the diff/context and add missing findings. ' +
  'Prioritize concrete, merge-blocking defects over style nits. ' +
  'Each finding must include severity (CRITICAL/WARNING), file path, and rationale.';

function buildReviewExtractorPrompt(councilOutput, context, force) {
  const modeInstruction = force
    ? 'Produce best-effort review output even if debate quality is imperfect.'
    : 'Reject if findings are vague or missing file-specific evidence.';

  return `You are evaluating a PR review debate output.

## Context
${context}

## Debate Output
${councilOutput}

## Task
${modeInstruction}

Return exactly one of:
1. "APPROVED" + a review report between markers, or
2. "REJECTED" + feedback after === FEEDBACK ===.

The review report MUST be between ${REVIEW_MARKERS.start} and ${REVIEW_MARKERS.end} and follow:
- Verdict: APPROVE or REJECT
- Critical Findings:
  - <file>: <issue>
- Warning Findings:
  - <file>: <issue>
- Summary: <short sentence>

If no findings exist, use "None" under each findings section and verdict APPROVE.`;
}

function parseFindingsSection(report, heading) {
  const pattern = new RegExp(`${heading}\\s*:\\s*([\\s\\S]*?)(?:\\n[A-Z][A-Za-z ]+:|$)`, 'i');
  const match = report.match(pattern);
  if (!match) return [];

  return match[1]
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter((line) => line && !/^none$/i.test(line));
}

function buildReviewContext(ticketData, cloneDir, preWarnings = []) {
  let diffStat = '';
  let changedFiles = '';
  let fullDiff = '';

  try {
    diffStat = execSync('git diff --stat HEAD', {
      cwd: cloneDir, encoding: 'utf-8', stdio: 'pipe', timeout: 20000,
    }).trim();
  } catch {
    diffStat = '';
  }

  try {
    changedFiles = execSync('git diff --name-only HEAD', {
      cwd: cloneDir, encoding: 'utf-8', stdio: 'pipe', timeout: 20000,
    }).trim();
  } catch {
    changedFiles = '';
  }

  try {
    fullDiff = execSync('git diff HEAD', {
      cwd: cloneDir, encoding: 'utf-8', stdio: 'pipe', timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    fullDiff = '';
  }

  const limitedDiff = fullDiff.length > 120000
    ? `${fullDiff.slice(0, 120000)}\n\n[DIFF TRUNCATED]`
    : fullDiff;

  const preWarningsText = preWarnings.length > 0
    ? preWarnings.map((w) => `- ${w}`).join('\n')
    : 'None';

  return [
    buildTicketContext(ticketData),
    '## Pre-Review Structural Warnings',
    preWarningsText,
    '',
    '## Diff Stat',
    diffStat || 'No diff stat',
    '',
    '## Changed Files',
    changedFiles || 'No changed files',
    '',
    '## Git Diff',
    limitedDiff || 'No diff',
  ].join('\n');
}

function buildPrReviewCouncilConfig(config) {
  if (!config.prReviewCouncil) return config;
  return {
    ...config,
    council: config.prReviewCouncil,
  };
}

/**
 * Run a dedicated PR-review council on current diff.
 *
 * @returns {Promise<{status:'approved'|'rejected', critical:string[], warnings:string[], summary:string, reason?:string}>}
 */
export async function reviewPullRequest(ticketData, cloneDir, config, options = {}) {
  const { checkpointDir, ticketKey, preWarnings = [] } = options;
  const reviewContext = buildReviewContext(ticketData, cloneDir, preWarnings);
  const reviewCheckpointDir = checkpointDir ? path.join(checkpointDir, 'pr-review') : undefined;

  log('Starting PR review council...');

  const council = createCouncil({
    goal: 'Review this proposed PR diff and decide if it is safe to ship.',
    context: reviewContext,
    workingDir: cloneDir,
    roles: {
      proposer: REVIEW_PROPOSER_ROLE,
      critic: REVIEW_CRITIC_ROLE,
    },
    prompts: {
      buildProposer: buildProposerPrompt,
      buildCritic: buildCriticPrompt,
      buildAgreement: buildAgreementPrompt,
    },
    evaluation: {
      buildAiPrompt: buildReviewExtractorPrompt,
      outputMarkers: REVIEW_MARKERS,
      forceOnLastRound: true,
    },
    config: buildPrReviewCouncilConfig(config),
    label: ticketKey ? `${ticketKey}-pr-review` : 'pr-review',
    checkpointDir: reviewCheckpointDir,
  });

  const result = await council.run();

  if (!result.passed || !result.output) {
    const reason = result.feedback || 'PR review council failed to produce a usable review';
    warn(`PR review council rejected: ${reason}`);
    return {
      status: 'rejected',
      critical: [`PR review council rejected output: ${reason}`],
      warnings: [],
      reason,
      summary: 'PR review council rejected',
    };
  }

  const reviewReport = result.output;
  const verdictMatch = reviewReport.match(/Verdict\s*:\s*(APPROVE|REJECT)/i);
  const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : 'REJECT';

  const critical = parseFindingsSection(reviewReport, 'Critical Findings');
  const warnings = parseFindingsSection(reviewReport, 'Warning Findings');

  const summaryMatch = reviewReport.match(/Summary\s*:\s*(.*)/i);
  const summary = summaryMatch?.[1]?.trim() || `PR review completed in ${result.rounds} round(s)`;

  if (verdict === 'REJECT' || critical.length > 0) {
    return {
      status: 'rejected',
      critical,
      warnings,
      summary,
      reason: 'PR review found merge-blocking issues',
    };
  }

  return {
    status: 'approved',
    critical: [],
    warnings,
    summary,
  };
}
