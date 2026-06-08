import { authHeader } from './config.js';

// --- ADF (Atlassian Document Format) → plain markdown ---------------------

function applyMarks(text, marks) {
  if (!Array.isArray(marks)) return text;
  let out = text;
  for (const mark of marks) {
    if (mark.type === 'strong') out = `**${out}**`;
    else if (mark.type === 'em') out = `*${out}*`;
    else if (mark.type === 'code') out = `\`${out}\``;
    else if (mark.type === 'link' && mark.attrs?.href) out = `[${out}](${mark.attrs.href})`;
  }
  return out;
}

function adfToText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const node of content) {
    switch (node.type) {
      case 'text':
        if (node.text) parts.push(applyMarks(node.text, node.marks));
        break;
      case 'hardBreak':
        parts.push('\n');
        break;
      case 'paragraph':
      case 'heading':
        parts.push(adfToText(node.content), '\n');
        break;
      case 'bulletList':
      case 'orderedList':
        for (const [i, item] of (node.content || []).entries()) {
          parts.push(node.type === 'orderedList' ? `${i + 1}. ` : '- ');
          parts.push(adfToText(item.content), '\n');
        }
        break;
      case 'codeBlock':
        parts.push('```\n', adfToText(node.content), '\n```\n');
        break;
      case 'inlineCard':
        parts.push(node.attrs?.url || '');
        break;
      case 'mention':
        parts.push(`@${node.attrs?.text || node.attrs?.id || 'unknown'}`);
        break;
      default:
        if (Array.isArray(node.content)) parts.push(adfToText(node.content));
    }
  }
  return parts.join('').trim();
}

function fieldToText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value.type === 'doc' && value.content) return adfToText(value.content);
  return '';
}

// --- REST -----------------------------------------------------------------

async function fetchJSON(config, url) {
  const res = await fetch(url, {
    headers: { Authorization: authHeader(config), Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`JIRA API ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Find open tickets carrying the configured label, highest priority first.
 */
export async function searchByLabel(config) {
  const jql = `labels = "${config.jira.label}" AND statusCategory != Done ORDER BY priority DESC`;
  const params = new URLSearchParams({
    jql,
    maxResults: String(config.maxTickets),
    fields: 'summary',
  });
  const data = await fetchJSON(config, `${config.jira.baseUrl}/rest/api/3/search/jql?${params}`);
  return (data.issues || []).map((i) => ({ key: i.key, summary: i.fields?.summary || '' }));
}

/**
 * Fetch full ticket detail (description + comments) as plain text.
 */
export async function getTicket(config, key) {
  const issue = await fetchJSON(config, `${config.jira.baseUrl}/rest/api/3/issue/${key}`);
  const f = issue.fields || {};

  let comments = (f.comment?.comments || []).map((c) => ({
    author: c.author?.displayName || 'Unknown',
    text: fieldToText(c.body),
  }));

  // Paginate the rest if there are more than the inline page.
  if (f.comment && f.comment.total > comments.length) {
    try {
      let startAt = comments.length;
      while (startAt < Math.min(f.comment.total, config.jira.maxComments)) {
        const page = await fetchJSON(
          config,
          `${config.jira.baseUrl}/rest/api/3/issue/${key}/comment?startAt=${startAt}&maxResults=50`,
        );
        const batch = page.comments || [];
        if (batch.length === 0) break;
        comments.push(...batch.map((c) => ({ author: c.author?.displayName || 'Unknown', text: fieldToText(c.body) })));
        startAt += batch.length;
      }
    } catch {
      // inline comments are good enough
    }
  }
  comments = comments.slice(0, config.jira.maxComments);

  return {
    key: issue.key,
    summary: f.summary || '',
    description: fieldToText(f.description),
    type: f.issuetype?.name || 'Unknown',
    priority: f.priority?.name || 'None',
    status: f.status?.name || 'Unknown',
    comments,
  };
}

/**
 * Minimal gate: a ticket needs something to act on.
 * Returns an array of rejection reasons (empty = ok).
 */
export function validate(ticket) {
  const errors = [];
  if (!ticket.summary) errors.push('Ticket has no summary');
  if (!ticket.description && ticket.comments.length === 0) {
    errors.push('Ticket has no description and no comments');
  }
  return errors;
}
