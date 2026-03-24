import { spawnRuntime } from './provider/spawn-runtime.js';
import * as cliJsonAdapter from './adapters/cli-json.js';
import { log } from '../utils/logger.js';

export async function runAI(options) {
  const { prompt, workingDir, mode, label, logDir, ticketKey, config, providerConfig } = options;
  const artifactDir = config._artifactDir || null;

  const providerName = providerConfig.provider;
  if (!providerName) throw new Error('Missing AI provider in runtime config');

  log(`[${label}] runAI: mode=${mode}, provider=${providerName}, model=${providerConfig.model || 'default'}`);
  log(`[${label}] Prompt length: ${prompt.length} characters`);

  const { args } = cliJsonAdapter.buildArgs(prompt, providerConfig);
  const command = cliJsonAdapter.getCommand(providerConfig);

  const raw = await spawnRuntime({
    command,
    args,
    workingDir,
    label,
    logDir,
    ticketKey,
    provider: providerName,
    prompt,
    artifactDir,
  });

  const parsed = cliJsonAdapter.parseStreamOutput(raw.stdout, raw.exitCode);

  const result = {
    output: parsed?.output || '',
    fullText: parsed?.fullText || '',
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : 1,
    provider: providerName,
    duration: Number.isFinite(raw.duration) ? raw.duration : 0,
    sessionId: parsed?.sessionId || null,
  };

  log(`[${label}] runAI complete: exit=${result.exitCode}, duration=${Math.floor(result.duration / 1000)}s, output=${result.output.length} chars`);
  return result;
}

export function getProviderLabel(config) {
  const execConfig = config.aiProvider?.execute || {};
  const provider = execConfig.provider || 'unset-provider';
  const model = execConfig[provider]?.model || 'default';
  return `${provider} (${model})`;
}
