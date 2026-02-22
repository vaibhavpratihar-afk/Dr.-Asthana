/**
 * Core spawn engine — provider-agnostic process lifecycle.
 *
 * Handles:
 *  - Child process spawning
 *  - Stdout streaming with per-line event parsing
 *  - Heartbeat logging every 30s
 *  - Timeout with SIGTERM
 *  - Output log file writing
 *
 * This file does NOT know about Claude or Codex specifics.
 * Adapters translate between this generic interface and provider CLIs.
 */

import { spawn as nodeSpawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { log, warn, debug } from '../utils/logger.js';

/**
 * Spawn a CLI process and stream output.
 *
 * @param {object} opts
 * @param {string} opts.command - CLI command to run (e.g., 'claude', 'codex')
 * @param {string[]} opts.args - CLI arguments
 * @param {string} opts.workingDir - Working directory for the process
 * @param {number} opts.timeout - Timeout in milliseconds
 * @param {string} opts.label - Human-readable label for logging
 * @param {string} [opts.logDir] - Directory for log files
 * @param {string} [opts.ticketKey] - JIRA ticket key for log filenames
 * @param {string} [opts.provider] - Provider name for log filenames
 * @param {string} [opts.prompt] - Original prompt (written to log file)
 * @param {function} [opts.onEvent] - Callback for each parsed JSON event
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number, duration: number}>}
 */
export function spawn({ command, args, workingDir, timeout, label, logDir, ticketKey, provider, prompt, onEvent }) {
  log(`[${label}] Spawning ${command} (timeout=${Math.round(timeout / 60000)}min)...`);
  debug(`[${label}] Working directory: ${workingDir}`);

  const startTime = Date.now();
  let eventCount = 0;

  const heartbeat = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    log(`[${label}] heartbeat: ${elapsed}s elapsed, ${eventCount} events`);
  }, 30000);

  return new Promise((resolve, reject) => {
    let stdoutBuffer = '';
    let rawStdout = '';
    let rawStderr = '';

    const proc = nodeSpawn(command, args, {
      cwd: workingDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdin.end();
    log(`[${label}] Process spawned (PID: ${proc.pid})`);

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      rawStdout += chunk;
      stdoutBuffer += chunk;

      // Parse newline-delimited events
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          // Not JSON — pass raw line to callback
          if (onEvent) onEvent({ type: 'raw', text: trimmed });
          continue;
        }
        eventCount++;

        if (onEvent) onEvent(event);

        // Standard logging for known event types
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              debug(`[${label}] Response text: ${block.text.substring(0, 200)}...`);
            } else if (block.type === 'tool_use') {
              log(`[${label}] Tool: ${block.name}${block.input?.command ? ` — ${block.input.command.substring(0, 80)}` : ''}`);
            }
          }
        } else if (event.type === 'result') {
          debug(`[${label}] Result event: cost=$${event.cost_usd ?? '?'}, duration=${event.duration_ms ?? '?'}ms, turns=${event.num_turns ?? '?'}`);
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      rawStderr += chunk;
      const trimmed = chunk.trim();
      if (trimmed) {
        debug(`[${label}:stderr] ${trimmed.substring(0, 300)}`);
      }
    });

    const timeoutId = setTimeout(() => {
      clearInterval(heartbeat);
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      log(`[${label}] Timed out after ${elapsed}s (${eventCount} events)`);
      proc.kill('SIGTERM');
      reject(new Error(`${command} (${label}) timed out after ${elapsed}s`));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      clearInterval(heartbeat);

      // Flush remaining buffer
      if (stdoutBuffer.trim()) {
        if (onEvent) {
          try {
            const event = JSON.parse(stdoutBuffer.trim());
            onEvent(event);
          } catch { /* ignore incomplete JSON */ }
        }
        rawStdout += '';
      }

      const duration = Date.now() - startTime;
      const elapsed = Math.floor(duration / 1000);
      log(`[${label}] Finished: exit=${code}, duration=${elapsed}s, events=${eventCount}`);

      if (code !== 0) {
        warn(`[${label}] Exited with code ${code}`);
      }

      // Write log file
      if (logDir && ticketKey) {
        writeLogFile({ logDir, ticketKey, provider, label, code, elapsed, eventCount, prompt, rawStdout });
      }

      resolve({
        stdout: rawStdout,
        stderr: rawStderr,
        exitCode: code,
        duration,
      });
    });

    proc.on('error', (error) => {
      clearTimeout(timeoutId);
      clearInterval(heartbeat);
      reject(new Error(`Failed to spawn ${command} (${label}): ${error.message}`));
    });
  });
}

/**
 * Write run output to a log file.
 */
function writeLogFile({ logDir, ticketKey, provider, label, code, elapsed, eventCount, prompt, rawStdout }) {
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const providerTag = provider ? `-${provider}` : '';
    const logFile = path.join(logDir, `${ticketKey}-${label}${providerTag}-${timestamp}.log`);
    const logContent = [
      `=== RUN INFO ===`,
      `Ticket: ${ticketKey}`,
      `Pass: ${label}`,
      `Provider: ${provider || 'unknown'}`,
      `Exit Code: ${code}`,
      `Duration: ${elapsed}s`,
      `Events: ${eventCount}`,
      ``,
      ...(prompt ? [`=== PROMPT ===`, prompt, ``] : []),
      `=== STDOUT ===`,
      rawStdout || '(empty)',
    ].join('\n');
    fs.writeFileSync(logFile, logContent);
    log(`[${label}] Output saved to ${logFile}`);
  } catch { /* non-critical */ }
}

/**
 * Check if output is garbage (empty, too short, or rate-limited).
 */
export function isGarbageOutput(text) {
  if (!text || text.trim().length === 0) return true;
  if (isRateLimited(text)) return true;
  if (text.trim().length < 50) return true;
  return false;
}

/**
 * Check if output indicates rate limiting.
 */
export function isRateLimited(text) {
  if (!text) return false;
  return text.includes("You've hit your limit") || text.includes('resets ');
}

/**
 * Pick the best output from multiple results.
 * Prefers structured output (FILES CHANGED/SUMMARY), then longer non-garbage, then any non-empty.
 */
export function pickBestOutput(results) {
  const valid = results.filter(r => r && r.output && !isGarbageOutput(r.output));
  if (valid.length === 0) {
    // Return first non-null result even if garbage
    return results.find(r => r && r.output) || results[0] || null;
  }

  // Prefer structured output
  const structured = valid.filter(r =>
    r.output.includes('FILES CHANGED') || r.output.includes('SUMMARY') || r.output.includes('RISKS')
  );
  if (structured.length > 0) {
    return structured.reduce((a, b) => a.output.length > b.output.length ? a : b);
  }

  // Prefer completed normally
  const completed = valid.filter(r => r.completedNormally);
  if (completed.length > 0) {
    return completed.reduce((a, b) => a.output.length > b.output.length ? a : b);
  }

  // Longest non-garbage
  return valid.reduce((a, b) => a.output.length > b.output.length ? a : b);
}
