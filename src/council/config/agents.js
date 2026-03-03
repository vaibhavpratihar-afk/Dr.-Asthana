/**
 * Agent Resolver - Council runtime agent list builder.
 *
 * Responsibility:
 * - Convert council config into the ordered runtime agent array.
 *
 * Contract:
 * - Returns [proposer, ...critics].
 * - Index 0 is always proposer; index 1..N are critics.
 * - Falls back to DEFAULT_PROPOSER when config is missing/invalid.
 */
const DEFAULT_PROPOSER = Object.freeze({
  provider: 'claude',
  model: 'sonnet',
  maxTurns: 50,
  timeoutMinutes: 15,
});

export function resolveAgents(councilConfig) {
  const proposer =
    councilConfig?.proposer && typeof councilConfig.proposer === 'object'
      ? councilConfig.proposer
      : DEFAULT_PROPOSER;
  const critics = Array.isArray(councilConfig?.critics) && councilConfig.critics.length > 0
    ? councilConfig.critics
    : [proposer];
  return [proposer, ...critics];
}
