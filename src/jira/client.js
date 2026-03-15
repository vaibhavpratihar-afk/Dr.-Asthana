/**
 * File: src/jira/client.js
 * Module: jira
 * Purpose: Direct Jira REST client operations for read-only ticket retrieval.
 * Key Exports: searchTickets, getTicketDetails
 * Integration Points: Integrates with Jira APIs/CLI and pipeline-facing parsers/validators.
 * Data Flow: Keep side effects explicit; keep pure transformations isolated where possible.
 * Maintenance Notes: Header intentionally documents file intent for fast onboarding and review.
 */
import { getAuthHeader } from '../utils/config.js';
import { log, warn } from '../utils/logger.js';

function buildJiraHeaders(config, extraHeaders = {}) {
  return {
    Authorization: getAuthHeader(config),
    Accept: 'application/json',
    ...extraHeaders,
  };
}

async function fetchJSON(config, url, options = {}) {
  const response = await fetch(url, {
    method: 'GET',
    ...options,
    headers: buildJiraHeaders(config, options.headers),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`JIRA API ${response.status}: ${text}`);
  }

  return response.json();
}

function buildSearchUrl(config, jql, maxResults, fields) {
  const params = new URLSearchParams();
  params.set('jql', jql);
  params.set('maxResults', String(maxResults));
  params.set('fields', fields.join(','));
  return `${config.jira.baseUrl}/rest/api/3/search?${params.toString()}`;
}

/**
 * Search Jira tickets with JQL using read-only REST API.
 */
export async function searchTickets(config, jql, maxResults, fields) {
  const url = buildSearchUrl(config, jql, maxResults, fields);
  const data = await fetchJSON(config, url);
  return Array.isArray(data.issues) ? data.issues : [];
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
