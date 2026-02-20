/**
 * Notifications
 *
 * Builds JIRA comments (Markdown for jira-cli.mjs), PR descriptions, and
 * sends Slack notifications. Comment posting is handled by jira-cli.mjs
 * which converts Markdown to ADF automatically.
 */

import { execSync } from 'child_process';
import { log, warn, err } from '../logger.js';
import { summariseText } from './summariser.js';


/**
 * Upload a log file to Pixelbin CDN and return the URL.
 * Returns null on failure — upload errors should never block the pipeline.
 */
export function uploadLogFile(logFilePath) {
  if (!logFilePath) return null;

  try {
    const output = execSync(
      `~/.local/bin/pixelbin-upload ${logFilePath} --json --unique --format raw --no-progress`,
      { encoding: 'utf-8', timeout: 30000, shell: '/bin/bash' }
    );
    const parsed = JSON.parse(output);
    const url = parsed.url || parsed.cdnUrl || null;
    if (url) {
      log(`Log file uploaded: ${url}`);
    }
    return url;
  } catch (error) {
    warn(`Log file upload failed (non-blocking): ${error.message}`);
    return null;
  }
}

/**
 * Build PR description including Claude's summary and test results
 */
export function buildPRDescription(claudeSummary, testResults) {
  let description = claudeSummary || '';

  if (!testResults.skipped) {
    description += '\n\n## Test Results\n';
    if (testResults.passed) {
      description += '✓ All tests passed\n';
    } else {
      description += '⚠ Some tests failed:\n';
      for (const result of testResults.results) {
        const status = result.success ? '✓' : '✗';
        description += `- ${status} ${result.name}\n`;
        if (!result.success && result.error) {
          const errorSummary = summariseText(result.error, {
            mode: 'custom',
            maxChars: 1200,
            style: 'concise',
            extra: 'Preserve the key failing assertion, stack frame, file path, and line number.',
            label: `test-error:${result.name}`,
          });
          description += `\`\`\`\n${errorSummary}\n\`\`\`\n`;
        }
      }
    }
  }

  return description;
}

/**
 * Build a Markdown JIRA comment with PR table and summary.
 * Returns a Markdown string (posted via jira-cli.mjs).
 */
export function buildJiraComment(config, allPRs, allFailures, claudeSummary, logUrl) {
  const azdoBase = config.AZDO_ORG;
  const project = config.AZDO_PROJECT;

  const lines = [];

  lines.push(`### Dr. Asthana — ${allPRs.length} PR(s) created`);
  lines.push('');

  // PR table
  lines.push('| Service | Branch | PR |');
  lines.push('| --- | --- | --- |');
  for (const pr of allPRs) {
    const repo = pr.service;
    const prUrl = pr.prUrl || `${azdoBase}/${project}/_git/${repo}/pullrequest/${pr.prId}`;
    lines.push(`| ${repo} | ${pr.baseBranch} | [#${pr.prId}](${prUrl}) |`);
  }
  lines.push('');

  // Summary from Claude
  if (claudeSummary) {
    const summaryMatch = claudeSummary.match(/\*\*SUMMARY:\*\*\s*([\s\S]*?)(?=\n\*\*|$)/i);
    const rawSummary = summaryMatch ? summaryMatch[1].trim() : claudeSummary;
    const briefSummary = summariseText(rawSummary, {
      mode: 'jira-comment',
      maxChars: 1500,
      style: 'detailed',
      extra: 'Retain concrete implementation details and key caveats.',
      label: 'jira-comment-summary',
    });
    lines.push(`**What was done:** ${briefSummary}`);
    lines.push('');
  }

  // Failures
  if (allFailures.length > 0) {
    lines.push(':::warning');
    lines.push('**Failed:**');
    for (const f of allFailures) {
      lines.push(`- **${f.service}/${f.baseBranch}** — ${f.error}`);
    }
    lines.push(':::');
    lines.push('');
  }

  // Run log link
  if (logUrl) {
    lines.push(`**Run Log:** [View full run log](${logUrl})`);
  }

  return lines.join('\n');
}

