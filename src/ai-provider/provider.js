import { spawnRuntime } from './provider/spawn-runtime.js';

export function spawn(opts) {
  return spawnRuntime(opts);
}

export function buildResult(raw, parsed, providerName) {
  return {
    output: parsed.output,
    exitCode: raw.exitCode,
    provider: providerName,
    duration: raw.duration,
    sessionId: parsed.sessionId || null,
  };
}
