/**
 * Notifications
 *
 * Builds JIRA comments (ADF format), PR descriptions, and sends Slack
 * notifications. Replaces the old slack.js module.
 */

import { log, warn, err } from '../logger.js';

/**
 * Truncate text to a maximum length
 */
function truncate(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

/**
 * Parse inline markdown (**bold** and `code`) into ADF text nodes with marks.
 * Returns an array of { type: 'text', text, marks? } objects.
 */
function parseInlineMarkdown(text) {
  if (!text) return [{ type: 'text', text: '' }];

  const nodes = [];
  // Match **bold** or `code` segments
  const regex = /(\*\*(.+?)\*\*|`([^`]+)`)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Plain text before this match
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: text.substring(lastIndex, match.index) });
    }

    if (match[2]) {
      // **bold**
      nodes.push({ type: 'text', text: match[2], marks: [{ type: 'strong' }] });
    } else if (match[3]) {
      // `code`
      nodes.push({ type: 'text', text: match[3], marks: [{ type: 'code' }] });
    }

    lastIndex = match.index + match[0].length;
  }

  // Trailing plain text
  if (lastIndex < text.length) {
    nodes.push({ type: 'text', text: text.substring(lastIndex) });
  }

  return nodes.length > 0 ? nodes : [{ type: 'text', text }];
}

/**
 * Convert multi-line markdown text into ADF block nodes.
 * Handles `- bullet` lines as bulletList, regular lines as paragraphs.
 */
function markdownToAdfBlocks(text) {
  if (!text) return [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }];

  const lines = text.split('\n');
  const blocks = [];
  let bulletItems = [];

  function flushBullets() {
    if (bulletItems.length > 0) {
      blocks.push({
        type: 'bulletList',
        content: bulletItems.map(item => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseInlineMarkdown(item) }],
        })),
      });
      bulletItems = [];
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushBullets();
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*]\s+(.*)/);
    if (bulletMatch) {
      bulletItems.push(bulletMatch[1]);
    } else {
      flushBullets();
      blocks.push({ type: 'paragraph', content: parseInlineMarkdown(trimmed) });
    }
  }

  flushBullets();
  return blocks.length > 0 ? blocks : [{ type: 'paragraph', content: [{ type: 'text', text }] }];
}

/**
 * Build PR description including Claude's summary and test results
 */
export function buildPRDescription(claudeSummary, testResults) {
  let description = claudeSummary;

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
          description += '```\n' + result.error.substring(0, 500) + '\n```\n';
        }
      }
    }
  }

  return description;
}

/**
 * Build a structured JIRA comment in ADF (Atlassian Document Format).
 * Shows a table of PRs with clickable links, grouped by service.
 */
export function buildJiraComment(config, allPRs, allFailures, claudeSummary) {
  const azdoBase = config.AZDO_ORG || 'https://dev.azure.com/GoFynd';
  const project = config.AZDO_PROJECT || 'FyndPlatformCore';

  const content = [];

  // Header
  content.push({
    type: 'heading',
    attrs: { level: 3 },
    content: [{ type: 'text', text: `Dr. Asthana — ${allPRs.length} PR(s) created` }],
  });

  // PR table: Service | Branch | PR
  const tableRows = [
    // Header row
    {
      type: 'tableRow',
      content: ['Service', 'Branch', 'PR'].map(header => ({
        type: 'tableHeader',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: header, marks: [{ type: 'strong' }] }] }],
      })),
    },
    // Data rows
    ...allPRs.map(pr => {
      const repo = pr.service;
      const prUrl = pr.prUrl || `${azdoBase}/${project}/_git/${repo}/pullrequest/${pr.prId}`;
      return {
        type: 'tableRow',
        content: [
          { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: repo }] }] },
          { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: pr.baseBranch }] }] },
          {
            type: 'tableCell',
            content: [{
              type: 'paragraph',
              content: [{
                type: 'text',
                text: `#${pr.prId}`,
                marks: [{ type: 'link', attrs: { href: prUrl } }],
              }],
            }],
          },
        ],
      };
    }),
  ];

  content.push({ type: 'table', content: tableRows });

  // Summary from Claude (first service only, keep it brief)
  if (claudeSummary) {
    // Extract just the SUMMARY line from Claude's output
    const summaryMatch = claudeSummary.match(/\*\*SUMMARY:\*\*\s*([\s\S]*?)(?=\n\*\*|$)/i);
    const briefSummary = summaryMatch ? summaryMatch[1].trim() : claudeSummary.substring(0, 300);

    content.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'What was done: ', marks: [{ type: 'strong' }] },
        ...parseInlineMarkdown(briefSummary),
      ],
    });
  }

  // Failures
  if (allFailures.length > 0) {
    content.push({
      type: 'panel',
      attrs: { panelType: 'warning' },
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Failed:', marks: [{ type: 'strong' }] }],
        },
        {
          type: 'bulletList',
          content: allFailures.map(f => ({
            type: 'listItem',
            content: [{
              type: 'paragraph',
              content: [
                { type: 'text', text: `${f.service}/${f.baseBranch}`, marks: [{ type: 'strong' }] },
                { type: 'text', text: ` — ${f.error}` },
              ],
            }],
          })),
        },
      ],
    });
  }

  return { type: 'doc', version: 1, content };
}

/**
 * Build an ADF comment for the In-Progress transition.
 * Shows what the agent parsed and plans to work on.
 */
