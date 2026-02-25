/**
 * Report builder sub-module.
 *
 * All report functions return { jira: string, slack: object[]|null }
 * - jira is markdown string (for JIRA comment via jira-cli.mjs)
 * - slack is Block Kit blocks (for Slack DM) or null if Slack shouldn't fire
 *
 * Uses summariser for char limit compliance.
 */

import { summariseText } from '../utils/summariser.js';
import { execSync } from 'child_process';
import { warn } from '../utils/logger.js';

/** Max chars for a single Slack Block Kit mrkdwn text field. */
const SLACK_MRKDWN_LIMIT = 3000;

/**
 * Sanitize text for Slack Block Kit mrkdwn fields.
 * Strips control characters and truncates to the Block Kit limit.
 */
function sanitizeForSlack(text) {
  if (!text) return '';
  // Strip control chars except newline/tab
  let clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  if (clean.length > SLACK_MRKDWN_LIMIT) {
    clean = clean.substring(0, SLACK_MRKDWN_LIMIT - 3) + '...';
  }
  return clean;
}

/**
 * Safely summarise text — wraps summariseText with try-catch.
 * Falls back to hard truncation on failure.
 */
function safeSummarise(text, opts) {
  try {
    return summariseText(text, opts);
  } catch (e) {
    warn(`Summariser failed for ${opts?.label || 'text'}: ${e.message}. Using hard truncation.`);
    const limit = opts?.limit || 3000;
    if (text && text.length > limit) {
      return text.substring(0, limit - 3) + '...';
    }
    return text || '';
  }
}

/**
 * Upload a log file to Pixelbin CDN and return the URL.
 */
export function uploadLogFile(logFilePath) {
  if (!logFilePath) return null;
  try {
    const output = execSync(
      `~/.local/bin/pixelbin-upload ${logFilePath} --json --unique --format raw --no-progress`,
      { encoding: 'utf-8', timeout: 30000, shell: '/bin/bash' }
    );
    const parsed = JSON.parse(output);
    return parsed.url || parsed.cdnUrl || null;
  } catch (error) {
    warn(`Log file upload failed (non-blocking): ${error.message}`);
    return null;
  }
}

/**
 * Build a step report for a JIRA comment.
 */
export function buildStepReport(stepName, details, timestamp) {
  const time = timestamp || new Date().toISOString();
  const jira = `**Step: ${stepName}** (${time})\n${details}`;
  return { jira, slack: null };
}

/**
 * Build the final report with all PRs, summary, and failures.
 */
export function buildFinalReport(config, allPRs, allFailures, cheatsheetSummary, artifactUrl) {
  const azdoBase = config.azureDevOps.org;
  const project = config.azureDevOps.project;

  // --- JIRA comment ---
  const jiraLines = [];
  jiraLines.push(`### Dr. Asthana — ${allPRs.length} PR(s) created`);
  jiraLines.push('');

  jiraLines.push('| Service | Branch | PR |');
  jiraLines.push('| --- | --- | --- |');
  for (const pr of allPRs) {
    const repo = pr.service;
    const prUrl = pr.prUrl || `${azdoBase}/${project}/_git/${repo}/pullrequest/${pr.prId}`;
    jiraLines.push(`| ${repo} | ${pr.baseBranch} | [#${pr.prId}](${prUrl}) |`);
  }
  jiraLines.push('');

  if (cheatsheetSummary) {
    const briefSummary = summariseText(cheatsheetSummary, {
      preset: 'jira-comment',
      label: 'jira-final-summary',
    });
    jiraLines.push(`**What was done:** ${briefSummary}`);
    jiraLines.push('');
  }

  if (allFailures.length > 0) {
    jiraLines.push(':::warning');
    jiraLines.push('**Failed:**');
    for (const f of allFailures) {
      jiraLines.push(`- **${f.service}/${f.baseBranch}** — ${f.error}`);
    }
    jiraLines.push(':::');
    jiraLines.push('');
  }

  if (artifactUrl) {
    jiraLines.push(`**Run Artifact:** [View run artifact](${artifactUrl})`);
  }

  // --- Slack blocks ---
  const slackBlocks = [];
  slackBlocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `Dr. Asthana — ${allPRs.length} PR(s) created`, emoji: true },
  });

  const prLines = allPRs.map(pr => {
    const repo = pr.service;
    const prUrl = pr.prUrl || `${azdoBase}/${project}/_git/${repo}/pullrequest/${pr.prId}`;
    return `• <${prUrl}|#${pr.prId}> → ${repo} / \`${pr.baseBranch}\``;
  });

  slackBlocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: sanitizeForSlack(prLines.join('\n')) },
  });

  if (cheatsheetSummary) {
    const slackSummary = safeSummarise(cheatsheetSummary, {
      preset: 'slack-message',
      label: 'slack-final-summary',
    });
    slackBlocks.push({ type: 'divider' });
    slackBlocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: sanitizeForSlack(`*What was done:* ${slackSummary}`) },
    });
  }

  if (allFailures.length > 0) {
    slackBlocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: sanitizeForSlack(`:warning: *Failed:* ${allFailures.map(f => `${f.service}/${f.baseBranch}`).join(', ')}`),
      },
    });
  }

  if (artifactUrl) {
    slackBlocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: sanitizeForSlack(`:package: <${artifactUrl}|View run artifact>`) }],
    });
  }

  slackBlocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: ':eyes: _Please review the draft PRs before merging_' }],
  });

  return { jira: jiraLines.join('\n'), slack: slackBlocks };
}

