/**
 * File: src/jira/validator.js
 * Module: jira
 * Purpose: Module implementation for domain-specific behavior in this subsystem.
 * Key Exports: validateTicket
 * Integration Points: Integrates with Jira APIs/CLI and pipeline-facing parsers/validators.
 * Data Flow: Keep side effects explicit; keep pure transformations isolated where possible.
 * Maintenance Notes: Header intentionally documents file intent for fast onboarding and review.
 */
import { getServiceConfig } from '../utils/config.js';
const CLOSED_STATUSES = new Set(['closed', 'done', "won't do", 'rejected', 'resolved']);
const NO_SUMMARY = 'No summary';
const NO_DESCRIPTION = 'No description provided';

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function collectRuleErrors(ticket, rules) {
  const errors = [];
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const failed = Boolean(rule.when(ticket));
    if (failed) {
      errors.push(rule.message(ticket));
    }
  }
  return errors;
}

const BASE_VALIDATION_RULES = Object.freeze([
  {
    key: 'closed_status',
    when: (ticket) => CLOSED_STATUSES.has(normalizeStatus(ticket.status)),
    message: (ticket) => `Ticket status is "${ticket.status}" — skipping closed ticket`,
  },
  {
    key: 'missing_summary',
    when: (ticket) => !ticket.summary || ticket.summary === NO_SUMMARY,
    message: () => 'Ticket has no summary',
  },
  {
    key: 'missing_description_and_comments',
    when: (ticket) => (!ticket.description || ticket.description === NO_DESCRIPTION) && (!ticket.comments || ticket.comments.length === 0),
    message: () => 'Ticket has no description and no comments',
  },
  {
    key: 'missing_affected_systems',
    when: (ticket) => !ticket.affectedSystems || ticket.affectedSystems.length === 0,
    message: () => 'No Affected Systems specified',
  },
  {
    key: 'missing_target_branch',
    when: (ticket) => !ticket.targetBranch,
    message: () => 'No Fix Version specified',
  },
  {
    key: 'multiple_affected_systems',
    when: (ticket) => ticket.affectedSystems && ticket.affectedSystems.length > 1,
    message: (ticket) => `Multiple Affected Systems not supported (found ${ticket.affectedSystems.length}: ${ticket.affectedSystems.join(', ')}). Split into separate tickets.`,
  },
  {
    key: 'multiple_target_branches',
    when: (ticket) => ticket.targetBranches && ticket.targetBranches.length > 1,
    message: (ticket) => `Multiple Fix Versions not supported (found ${ticket.targetBranches.length}: ${ticket.targetBranches.map((tb) => tb.versionName).join(', ')}). Split into separate tickets.`,
  },
]);

/**
 * Validate a parsed ticket is ready for processing.
 * Returns an array of error strings. Empty array = valid.
 *
 * @param {object} config - Full config object
 * @param {object} ticket - Parsed ticket from jira/parser.js
 * @returns {string[]} Array of validation error messages
 */
export function validateTicket(config, ticket) {
  const errors = collectRuleErrors(ticket, BASE_VALIDATION_RULES);

  // --- Config checks ---

  if (ticket.affectedSystems) {
    for (const system of ticket.affectedSystems) {
      const serviceConfig = getServiceConfig(config, system);
      if (!serviceConfig) {
        errors.push(`Unknown service: ${system}. Supported: ${Object.keys(config.services).join(', ')}`);
      }
    }
  }

  return errors;
}