export function buildInProgressComment(config, ticket) {
  const content = [];

  // Header
  content.push({
    type: 'heading',
    attrs: { level: 3 },
    content: [{ type: 'text', text: 'Dr. Asthana — Starting implementation' }],
  });

  // Ticket context
  content.push({
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Summary: ', marks: [{ type: 'strong' }] },
      { type: 'text', text: ticket.summary },
    ],
  });

  if (ticket.description && ticket.description !== 'No description provided') {
    content.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Description: ', marks: [{ type: 'strong' }] },
        { type: 'text', text: truncate(ticket.description, 500) },
      ],
    });
  }

  // Service / Branch table
  if (ticket.affectedSystems && ticket.affectedSystems.length > 0) {
    const branches = ticket.targetBranches && ticket.targetBranches.length > 1
      ? ticket.targetBranches.map(tb => tb.branch)
      : [ticket.targetBranch].filter(Boolean);

    const tableRows = [
      {
        type: 'tableRow',
        content: ['Service', 'Repository', 'Target Branch(es)'].map(header => ({
          type: 'tableHeader',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: header, marks: [{ type: 'strong' }] }] }],
        })),
      },
      ...ticket.affectedSystems.map(system => {
        const serviceConfig = config.SERVICES[system] || {};
        return {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: system }] }] },
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: serviceConfig.repo || system }] }] },
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: branches.join(', ') || 'N/A' }] }] },
          ],
        };
      }),
    ];

    content.push({ type: 'table', content: tableRows });
  }

  // Scope
  content.push({
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Scope: ', marks: [{ type: 'strong' }] },
      { type: 'text', text: `${ticket.affectedSystems.length} service(s) — ${ticket.affectedSystems.join(', ')}` },
    ],
  });

  return { type: 'doc', version: 1, content };
}

/**
 * Build an ADF comment for the LEAD REVIEW transition.
 * Shows implementation plan, files changed, summary, and PR table.
 */
export function buildLeadReviewComment(config, allPRs, claudeSummary, planOutput) {
  const azdoBase = config.AZDO_ORG || 'https://dev.azure.com/GoFynd';
  const project = config.AZDO_PROJECT || 'FyndPlatformCore';

  const content = [];

  // Header
  content.push({
    type: 'heading',
    attrs: { level: 3 },
    content: [{ type: 'text', text: 'Dr. Asthana — Implementation complete' }],
  });

  // Plan section
  if (planOutput) {
    content.push({
      type: 'heading',
      attrs: { level: 4 },
      content: [{ type: 'text', text: 'Implementation Plan' }],
    });
    content.push(...markdownToAdfBlocks(truncate(planOutput, 1500)));
  }

  // Extract FILES CHANGED from Claude's output
  if (claudeSummary) {
    const filesMatch = claudeSummary.match(/\*\*FILES CHANGED[:\*]*\*?\*?\s*([\s\S]*?)(?=\n\*\*|$)/i);
    if (filesMatch) {
      content.push({
        type: 'heading',
        attrs: { level: 4 },
        content: [{ type: 'text', text: 'Files Changed' }],
      });
      content.push(...markdownToAdfBlocks(filesMatch[1].trim()));
    }

    // Extract SUMMARY
    const summaryMatch = claudeSummary.match(/\*\*SUMMARY[:\*]*\*?\*?\s*([\s\S]*?)(?=\n\*\*|$)/i);
    if (summaryMatch) {
      content.push({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Summary: ', marks: [{ type: 'strong' }] },
          ...parseInlineMarkdown(summaryMatch[1].trim()),
        ],
      });
    }
  }

  // PR table
  if (allPRs.length > 0) {
    const tableRows = [
      {
        type: 'tableRow',
        content: ['Service', 'Branch', 'PR'].map(header => ({
          type: 'tableHeader',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: header, marks: [{ type: 'strong' }] }] }],
        })),
      },
      ...allPRs.map(pr => {
        const repo = pr.service;
        const prUrl = pr.prUrl || `${azdoBase}/${project}/_git/${repo}/pullrequest/${pr.prId}`;
        return {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: repo }] }] },
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: pr.baseBranch }] }] },
            {
              type: 'tableCell',
              content: [{
                type: 'paragraph',
                content: [{
                  type: 'text',
                  text: `#${pr.prId}`,
                  marks: [{ type: 'link', attrs: { href: prUrl } }],
                }],
              }],
            },
          ],
        };
      }),
    ];

    content.push({ type: 'table', content: tableRows });
  }

  return { type: 'doc', version: 1, content };
}

/**
 * Send a Slack DM with all PRs listed (not just the first one).
 */
export async function notifyAllPRs(config, ticketKey, ticketSummary, allPRs, allFailures, claudeSummary) {
  if (!config.SLACK_BOT_TOKEN || !config.SLACK_USER_ID) {
    warn('Slack not configured, skipping notification');
    return;
  }

  const { WebClient } = await import('@slack/web-api');
  const client = new WebClient(config.SLACK_BOT_TOKEN);

  try {
    const conversation = await client.conversations.open({ users: config.SLACK_USER_ID });
    const dmChannelId = conversation.channel.id;

    const azdoBase = config.AZDO_ORG || 'https://dev.azure.com/GoFynd';
    const project = config.AZDO_PROJECT || 'FyndPlatformCore';

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
      briefSummary = summaryMatch ? summaryMatch[1].trim() : claudeSummary.substring(0, 200);
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
export async function notifyFailure(config, ticketKey, ticketSummary, errorMessage) {
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
          text: `*Error:*\n\`\`\`${truncate(errorMessage, 300)}\`\`\``,
        },
      },
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