/**
 * Build a rejection report.
 */
export function buildRejectionReport(reason, phase, ticketData) {
  const jira = `### Dr. Asthana — Ticket rejected (${phase})\n\n**Reason:** ${reason}\n\n**Ticket:** ${ticketData.key} — ${ticketData.summary}`;
  return { jira, slack: null };
}

/**
 * Build a failure report.
 */
export function buildFailureReport(error, step, ticketData, artifactUrl) {
  const errorSummary = safeSummarise(typeof error === 'string' ? error : error.message, {
    preset: 'slack-message',
    label: 'failure-error',
  });

  const jiraLines = [
    `### Dr. Asthana — Failed`,
    '',
    `**Step:** ${step}`,
    `**Error:** ${errorSummary}`,
  ];
  if (artifactUrl) {
    jiraLines.push(`**Run Artifact:** [View run artifact](${artifactUrl})`);
  }

  const slackBlocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':warning: Dr. Asthana Failed', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: sanitizeForSlack(`*Ticket:* ${ticketData.key}\n*Summary:* ${ticketData.summary}\n*Error:*\n\`\`\`${errorSummary}\`\`\``),
      },
    },
    ...(artifactUrl ? [{
      type: 'context',
      elements: [{ type: 'mrkdwn', text: sanitizeForSlack(`:package: <${artifactUrl}|View run artifact>`) }],
    }] : []),
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: ':point_right: _Manual intervention may be required_' }],
    },
  ];

  return { jira: jiraLines.join('\n'), slack: slackBlocks };
}

/**
 * Build In-Progress comment (JIRA only).
 */
export function buildInProgressComment(config, ticket) {
  const lines = [];
  lines.push('### Dr. Asthana — Starting implementation');
  lines.push('');
  lines.push(`**Summary:** ${ticket.summary}`);
  lines.push('');

  if (ticket.description && ticket.description !== 'No description provided') {
    const descriptionSummary = safeSummarise(ticket.description, {
      preset: 'jira-comment',
      label: 'in-progress-description',
    });
    lines.push(`**Description:** ${descriptionSummary}`);
    lines.push('');
  }

  if (ticket.affectedSystems && ticket.affectedSystems.length > 0) {
    const branches = ticket.targetBranches && ticket.targetBranches.length > 1
      ? ticket.targetBranches.map(tb => tb.branch)
      : [ticket.targetBranch].filter(Boolean);

    lines.push('| Service | Repository | Target Branch(es) |');
    lines.push('| --- | --- | --- |');
    for (const system of ticket.affectedSystems) {
      const serviceConfig = config.services[system] || {};
      lines.push(`| ${system} | ${serviceConfig.repo || system} | ${branches.join(', ') || 'N/A'} |`);
    }
    lines.push('');
  }

  lines.push(`**Scope:** ${ticket.affectedSystems.length} service(s) — ${ticket.affectedSystems.join(', ')}`);

  return { jira: lines.join('\n'), slack: null };
}

/**
 * Build LEAD REVIEW comment (JIRA only).
 */
export function buildLeadReviewComment(config, allPRs, cheatsheetSummary) {
  const azdoBase = config.azureDevOps.org;
  const project = config.azureDevOps.project;
  const lines = [];

  lines.push('### Dr. Asthana — Implementation complete');
  lines.push('');

  if (cheatsheetSummary) {
    lines.push('#### Implementation Plan');
    lines.push('');
    lines.push(safeSummarise(cheatsheetSummary, {
      preset: 'jira-comment',
      label: 'lead-review-plan',
    }));
    lines.push('');
  }

  if (allPRs.length > 0) {
    lines.push('| Service | Branch | PR |');
    lines.push('| --- | --- | --- |');
    for (const pr of allPRs) {
      const repo = pr.service;
      const prUrl = pr.prUrl || `${azdoBase}/${project}/_git/${repo}/pullrequest/${pr.prId}`;
      lines.push(`| ${repo} | ${pr.baseBranch} | [#${pr.prId}](${prUrl}) |`);
    }
  }

  return { jira: lines.join('\n'), slack: null };
}
