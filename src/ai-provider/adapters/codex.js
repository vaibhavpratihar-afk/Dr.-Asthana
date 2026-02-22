/**
 * Codex CLI adapter.
 *
 * Translates between the generic ai-provider interface and Codex's
 * --quiet --approval-mode full-auto CLI.
 */

export const name = 'codex';

/**
 * Build CLI arguments for Codex.
 *
 * @param {string} prompt - The prompt text
 * @param {object} modeConfig - Mode-specific config (e.g., aiProvider.execute.codex)
 * @returns {{ args: string[], timeout: number, maxTurns: number }}
 */
export function buildArgs(prompt, modeConfig) {
  const timeoutMinutes = modeConfig.timeoutMinutes || 15;
  const model = modeConfig.model || null;

  const args = [
    '--quiet',
    '--prompt', prompt,
    '--approval-mode', 'full-auto',
  ];

  if (model) {
    args.push('--model', model);
  }

  return {
    args,
    timeout: timeoutMinutes * 60 * 1000,
    maxTurns: 999, // Codex doesn't have a turn concept
  };
}

/**
 * Parse Codex output — returns raw stdout as plain text.
 * Codex doesn't use stream-json format.
 *
 * @param {string} rawStdout - Full stdout buffer
 * @param {number} exitCode - Process exit code
 * @returns {{ output: string, numTurns: number|null, completedNormally: boolean }}
 */
export function parseStreamOutput(rawStdout, exitCode) {
  return {
    output: rawStdout || '',
    numTurns: null,
    completedNormally: exitCode === 0 && rawStdout.trim().length > 0,
  };
}

/**
 * Get the CLI command name.
 */
export function getCommand() {
  return 'codex';
}

/**
 * Check if output indicates Codex rate limiting.
 */
export function isRateLimited(output) {
  if (!output) return false;
  return output.includes('rate limit') || output.includes('Rate limit');
}