/**
 * Build a Markdown comment for the In-Progress transition.
 * Shows what the agent parsed and plans to work on.
 * Returns a Markdown string (posted via jira-cli.mjs).
 */
export function buildInProgressComment(config, ticket) {
  const lines = [];

  lines.push('### Dr. Asthana — Starting implementation');
  lines.push('');
  lines.push(`**Summary:** ${ticket.summary}`);
  lines.push('');

  if (ticket.description && ticket.description !== 'No description provided') {
    const descriptionSummary = summariseText(ticket.description, {
      mode: 'jira-comment',
      maxChars: 2000,
      style: 'detailed',
      extra: 'Keep acceptance criteria, version constraints, and explicit do/dont rules.',
      label: 'in-progress-description',
    });
    lines.push(`**Description:** ${descriptionSummary}`);
    lines.push('');
  }

  // Service / Branch table
  if (ticket.affectedSystems && ticket.affectedSystems.length > 0) {
    const branches = ticket.targetBranches && ticket.targetBranches.length > 1
      ? ticket.targetBranches.map(tb => tb.branch)
      : [ticket.targetBranch].filter(Boolean);

    lines.push('| Service | Repository | Target Branch(es) |');
    lines.push('| --- | --- | --- |');
    for (const system of ticket.affectedSystems) {
      const serviceConfig = config.SERVICES[system] || {};
      lines.push(`| ${system} | ${serviceConfig.repo || system} | ${branches.join(', ') || 'N/A'} |`);
    }
    lines.push('');
  }

  lines.push(`**Scope:** ${ticket.affectedSystems.length} service(s) — ${ticket.affectedSystems.join(', ')}`);

  return lines.join('\n');
}

/**
 * Build a Markdown comment for the LEAD REVIEW transition.
 * Shows implementation plan, files changed, summary, and PR table.
 * Returns a Markdown string (posted via jira-cli.mjs).
 */
export function buildLeadReviewComment(config, allPRs, claudeSummary, planOutput) {
  const azdoBase = config.AZDO_ORG;
  const project = config.AZDO_PROJECT;

  const lines = [];

  lines.push('### Dr. Asthana — Implementation complete');
  lines.push('');

  // Plan section
  if (planOutput) {
    lines.push('#### Implementation Plan');
    lines.push('');
    lines.push(summariseText(planOutput, {
      mode: 'jira-comment',
      maxChars: 8000,
      style: 'detailed',
      extra: 'Preserve phase order, file paths, and execution dependencies.',
      label: 'lead-review-plan',
    }));
    lines.push('');
  }

  // Extract FILES CHANGED and SUMMARY from Claude's output
  if (claudeSummary) {
    const filesMatch = claudeSummary.match(/\*\*FILES CHANGED[:\*]*\*?\*?\s*([\s\S]*?)(?=\n\*\*|$)/i);
    if (filesMatch) {
      lines.push('#### Files Changed');
      lines.push('');
      lines.push(filesMatch[1].trim());
      lines.push('');
    }

    const summaryMatch = claudeSummary.match(/\*\*SUMMARY[:\*]*\*?\*?\s*([\s\S]*?)(?=\n\*\*|$)/i);
    if (summaryMatch) {
      lines.push(`**Summary:** ${summaryMatch[1].trim()}`);
      lines.push('');
    }
  }

  // PR table
  if (allPRs.length > 0) {
    lines.push('| Service | Branch | PR |');
    lines.push('| --- | --- | --- |');
    for (const pr of allPRs) {
      const repo = pr.service;
      const prUrl = pr.prUrl || `${azdoBase}/${project}/_git/${repo}/pullrequest/${pr.prId}`;
      lines.push(`| ${repo} | ${pr.baseBranch} | [#${pr.prId}](${prUrl}) |`);
    }
  }

  return lines.join('\n');
}

/**
 * Send a Slack DM with all PRs listed (not just the first one).
 */
