/**
 * Low-level JIRA REST API wrapper.
 * All functions take (config, ...) as first arg.
 */

import { getAuthHeader } from '../utils/config.js';
import { log, warn } from '../utils/logger.js';

async function fetchJSON(config, url, options = {}) {
  const response = await fetch(url, {
    method: 'GET',
    ...options,
    headers: {
      Authorization: getAuthHeader(config),
      Accept: 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`JIRA API ${response.status}: ${text}`);
  }

  return response.json();
}

/**
 * Fetch all comments for a ticket, paginating through JIRA's API.
 */
async function fetchAllComments(config, ticketKey, maxComments) {
  const allComments = [];
  let startAt = 0;
  const pageSize = 50;

  while (startAt < maxComments) {
    const url = `${config.jira.baseUrl}/rest/api/3/issue/${ticketKey}/comment?startAt=${startAt}&maxResults=${pageSize}`;
    const data = await fetchJSON(config, url);
    const comments = data.comments || [];
    allComments.push(...comments);

    if (startAt + comments.length >= data.total || comments.length === 0) {
      break;
    }
    startAt += comments.length;
  }

  return allComments.slice(0, maxComments);
}

/**
 * Get full ticket details
 */
export async function getTicketDetails(config, ticketKey) {
  const url = `${config.jira.baseUrl}/rest/api/3/issue/${ticketKey}?expand=renderedFields`;
  const ticket = await fetchJSON(config, url);

  // Replace inline comments with paginated fetch
  try {
    const maxComments = config.jira.maxComments || 100;
    const allComments = await fetchAllComments(config, ticketKey, maxComments);
    if (!ticket.fields.comment) {
      ticket.fields.comment = {};
    }
    ticket.fields.comment.comments = allComments;
    log(`Fetched ${allComments.length} comments for ${ticketKey} (paginated)`);
  } catch (commentError) {
    warn(`Comment pagination failed for ${ticketKey}: ${commentError.message}. Using inline comments.`);
  }

  return ticket;
}

/**
 * Delete stale agent-generated comments from a ticket before a fresh run.
 * Identifies agent comments by known prefixes in the body text.
 */
export async function deleteStaleAgentComments(config, ticketKey) {
  const AGENT_PATTERNS = [
    /^Dr\. Asthana/,
    /^\*\*Step:/,
    /^### Starting Work/,
    /^\*\*Step: Council/,
  ];

  try {
    const url = `${config.jira.baseUrl}/rest/api/3/issue/${ticketKey}/comment?maxResults=100`;
    const data = await fetchJSON(config, url);
    const comments = data.comments || [];

    const stale = comments.filter(c => {
      const text = c.body?.content
        ? extractPlainText(c.body)
        : (typeof c.body === 'string' ? c.body : '');
      return AGENT_PATTERNS.some(p => p.test(text.trimStart()));
    });

    let deleted = 0;
    for (const comment of stale) {
      const delUrl = `${config.jira.baseUrl}/rest/api/3/issue/${ticketKey}/comment/${comment.id}`;
      const response = await fetch(delUrl, {
        method: 'DELETE',
        headers: { Authorization: getAuthHeader(config) },
      });
      if (response.status === 204) {
        deleted++;
      } else {
        warn(`Failed to delete comment ${comment.id}: HTTP ${response.status}`);
      }
    }

    if (deleted > 0) {
      log(`Deleted ${deleted} stale agent comment(s) from ${ticketKey}`);
    }
    return deleted;
  } catch (e) {
    warn(`deleteStaleAgentComments failed (non-blocking): ${e.message}`);
    return 0;
  }
}

/**
 * Extract plain text from JIRA ADF body for comment matching.
 */
function extractPlainText(body) {
  if (!body || !body.content) return '';
  const chunks = [];
  function walk(nodes) {
    for (const node of nodes || []) {
      if (node.type === 'text') chunks.push(node.text || '');
      if (node.content) walk(node.content);
    }
  }
  walk(body.content);
  return chunks.join('');
}

