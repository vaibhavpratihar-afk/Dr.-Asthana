/**
 * File: src/jira/parser.js
 * Module: jira
 * Purpose: Jira payload parsing and ADF conversion into normalized ticket objects.
 * Key Exports: parseTicket, displayTicketDetails
 * Integration Points: Integrates with Jira APIs/CLI and pipeline-facing parsers/validators.
 * Data Flow: Keep side effects explicit; keep pure transformations isolated where possible.
 * Maintenance Notes: Header intentionally documents file intent for fast onboarding and review.
 */
import { extractTextFromADF } from './core/adf-parser.js';

const NO_DESCRIPTION = 'No description provided';
const NO_SUMMARY = 'No summary';

function extractDescription(ticket) {
  const description = ticket.fields?.description;
  if (!description) return NO_DESCRIPTION;
  if (typeof description === 'string') return description;
  if (description.type === 'doc' && description.content) {
    return extractTextFromADF(description.content);
  }
  return NO_DESCRIPTION;
}

function extractComments(ticket) {
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

function extractAffectedSystems(config, ticket) {
  const field = config.jira.fields.affectedSystems;
  const affectedSystems = ticket.fields?.[field];
  if (!affectedSystems || !Array.isArray(affectedSystems)) return [];
  return affectedSystems.map((s) => s.value || s.name || s).filter(Boolean);
}

function extractVersion(value) {
  const versionName = value?.name || value;
  const match = String(versionName || '').match(/v?(\d+\.\d+\.\d+)/i);
  if (!match) return null;
  return { versionName, version: match[1], branch: `version/${match[1]}` };
}

function getFixVersions(config, ticket) {
  const field = config.jira.fields.fixVersions || 'fixVersions';
  const fixVersions = ticket.fields?.[field];
  return Array.isArray(fixVersions) ? fixVersions : [];
}

function extractBranchFromFixVersion(config, ticket) {
  const fixVersions = getFixVersions(config, ticket);
  if (fixVersions.length === 0) return null;
  const parsed = extractVersion(fixVersions[0]);
  return parsed ? parsed.branch : null;
}

function extractAllBranches(config, ticket) {
  const fixVersions = getFixVersions(config, ticket);
  if (!fixVersions || !Array.isArray(fixVersions) || fixVersions.length === 0) return [];
  return fixVersions
    .map((fv) => extractVersion(fv))
    .filter(Boolean);
}

function getFixVersionName(config, ticket) {
  const fixVersions = getFixVersions(config, ticket);
  if (!fixVersions || !Array.isArray(fixVersions) || fixVersions.length === 0) return null;
  return fixVersions[0].name || fixVersions[0];
}

export function parseTicket(config, ticket) {
  return {
    key: ticket.key,
    summary: ticket.fields?.summary || NO_SUMMARY,
    description: extractDescription(ticket),
    comments: extractComments(ticket),
    type: ticket.fields?.issuetype?.name || 'Unknown',
    priority: ticket.fields?.priority?.name || 'None',
    status: ticket.fields?.status?.name || 'Unknown',
    affectedSystems: extractAffectedSystems(config, ticket),
    fixVersion: getFixVersionName(config, ticket),
    targetBranch: extractBranchFromFixVersion(config, ticket),
    targetBranches: extractAllBranches(config, ticket),
  };
}

/**
 * Render ticket context to logs in a compact, scan-friendly shape.
 */
export function displayTicketDetails(ticket, loggerInstance) {
  const { log } = loggerInstance;
  log('');
  log('== TICKET DETAILS ==');
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
    log(`Fix Versions:     ${ticket.targetBranches.map((item) => item.versionName).join(', ')}`);
    log(`Target Branches:  ${ticket.targetBranches.map((item) => item.branch).join(', ')}`);
  }
  log('');
  log(`Description: ${(ticket.description || 'No description').substring(0, 200)}...`);
  log(`Comments: ${ticket.comments.length}`);
  log('');
}
