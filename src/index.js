#!/usr/bin/env node
/**
 * File: src/index.js
 * Module: index.js
 * Purpose: CLI entrypoint that parses commands and starts pipeline execution modes.
 * Key Exports: No direct exports (internal file).
 * Integration Points: Integrates with neighboring modules through exported functions.
 * Data Flow: Keep side effects explicit; keep pure transformations isolated where possible.
 * Maintenance Notes: Header intentionally documents file intent for fast onboarding and review.
 */
import { loadConfig } from './utils/config.js';
import { getTicketDetails, parseTicket, displayTicketDetails, searchTickets } from './jira/index.js';
import { runPipeline } from './pipeline/index.js';
import { getProviderLabel } from './ai-provider/index.js';
import { log, err } from './utils/logger.js';
import * as logger from './utils/logger.js';

const TICKET_SEARCH_FIELDS = ['summary', 'description', 'comment', 'issuetype', 'priority', 'status', 'labels'];

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function getTicketQuery(config) {
  return `labels = "${config.jira.label}" AND statusCategory != Done ORDER BY priority DESC`;
}

function getTicketSearchFields(config) {
  return [...TICKET_SEARCH_FIELDS, config.jira.fields.affectedSystems, config.jira.fields.fixVersions];
}

function requireTicketKey(args, commandName) {
  const ticketKey = args[1];
  if (ticketKey) return ticketKey;
  throw new Error(`Missing ticket key. Usage: ${commandName} <TICKET-KEY>`);
}

async function runSingle(config, ticketKey) {
  log(`Processing ticket ${ticketKey}...`);
  try {
    await runPipeline(config, ticketKey);
  } catch (error) {
    err(`Failed to process ${ticketKey}: ${error.message}`);
    process.exit(1);
  }
}

async function runDryRun(config) {
  log('DRY RUN MODE - No changes will be made');
  log('');

  try {
    const jql = getTicketQuery(config);
    const fields = getTicketSearchFields(config);
    const tickets = await searchTickets(config, jql, config.agent.maxTicketsPerCycle, fields);

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

async function runDaemon(config) {
  log('== Dr. Asthana v2 ==');
  log('');
  log(`Poll interval:    ${config.agent.pollInterval}s`);
  log(`Max per cycle:    ${config.agent.maxTicketsPerCycle}`);
  log(`AI Provider:      ${getProviderLabel(config)}`);
  log(`Label:            ${config.jira.label}`);
  log(`Services:         ${Object.keys(config.services).join(', ')}`);
  log('');

  let cycleCount = 0;

  while (true) {
    cycleCount++;
    try {
      log(`Checking for new patients (cycle ${cycleCount})...`);
      const jql = getTicketQuery(config);
      const fields = getTicketSearchFields(config);
      const tickets = await searchTickets(config, jql, config.agent.maxTicketsPerCycle, fields);

      if (tickets.length === 0) {
        log('No patients waiting in this cycle.');
      } else {
        for (const ticket of tickets) {
          await runPipeline(config, ticket.key);
        }
      }
    } catch (error) {
      err(`Poll cycle failed: ${error.message}`);
    }

    log(`\nCycle ${cycleCount} done. Checking again in ${config.agent.pollInterval}s...\n`);
    await sleep(config.agent.pollInterval);
  }
}

function printUsage() {
  console.log(`
== Dr. Asthana v2 ==

Usage:
  node src/index.js <command> [options]

Commands:
  daemon                      Run the poll loop continuously
  single <KEY>                Process one specific ticket (e.g., single JCP-123)
  dry-run                     Poll once, show ticket details, don't execute

Configuration:
  Edit config.json in the project root.
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  const config = loadConfig();

  switch (command) {
    case 'daemon':
      await runDaemon(config);
      break;

    case 'single': {
      await runSingle(config, requireTicketKey(args, 'single'));
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

main().catch((error) => {
  err(`Fatal error: ${error.message}`);
  process.exit(1);
});
