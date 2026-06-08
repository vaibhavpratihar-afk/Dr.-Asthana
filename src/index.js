#!/usr/bin/env node
/**
 * Slim Claude wrapper for the cms-ai workspace.
 *
 * Driven by an external scheduler (ghanta-ghar / cron). One invocation:
 *   1. Finds open JIRA tickets carrying the configured label.
 *   2. For each, runs Claude in a fresh cms-ai worktree to implement + ship a PR.
 *   3. Reports the outcome to Slack (or stdout).
 *
 * Usage:
 *   node src/index.js            process labeled tickets, then exit (scheduled mode)
 *   node src/index.js <KEY>      process one specific ticket
 */
import { loadConfig } from './config.js';
import { searchByLabel, getTicket, validate } from './jira.js';
import { runTicket } from './agent.js';
import { notify } from './notify.js';

async function processTicket(config, key) {
  const ticket = await getTicket(config, key);
  console.log(`\n=== ${ticket.key}: ${ticket.summary} ===`);

  const errors = validate(ticket);
  if (errors.length > 0) {
    const outcome = { status: 'rejected', reason: errors.join('; ') };
    await notify(config, ticket, outcome);
    return outcome;
  }

  const outcome = await runTicket(config, ticket);
  await notify(config, ticket, outcome);
  return outcome;
}

async function main() {
  const config = loadConfig();
  const explicitKey = process.argv[2];

  let keys;
  if (explicitKey) {
    keys = [explicitKey];
  } else {
    const tickets = await searchByLabel(config);
    if (tickets.length === 0) {
      console.log(`No open tickets with label "${config.jira.label}".`);
      return;
    }
    keys = tickets.map((t) => t.key);
    console.log(`Found ${keys.length} ticket(s): ${keys.join(', ')}`);
  }

  for (const key of keys) {
    try {
      await processTicket(config, key);
    } catch (e) {
      console.error(`Error processing ${key}: ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
