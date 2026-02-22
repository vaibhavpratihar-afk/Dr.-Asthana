/**
 * Single strategy — run one provider, return result.
 * If it fails, return failure. No fallback.
 */

import { isGarbageOutput, isRateLimited } from '../provider.js';

/**
 * @param {string} prompt
 * @param {string} workingDir
 * @param {object} modeConfig - Mode-specific config section (e.g., aiProvider.execute)
 * @param {object} adapters - Map of provider name -> adapter module
 * @param {function} spawnFn - The provider.spawn function
 * @param {object} options - { label, logDir, ticketKey }
 * @returns {Promise<{output, completedNormally, exitCode, numTurns, rateLimited, provider, duration}>}
 */
export async function run(prompt, workingDir, modeConfig, adapters, spawnFn, options) {
  const providerName = modeConfig.provider || 'claude';
  const adapter = adapters[providerName];
  if (!adapter) {
    throw new Error(`Unknown provider: ${providerName}`);
  }

  const providerConfig = modeConfig[providerName] || {};
  const { args, timeout, maxTurns } = adapter.buildArgs(prompt, providerConfig);

  const raw = await spawnFn({
    command: adapter.getCommand(),
    args,
    workingDir,
    timeout,
    label: options.label,
    logDir: options.logDir,
    ticketKey: options.ticketKey,
    provider: providerName,
    prompt,
  });

  const parsed = adapter.parseStreamOutput(raw.stdout, raw.exitCode);

  return {
    output: parsed.output,
    completedNormally: parsed.completedNormally,
    exitCode: raw.exitCode,
    numTurns: parsed.numTurns,
    rateLimited: isRateLimited(parsed.output) || adapter.isRateLimited(parsed.output),
    provider: providerName,
    duration: raw.duration,
  };
}
