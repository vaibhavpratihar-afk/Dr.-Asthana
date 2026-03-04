/**
 * Execution prompt builder.
 *
 * Replaces the old council pipeline. Builds a prompt from ticket + codebase context
 * and runs the executor directly — no planner/reviewer debate.
 */

import { runAI } from '../ai-provider/index.js';
import { getPersona } from '../personas/index.js';
import { buildTicketContext } from './ticket-context.js';
import { buildCodebaseContext, extractFilePaths } from './codebase-context.js';
import { log } from '../utils/logger.js';

export async function execute(ticket, cloneDir, config, options = {}) {
  const { ticketKey } = options;

  const ticketContext = buildTicketContext(ticket);
  const ticketText = `${ticket.description || ''}\n${(ticket.comments || []).map(c => c.text).join('\n')}`;
  const referencedFiles = extractFilePaths(ticketText);
  if (referencedFiles.length > 0) log(`Found ${referencedFiles.length} file path(s) in ticket — pre-loading`);
  const codebaseContext = buildCodebaseContext(cloneDir, { referencedFiles });

  const persona = getPersona('executorPrompt');
  const prompt = [
    persona,
    '',
    '---',
    '',
    ticketContext,
    '',
    '---',
    '',
    codebaseContext,
  ].join('\n');

  log(`Executor prompt: ${prompt.length} chars`);

  const executorConfig = config.aiProvider?.execute?.codex
    ? { provider: 'codex', ...config.aiProvider.execute.codex }
    : { provider: 'codex', model: 'gpt-5.3-codex', timeoutMinutes: 30 };

  const result = await runAI({
    prompt,
    workingDir: cloneDir,
    mode: 'execute',
    label: ticketKey || 'execute',
    logDir: config.agent.logDir,
    ticketKey,
    config,
    providerConfig: executorConfig,
  });

  if (!result.output) {
    return { status: 'failed', reason: 'Executor produced no output' };
  }

  log(`Executor done (${result.output.length} chars)`);
  return { status: 'done', output: result.output };
}
