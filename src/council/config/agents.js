/**
 * Council agent configuration resolver.
 *
 * Normalizes legacy single-provider config and newer per-agent debaters[]
 * config into one consistent agent list consumed by the runner.
 */
export function resolveAgents(debateConfig) {
  if (Array.isArray(debateConfig.debaters) && debateConfig.debaters.length >= 2) {
    return debateConfig.debaters;
  }
  const provider = debateConfig.provider || 'claude';
  const providerSettings = debateConfig[provider] || {};
  return [
    { provider, ...providerSettings },
    { provider, ...providerSettings },
  ];
}
