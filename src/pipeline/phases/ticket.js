import {
  getTicketDetails,
  parseTicket,
  displayTicketDetails,
  validateTicket,
} from '../../jira/index.js';
import { STEP_NUMBER_BY_PHASE } from '../core/support.js';

export async function fetchTicketPhase({ config, ticketKey, logger }) {
  const { startStep, endStep } = logger;

  startStep(STEP_NUMBER_BY_PHASE.FETCH_TICKET, 'Fetch and parse ticket');

  const rawTicket = await getTicketDetails(config, ticketKey);
  const ticket = parseTicket(config, rawTicket);

  displayTicketDetails(ticket, logger);
  endStep(true, `Ticket fetched: ${ticket.summary.substring(0, 50)}...`);

  return ticket;
}

export async function validateTicketPhase({ config, ticketKey, ticket, logger }) {
  const { startStep, endStep, warn } = logger;

  startStep(STEP_NUMBER_BY_PHASE.VALIDATE_TICKET, 'Validate ticket fields');

  const validationErrors = validateTicket(config, ticket);
  if (validationErrors.length > 0) {
    for (const error of validationErrors) {
      warn(`Validation failed: ${error}`);
    }
    endStep(false, `Validation failed: ${validationErrors.join(', ')}`);
    return { ok: false, errors: validationErrors };
  }

  endStep(true, 'All required fields present');
  return { ok: true };
}
