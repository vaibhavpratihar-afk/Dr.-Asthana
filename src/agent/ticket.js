/**
 * Ticket data extraction and parsing
 */

/**
 * Apply ADF text marks (bold, italic, code, strikethrough, link) as markdown syntax.
 */
function applyMarks(text, marks) {
  if (!marks || !Array.isArray(marks) || marks.length === 0) {
    return text;
  }
  let result = text;
  for (const mark of marks) {
    switch (mark.type) {
      case 'strong':
        result = `**${result}**`;
        break;
      case 'em':
        result = `*${result}*`;
        break;
      case 'code':
        result = `\`${result}\``;
        break;
      case 'strike':
        result = `~~${result}~~`;
        break;
      case 'link':
        result = mark.attrs?.href ? `[${result}](${mark.attrs.href})` : result;
        break;
    }
  }
  return result;
}

/**
 * Extract plain text from Atlassian Document Format (ADF)
 */
function extractTextFromADF(content) {
  if (!Array.isArray(content)) {
    return '';
  }

  const textParts = [];

  for (const node of content) {
    if (node.type === 'text' && node.text) {
      textParts.push(applyMarks(node.text, node.marks));
    } else if (node.type === 'hardBreak') {
      textParts.push('\n');
    } else if (node.type === 'paragraph' && node.content) {
      textParts.push(extractTextFromADF(node.content));
      textParts.push('\n');
    } else if (node.type === 'bulletList') {
      if (node.content) {
        for (const listItem of node.content) {
          textParts.push('- ');
          textParts.push(extractTextFromADF(listItem.content || []));
          textParts.push('\n');
        }
      }
    } else if (node.type === 'orderedList') {
      if (node.content) {
        for (let i = 0; i < node.content.length; i++) {
          textParts.push(`${i + 1}. `);
          textParts.push(extractTextFromADF(node.content[i].content || []));
          textParts.push('\n');
        }
      }
    } else if (node.type === 'table') {
      if (node.content) {
        const rows = [];
        let isFirstRow = true;
        for (const row of node.content) {
          if (row.type !== 'tableRow' || !row.content) continue;
          const cells = row.content.map((cell) => {
            const cellText = extractTextFromADF(cell.content || []);
            return cellText.replace(/\n/g, ' ').trim();
          });
          rows.push(`| ${cells.join(' | ')} |`);
          if (isFirstRow) {
            rows.push(`| ${cells.map(() => '---').join(' | ')} |`);
            isFirstRow = false;
          }
        }
        textParts.push(rows.join('\n'));
        textParts.push('\n');
      }
    } else if (node.type === 'blockquote') {
      const inner = extractTextFromADF(node.content || []);
      textParts.push(inner.split('\n').map((line) => `> ${line}`).join('\n'));
      textParts.push('\n');
    } else if (node.type === 'panel') {
      const panelType = (node.attrs?.panelType || 'info').toUpperCase();
      textParts.push(`[${panelType}] `);
      textParts.push(extractTextFromADF(node.content || []));
      textParts.push('\n');
    } else if (node.type === 'inlineCard') {
      textParts.push(node.attrs?.url || '');
    } else if (node.type === 'mention') {
      textParts.push(`@${node.attrs?.text || node.attrs?.id || 'unknown'}`);
    } else if (node.type === 'codeBlock' && node.content) {
      textParts.push('```\n');
      textParts.push(extractTextFromADF(node.content));
      textParts.push('\n```\n');
    } else if (node.type === 'heading' && node.content) {
      const level = node.attrs?.level || 1;
      textParts.push('#'.repeat(level) + ' ');
      textParts.push(extractTextFromADF(node.content));
      textParts.push('\n');
    } else if (node.content) {
      textParts.push(extractTextFromADF(node.content));
    }
  }

  return textParts.join('').trim();
}

/**
 * Extract description from ticket
 */
export function extractDescription(ticket) {
  const description = ticket.fields?.description;

  if (!description) {
    return 'No description provided';
  }

  if (typeof description === 'string') {
    return description;
  }

  if (description.type === 'doc' && description.content) {
    return extractTextFromADF(description.content);
  }

  return 'No description provided';
}

/**
 * Extract comments from ticket
 */
export function extractComments(ticket) {
  const comments = ticket.fields?.comment?.comments || [];

  return comments.map((comment) => {
    let text = '';
    if (comment.body?.content) {
      text = extractTextFromADF(comment.body.content);
    } else if (typeof comment.body === 'string') {
      text = comment.body;
    }

    return {
      author: comment.author?.displayName || 'Unknown',
      text,
      created: comment.created,
    };
  });
}

