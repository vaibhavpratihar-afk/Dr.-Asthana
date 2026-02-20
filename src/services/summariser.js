/**
 * AI Summariser wrapper.
 *
 * Uses the local `aisum` CLI and falls back to a direct node invocation.
 * If summarisation fails, falls back to hard truncation to preserve limits.
 */

import { execFileSync } from 'child_process';
import { warn } from '../logger.js';

const AISUM_FALLBACK_CLI = '/Users/vaibhavpratihar/Desktop/ai-summariser/src/cli.js';
const DEFAULT_TARGET_FILL = 0.95;

function hardTruncate(text, maxChars) {
  if (!text) return '';
  if (!maxChars || text.length <= maxChars) return text;
  return text.substring(0, Math.max(0, maxChars - 3)) + '...';
}

function runAisum(args, input) {
  try {
    return execFileSync('aisum', args, {
      input,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (primaryErr) {
    try {
      return execFileSync('node', [AISUM_FALLBACK_CLI, ...args], {
        input,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (fallbackErr) {
      const message = fallbackErr?.message || primaryErr?.message || 'aisum failed';
      throw new Error(message);
    }
  }
}

/**
 * Summarise text to stay within length limits while preserving detail.
 *
 * @param {string} text
 * @param {object} opts
 * @param {string} [opts.mode='custom'] - aisum mode
 * @param {number} [opts.maxChars] - strict max output size
 * @param {string} [opts.style='detailed'] - concise|balanced|detailed
 * @param {string} [opts.extra] - extra summarisation constraints
 * @param {number} [opts.targetFill=0.95] - desired fill ratio for maxChars
 * @param {string} [opts.label='text'] - label for logs
 * @returns {string}
 */
export function summariseText(text, {
  mode = 'custom',
  maxChars,
  style = 'detailed',
  extra = '',
  targetFill = DEFAULT_TARGET_FILL,
  label = 'text',
} = {}) {
  if (!text) return '';
  if (maxChars && text.length <= maxChars) {
    return text;
  }

  const args = ['--mode', mode, '--style', style, '--target-fill', String(targetFill)];
  if (maxChars) {
    args.push('--max-chars', String(maxChars));
  }
  if (extra) {
    args.push('--extra', extra);
  }

  try {
    const output = runAisum(args, text).trim();
    if (!output) {
      throw new Error('empty summariser output');
    }
    if (maxChars && output.length > maxChars) {
      warn(`Summariser exceeded limit for ${label} (${output.length} > ${maxChars}); applying hard cap`);
      return hardTruncate(output, maxChars);
    }
    return output;
  } catch (error) {
    warn(`Summariser failed for ${label}: ${error.message}. Falling back to hard truncation.`);
    return hardTruncate(text, maxChars);
  }
}

export default {
  summariseText,
};

