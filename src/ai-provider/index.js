/**
 * AI Provider Module — public API.
 *
 * The SOLE interface for spawning any AI CLI process in the entire codebase.
 * No other module spawns `claude` or `codex` directly.
 */

import { spawn, buildResult } from './provider.js';
import * as codexAdapter from './adapters/codex.js';
import { log } from '../utils/logger.js';

const ADAPTERS = {
  codex: codexAdapter,
};

/**
 * Spawn an AI agent.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} options.workingDir
 * @param {'execute'} options.mode
 * @param {string} options.label
 * @param {string} [options.logDir]
 * @param {string} [options.ticketKey]
 * @param {object} options.config
 * @param {object} options.providerConfig - Provider + model config. Shape: { provider, model, timeoutMinutes? }
 */
export async function runAI(options) {
  const { prompt, workingDir, mode, label, logDir, ticketKey, config, providerConfig } = options;
  const artifactDir = config._artifactDir || null;

  const providerName = providerConfig.provider || 'codex';
  const adapter = ADAPTERS[providerName];
  if (!adapter) throw new Error(`Unknown provider: ${providerName}`);

  const modeConfig = config.aiProvider?.[mode] || {};
  const effectiveConfig = {
    ...providerConfig,
    allowedTools: providerConfig.allowedTools || modeConfig.allowedTools || null,
    ...(artifactDir && { additionalWritableDirs: [artifactDir] }),
  };

  log(`[${label}] runAI: mode=${mode}, provider=${providerName}, model=${effectiveConfig.model || 'default'}`);
  log(`[${label}] Prompt length: ${prompt.length} characters`);

  const { args, timeout } = adapter.buildArgs(prompt, effectiveConfig);
  const raw = await spawn({
    command: adapter.getCommand(),
    args,
    workingDir,
    timeout,
    label,
    logDir,
    ticketKey,
    provider: providerName,
    prompt,
    artifactDir,
  });

  const parsed = adapter.parseStreamOutput(raw.stdout, raw.exitCode);
  const result = buildResult(raw, parsed, providerName, adapter);

  log(`[${label}] runAI complete: provider=${result.provider}, exit=${result.exitCode}, duration=${Math.floor(result.duration / 1000)}s, output=${result.output?.length || 0} chars${result.sessionId ? `, session=${result.sessionId.substring(0, 8)}...` : ''}`);
  return result;
}

/**
 * Get display label for current provider config.
 */
export function getProviderLabel(config) {
  const execConfig = config.aiProvider?.execute || {};
  const provider = execConfig.provider || 'codex';
  const model = execConfig[provider]?.model || execConfig.codex?.model || 'default';
  return `${provider} (${model})`;
}