/**
 * Extract affected systems from ticket
 */
export function extractAffectedSystems(config, ticket) {
  const field = config.JIRA_FIELDS.affectedSystems;
  const affectedSystems = ticket.fields?.[field];

  if (!affectedSystems || !Array.isArray(affectedSystems)) {
    return [];
  }

  return affectedSystems.map((system) => system.value || system.name || system).filter(Boolean);
}

/**
 * Extract fix version and convert to branch name
 * "Fynd Platform v1.10.7" → "version/1.10.7"
 */
export function extractBranchFromFixVersion(ticket) {
  const fixVersions = ticket.fields?.fixVersions;

  if (!fixVersions || !Array.isArray(fixVersions) || fixVersions.length === 0) {
    return null;
  }

  const fixVersion = fixVersions[0];
  const versionName = fixVersion.name || fixVersion;

  const match = versionName.match(/v?(\d+\.\d+\.\d+)/i);
  if (!match) {
    return null;
  }

  return `version/${match[1]}`;
}

/**
 * Extract all fix versions as branch targets
 * Returns array of { branch, versionName, version } for every parseable fix version
 */
export function extractAllBranches(ticket) {
  const fixVersions = ticket.fields?.fixVersions;

  if (!fixVersions || !Array.isArray(fixVersions) || fixVersions.length === 0) {
    return [];
  }

  return fixVersions
    .map((fv) => {
      const versionName = fv.name || fv;
      const match = versionName.match(/v?(\d+\.\d+\.\d+)/i);
      if (!match) return null;
      return { branch: `version/${match[1]}`, versionName, version: match[1] };
    })
    .filter(Boolean);
}

/**
 * Get raw fix version name from ticket
 */
export function getFixVersionName(ticket) {
  const fixVersions = ticket.fields?.fixVersions;

  if (!fixVersions || !Array.isArray(fixVersions) || fixVersions.length === 0) {
    return null;
  }

  return fixVersions[0].name || fixVersions[0];
}

/**
 * Parse a ticket into a structured format with all required fields
 */
export function parseTicket(config, ticket) {
  return {
    key: ticket.key,
    summary: ticket.fields?.summary || 'No summary',
    description: extractDescription(ticket),
    comments: extractComments(ticket),
    type: ticket.fields?.issuetype?.name || 'Unknown',
    priority: ticket.fields?.priority?.name || 'None',
    status: ticket.fields?.status?.name || 'Unknown',
    affectedSystems: extractAffectedSystems(config, ticket),
    fixVersion: getFixVersionName(ticket),
    targetBranch: extractBranchFromFixVersion(ticket),
    targetBranches: extractAllBranches(ticket),
    labels: ticket.fields?.labels || [],
  };
}

/**
 * Display ticket details in logs
 */
export function displayTicketDetails(ticket, logger) {
  const { log } = logger;

  log('');
  log('╔════════════════════════════════════════════════════════════╗');
  log('║                     TICKET DETAILS                         ║');
  log('╚════════════════════════════════════════════════════════════╝');
  log('');
  log(`Key:              ${ticket.key}`);
  log(`Title:            ${ticket.summary}`);
  log(`Type:             ${ticket.type}`);
  log(`Priority:         ${ticket.priority}`);
  log(`Status:           ${ticket.status}`);
  log(`Affected Systems: ${ticket.affectedSystems.join(', ') || 'None'}`);
  log(`Fix Version:      ${ticket.fixVersion || 'None'}`);
  log(`Target Branch:    ${ticket.targetBranch || 'None'}`);
  if (ticket.targetBranches && ticket.targetBranches.length > 1) {
    log(`Fix Versions:     ${ticket.targetBranches.map(tb => tb.versionName).join(', ')}`);
    log(`Target Branches:  ${ticket.targetBranches.map(tb => tb.branch).join(', ')}`);
  }
  log('');
  log('┌─── DESCRIPTION ─────────────────────────────────────────────');
  log(ticket.description || 'No description');
  log('└──────────────────────────────────────────────────────────────');
  log('');
  log('┌─── COMMENTS ─────────────────────────────────────────────────');
  if (ticket.comments.length === 0) {
    log('No comments');
  } else {
    ticket.comments.forEach((comment, i) => {
      log(`[${i + 1}] ${comment.author}:`);
      log(comment.text);
      log('');
    });
  }
  log('└──────────────────────────────────────────────────────────────');
  log('');
}

export default {
  extractDescription,
  extractComments,
  extractAffectedSystems,
  extractBranchFromFixVersion,
  extractAllBranches,
  getFixVersionName,
  parseTicket,
  displayTicketDetails,
};
