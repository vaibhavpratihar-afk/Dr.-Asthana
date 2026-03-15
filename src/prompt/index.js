import { runAI } from '../ai-provider/index.js';
import { getPersona } from '../personas/index.js';
import { buildTicketContext } from './ticket-context.js';
import { log } from '../utils/logger.js';

/**
 * Build the ship instructions section injected into the executor prompt.
 *
 * @param {object} ship
 * @param {string} ship.featureBranch
 * @param {string} ship.baseBranch
 * @param {string} ship.repoName
 * @param {string} ship.org
 * @param {string} ship.project
 * @param {string} ship.ticketKey
 * @param {string} ship.ticketSummary
 */
function buildShipInstructions(ship) {
  const title = `[${ship.ticketKey}] ${ship.ticketSummary}`.substring(0, 200);
  return [
    '## Ship Instructions',
    '',
    `- **Feature branch:** \`${ship.featureBranch}\``,
    `- **Commit message:** \`${title}\``,
    '',
    '```bash',
    `az repos pr create \\`,
    `  --repository ${ship.repoName} \\`,
    `  --source-branch ${ship.featureBranch} \\`,
    `  --target-branch ${ship.baseBranch} \\`,
    `  --title "${title}" \\`,
    `  --description "${title}" \\`,
    `  --draft false \\`,
    `  --organization ${ship.org} \\`,
    `  --project ${ship.project}`,
    '```',
  ].join('\n');
}

export async function execute(ticket, cloneDir, config, options = {}) {
  const { ticketKey, ship } = options;

  const persona = getPersona('executorPrompt');
  const ticketContext = buildTicketContext(ticket);

  const parts = [persona, '', '---', '', ticketContext];
  if (ship) {
    parts.push('', '---', '', buildShipInstructions(ship));
  }
  const prompt = parts.join('\n');

  log(`Executor prompt: ${prompt.length} chars`);

  const executeConfig = config.aiProvider?.execute || {};
  const provider = executeConfig.provider;
  if (!provider) throw new Error('aiProvider.execute.provider is required');

  const providerDefaults = executeConfig[provider] || {};
  const providerConfig = { provider, ...providerDefaults };

  const result = await runAI({
    prompt,
    workingDir: cloneDir,
    mode: 'execute',
    label: ticketKey || 'execute',
    logDir: config.agent.logDir,
    ticketKey,
    config,
    providerConfig,
  });

  if (!result.output) {
    return { status: 'failed', reason: 'Executor produced no output' };
  }

  log(`Executor done (${result.output.length} chars)`);
  return { status: 'done', output: result.output };
}
