/**
 * Top-level AI provider switch.
 * Exposes one execution API and provider metadata.
 */

import { runClaude } from './claude.js';

const SUPPORTED_PROVIDERS = new Set(['claude']);

export function getProviderName(config) {
  return String(config.AGENT_PROVIDER || config.PROVIDER || 'claude').toLowerCase();
}

export function getProviderLabel(config) {
  return 'Claude';
}

export function validateProvider(config) {
  const provider = getProviderName(config);
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported AI provider: ${provider}`);
  }
  return provider;
}

export async function runAgentProvider(config, tmpDir, ticketKey, ticketSummary, ticketDescription, ticketComments = [], options = {}) {
  validateProvider(config);

  return runClaude(config, tmpDir, ticketKey, ticketSummary, ticketDescription, ticketComments, {
    ...options,
    cliCommand: config.AGENT_CLI_COMMAND || 'claude',
    providerLabel: 'Claude',
  });
}

export default {
  getProviderName,
  getProviderLabel,
  validateProvider,
  runAgentProvider,
};
