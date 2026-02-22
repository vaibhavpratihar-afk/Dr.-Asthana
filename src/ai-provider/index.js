/**
 * AI Provider Module — public API.
 *
 * The SOLE interface for spawning any AI CLI process in the entire codebase.
 * No other module spawns `claude` or `codex` directly.
 *
 * Supports multiple strategies: single, fallback, parallel, race.
 * Supports multiple modes: execute, debate, evaluate.
 */

import { spawn } from './provider.js';
import * as claudeAdapter from './adapters/claude.js';
import * as codexAdapter from './adapters/codex.js';
import { run as runSingle } from './strategies/single.js';
import { run as runFallback } from './strategies/fallback.js';
import { run as runParallel } from './strategies/parallel.js';
import { run as runRace } from './strategies/race.js';
import { log, warn } from '../utils/logger.js';
import { execSync } from 'child_process';

const ADAPTERS = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

const STRATEGIES = {
  single: runSingle,
  fallback: runFallback,
  parallel: runParallel,
  race: runRace,
};

/**
 * Spawn an AI agent with the configured strategy.
 *
 * This is the ONLY function other modules call to run AI.
 *
 * @param {object} options
 * @param {string} options.prompt - The prompt to send
 * @param {string} options.workingDir - Working directory for the process
 * @param {'execute'|'debate'|'evaluate'} options.mode - Determines tool permissions + model
 * @param {string} options.label - Human-readable label for logging
 * @param {string} [options.logDir] - Where to write log files
 * @param {string} [options.ticketKey] - JIRA ticket key for log filenames
 * @param {object} options.config - Full config object (aiProvider section extracted internally)
 * @returns {Promise<{output: string, completedNormally: boolean, exitCode: number, numTurns: number|null, rateLimited: boolean, provider: string, duration: number}>}
 */
export async function runAI(options) {
  const { prompt, workingDir, mode, label, logDir, ticketKey, config } = options;

  const aiConfig = config.aiProvider || {};
  const strategy = aiConfig.strategy || 'single';
  const modeConfig = aiConfig[mode];

  if (!modeConfig) {
    throw new Error(`No aiProvider config for mode '${mode}'. Check config.json aiProvider.${mode} section.`);
  }

  const strategyFn = STRATEGIES[strategy];
  if (!strategyFn) {
    throw new Error(`Unknown AI provider strategy: ${strategy}. Valid: ${Object.keys(STRATEGIES).join(', ')}`);
  }

  log(`[${label}] runAI: mode=${mode}, strategy=${strategy}, provider=${modeConfig.provider || 'claude'}`);
  log(`[${label}] Prompt length: ${prompt.length} characters`);

  const result = await strategyFn(prompt, workingDir, modeConfig, ADAPTERS, spawn, {
    label,
    logDir,
    ticketKey,
    mode,
  });

  log(`[${label}] runAI complete: provider=${result.provider}, exit=${result.exitCode}, duration=${Math.floor(result.duration / 1000)}s, output=${result.output?.length || 0} chars`);

  return result;
}

/**
 * Get display label for current provider config.
 *
 * @param {object} config - Full config object
 * @returns {string} e.g., "claude (haiku) [single]"
 */
export function getProviderLabel(config) {
  const aiConfig = config.aiProvider || {};
  const strategy = aiConfig.strategy || 'single';
  const execConfig = aiConfig.execute || {};
  const provider = execConfig.provider || 'claude';
  const model = execConfig[provider]?.model || 'default';
  return `${provider} (${model}) [${strategy}]`;
}

/**
 * Check if a provider's CLI is available on PATH.
 *
 * @param {string} provider - 'claude' or 'codex'
 * @returns {Promise<boolean>}
 */
export async function checkProviderAvailable(provider) {
  const adapter = ADAPTERS[provider];
  if (!adapter) return false;

  try {
    execSync(`which ${adapter.getCommand()}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
