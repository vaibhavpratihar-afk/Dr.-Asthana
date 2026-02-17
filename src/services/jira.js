/**
 * JIRA REST API Service
 * Handles all JIRA API interactions
 */

import { getAuthHeader } from '../config.js';
import { log, warn } from '../logger.js';

/**
 * Fetch all comments for a ticket, paginating through JIRA's API.
 * JIRA's issue endpoint caps inline comments at ~20; this fetches all of them.
 */
async function fetchAllComments(config, ticketKey, maxComments) {
  const allComments = [];
  let startAt = 0;
  const pageSize = 50;

  while (startAt < maxComments) {
    const url = `${config.JIRA_BASE_URL}/rest/api/3/issue/${ticketKey}/comment?startAt=${startAt}&maxResults=${pageSize}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: getAuthHeader(config),
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch comments for ${ticketKey} (${response.status})`);
    }

    const data = await response.json();
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
  const url = `${config.JIRA_BASE_URL}/rest/api/3/issue/${ticketKey}?expand=renderedFields`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: getAuthHeader(config),
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get ticket ${ticketKey} (${response.status}): ${text}`);
  }

  const ticket = await response.json();

  // Replace inline comments with paginated fetch to capture >20 comments
  try {
    const maxComments = config.JIRA_MAX_COMMENTS || 100;
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
 * Get the current status name of a ticket
 */
export async function getTicketStatus(config, ticketKey) {
  const url = `${config.JIRA_BASE_URL}/rest/api/3/issue/${ticketKey}?fields=status`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: getAuthHeader(config),
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    warn(`Failed to get status for ${ticketKey}: ${response.status}`);
    return null;
  }

  const data = await response.json();
  return data.fields?.status?.name || null;
}

/**
 * Transition a ticket to a target status
 */
export async function transitionTicket(config, ticketKey, targetStatusName) {
  const transitionsUrl = `${config.JIRA_BASE_URL}/rest/api/3/issue/${ticketKey}/transitions`;

  // Get available transitions
  const transitionsResponse = await fetch(transitionsUrl, {
    method: 'GET',
    headers: {
      Authorization: getAuthHeader(config),
      Accept: 'application/json',
    },
  });

  if (!transitionsResponse.ok) {
    warn(`Failed to get transitions for ${ticketKey}: ${transitionsResponse.status}`);
    return false;
  }

  const { transitions } = await transitionsResponse.json();
  const targetTransition = transitions.find(
    (t) => t.name.toLowerCase().includes(targetStatusName.toLowerCase())
  );

  if (!targetTransition) {
    warn(`No transition matching "${targetStatusName}" found. Available: ${transitions.map((t) => t.name).join(', ')}`);
    return false;
  }

  // Execute transition
  const response = await fetch(transitionsUrl, {
    method: 'POST',
    headers: {
      Authorization: getAuthHeader(config),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      transition: { id: targetTransition.id },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    warn(`Failed to transition ${ticketKey}: ${text}`);
    return false;
  }

  log(`Transitioned ${ticketKey} to "${targetTransition.name}"`);
  return true;
}

export default {
  getTicketDetails,
  getTicketStatus,
  transitionTicket,
};
