/**
 * File: src/jira/index.js
 * Module: jira
 * Purpose: Public Jira module surface for read-only ticket access and parsing.
 * Key Exports: getTicketDetails, parseTicket, displayTicketDetails, searchTickets, validateTicket
 * Integration Points: Integrates with Jira APIs/CLI and pipeline-facing parsers/validators.
 * Data Flow: Keep side effects explicit; keep pure transformations isolated where possible.
 * Maintenance Notes: Header intentionally documents file intent for fast onboarding and review.
 */
export { searchTickets, getTicketDetails } from './client.js';
export { parseTicket, displayTicketDetails } from './parser.js';
export { validateTicket } from './validator.js';