export async function notifyAllPRs(config, ticketKey, ticketSummary, allPRs, allFailures, claudeSummary, logUrl) {
  if (!config.SLACK_BOT_TOKEN || !config.SLACK_USER_ID) {
    warn('Slack not configured, skipping notification');
    return;
  }

  const { WebClient } = await import('@slack/web-api');
  const client = new WebClient(config.SLACK_BOT_TOKEN);

  try {
    const conversation = await client.conversations.open({ users: config.SLACK_USER_ID });
    const dmChannelId = conversation.channel.id;

    const azdoBase = config.AZDO_ORG;
    const project = config.AZDO_PROJECT;

    // Build per-PR lines with links
    const prLines = allPRs.map(pr => {
      const repo = pr.service;
      const prUrl = pr.prUrl || `${azdoBase}/${project}/_git/${repo}/pullrequest/${pr.prId}`;
      return `• <${prUrl}|#${pr.prId}> → ${repo} / \`${pr.baseBranch}\``;
    });

    // Extract brief summary
    let briefSummary = '';
    if (claudeSummary) {
      const summaryMatch = claudeSummary.match(/\*\*SUMMARY:\*\*\s*([\s\S]*?)(?=\n\*\*|$)/i);
      const rawSummary = summaryMatch ? summaryMatch[1].trim() : claudeSummary;
      briefSummary = summariseText(rawSummary, {
        mode: 'slack-message',
        maxChars: 1800,
        style: 'balanced',
        extra: 'Keep concrete outcomes and reviewer-relevant risk notes.',
        label: 'slack-brief-summary',
      });
    }

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `Dr. Asthana — ${allPRs.length} PR(s) created`, emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Ticket:* <${config.JIRA_BASE_URL}/browse/${ticketKey}|${ticketKey}> — ${ticketSummary}`,
        },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: prLines.join('\n') },
      },
    ];

    if (briefSummary) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*What was done:* ${briefSummary}` },
      });
    }

    if (allFailures.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:warning: *Failed:* ${allFailures.map(f => `${f.service}/${f.baseBranch}`).join(', ')}`,
        },
      });
    }

    if (logUrl) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `:page_facing_up: <${logUrl}|View full run log>` }],
      });
    }

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: ':eyes: _Please review the draft PRs before merging_' }],
    });

    await client.chat.postMessage({
      channel: dmChannelId,
      text: `${allPRs.length} PR(s) created for ${ticketKey}`,
      blocks,
    });

    log(`Slack notification sent for ${ticketKey}`);
  } catch (error) {
    err(`Failed to send Slack notification: ${error.message}`);
  }
}

/**
 * Send a Slack DM notification for a failure
 */
export async function notifyFailure(config, ticketKey, ticketSummary, errorMessage, logUrl) {
  if (!config.SLACK_BOT_TOKEN || !config.SLACK_USER_ID) {
    return;
  }

  const { WebClient } = await import('@slack/web-api');
  const client = new WebClient(config.SLACK_BOT_TOKEN);

  try {
    const conversation = await client.conversations.open({
      users: config.SLACK_USER_ID,
    });
    const dmChannelId = conversation.channel.id;

    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: ':warning: Dr. Asthana Failed',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Ticket:* <${config.JIRA_BASE_URL}/browse/${ticketKey}|${ticketKey}>\n*Summary:* ${ticketSummary}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Error:*\n\`\`\`${summariseText(errorMessage, {
            mode: 'slack-message',
            maxChars: 1200,
            style: 'concise',
            extra: 'Preserve error type, root cause hint, and any quota/reset details.',
            label: 'slack-failure-error',
          })}\`\`\``,
        },
      },
      ...(logUrl ? [{
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `:page_facing_up: <${logUrl}|View full run log>` }],
      }] : []),
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: ':point_right: _Manual intervention may be required_',
          },
        ],
      },
    ];

    await client.chat.postMessage({
      channel: dmChannelId,
      text: `Dr. Asthana failed for ${ticketKey}: ${errorMessage}`,
      blocks,
    });

    log(`Slack failure notification sent for ${ticketKey}`);
  } catch (error) {
    err(`Failed to send Slack failure notification: ${error.message}`);
  }
}
