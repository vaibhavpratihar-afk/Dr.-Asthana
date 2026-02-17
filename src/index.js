#!/usr/bin/env node

/**
 * Dr. Asthana - CLI Entry Point
 *
 * Commands:
 *   daemon          Run the poll loop continuously
 *   single <KEY>    Process one specific ticket
 *   dry-run         Poll once, log what would happen, don't execute
 */

import { loadConfig } from './config.js';
import { fetchTickets, getTicketDetails } from './services/jira.js';
import { processTicket } from './agent/processor.js';
import { parseTicket, displayTicketDetails } from './agent/ticket.js';
import { log, ok, warn, err } from './logger.js';
import * as logger from './logger.js';

/**
 * Sleep for a given number of seconds
 */
function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Run a single ticket by key
 */
async function runSingle(config, ticketKey) {
  log(`Fetching ticket ${ticketKey}...`);

  try {
    await processTicket(config, ticketKey);
  } catch (error) {
    err(`Failed to process ${ticketKey}: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Dry run - poll once and log what would happen
 */
async function runDryRun(config) {
  log('DRY RUN MODE - No changes will be made');
  log('');

  try {
    const tickets = await fetchTickets(config);

    if (tickets.length === 0) {
      log('No tickets found matching criteria');
      return;
    }

    log(`\nFound ${tickets.length} ticket(s) to process:\n`);

    for (const ticket of tickets) {
      const rawTicket = await getTicketDetails(config, ticket.key);
      const parsed = parseTicket(config, rawTicket);
      displayTicketDetails(parsed, logger);
    }
  } catch (error) {
    err(`Dry run failed: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Run the daemon loop
 */
async function runDaemon(config) {
  log('╔════════════════════════════════════════════════════════════╗');
  log('║            Dr. Asthana                                     ║');
  log('╚════════════════════════════════════════════════════════════╝');
  log('');
  log(`Poll interval:    ${config.POLL_INTERVAL}s`);
  log(`Max per cycle:    ${config.MAX_TICKETS_PER_CYCLE}`);
  log(`AI provider:      ${config.AGENT_PROVIDER_LABEL || config.PROVIDER || 'claude'}`);
  log(`Label:            ${config.JIRA_LABEL}`);
  log(`Services:         ${Object.keys(config.SERVICES).join(', ')}`);
  log('');

  let cycleCount = 0;

  while (true) {
    cycleCount++;
    try {
      log(`Checking for new patients (cycle ${cycleCount})...`);
      const tickets = await fetchTickets(config);

      if (tickets.length === 0) {
        log('No patients waiting. Shutting down.');
        break;
      }

      for (const ticket of tickets) {
        await processTicket(config, ticket);
      }
    } catch (error) {
      err(`Poll cycle failed: ${error.message}`);
    }

    log(`\nCycle ${cycleCount} done. Checking again in ${config.POLL_INTERVAL}s...\n`);
    await sleep(config.POLL_INTERVAL);
  }
}

/**
 * Print usage information
 */
function printUsage() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║            Dr. Asthana                                     ║
╚════════════════════════════════════════════════════════════╝

Usage:
  node src/index.js <command> [options]

Commands:
  daemon          Run the poll loop continuously
  single <KEY>    Process one specific ticket (e.g., single JCP-123)
  dry-run         Poll once, show ticket details, don't execute

Configuration:
  Edit config.json in the project root.

Labels:
  Add "${process.env.JIRA_LABEL || 'patient-dr-asthana'}" label to tickets for processing.
`);
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  // Load and validate configuration
  const config = loadConfig();

  switch (command) {
    case 'daemon':
      await runDaemon(config);
      break;

    case 'single': {
      const ticketKey = args[1];
      if (!ticketKey) {
        err('Missing ticket key. Usage: single <TICKET-KEY>');
        process.exit(1);
      }
      await runSingle(config, ticketKey);
      break;
    }

    case 'dry-run':
      await runDryRun(config);
      break;

    default:
      err(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

// Run
main().catch((error) => {
  err(`Fatal error: ${error.message}`);
  process.exit(1);
});
