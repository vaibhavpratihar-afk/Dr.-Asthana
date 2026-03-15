/**
 * File: src/ai-provider/provider/log-writer.js
 * Module: ai-provider
 * Purpose: Module implementation for domain-specific behavior in this subsystem.
 * Key Exports: writePromptFile, writeLogFile
 * Integration Points: Integrates with provider CLIs and pipeline prompt execution flow.
 * Data Flow: Keep side effects explicit; keep pure transformations isolated where possible.
 * Maintenance Notes: Header intentionally documents file intent for fast onboarding and review.
 */
import fs from 'fs';
import path from 'path';
import { log, warn } from '../../utils/logger.js';

/**
 * Write prompt to artifact ai-calls directory for live inspection.
 */
export function writePromptFile(artifactDir, label, prompt) {
  if (!artifactDir || !prompt) return;
  try {
    const aiCallsDir = path.join(artifactDir, 'ai-calls');
    if (!fs.existsSync(aiCallsDir)) fs.mkdirSync(aiCallsDir, { recursive: true });
    fs.writeFileSync(path.join(aiCallsDir, `${label}.prompt.md`), prompt);
  } catch (err) {
    warn(`[${label}] Failed to write prompt log file: ${err?.message || err}`);
  }
}

/**
 * Write run output to artifact directory or fallback log directory.
 */
export function writeLogFile({ logDir, ticketKey, provider, label, code, elapsed, eventCount, prompt, logSummaryLines, artifactDir }) {
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
    `=== AGENT OUTPUT ===`,
    logSummaryLines.length > 0 ? logSummaryLines.join('\n') : '(no output captured)',
  ].join('\n');

  if (artifactDir) {
    try {
      const aiCallsDir = path.join(artifactDir, 'ai-calls');
      if (!fs.existsSync(aiCallsDir)) fs.mkdirSync(aiCallsDir, { recursive: true });
      const artifactLogFile = path.join(aiCallsDir, `${label}.log`);
      fs.writeFileSync(artifactLogFile, logContent);
      log(`[${label}] Output saved to ${artifactLogFile}`);
    } catch {
      // non-critical
    }
    return;
  }

  if (!logDir) return;
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const providerTag = provider ? `-${provider}` : '';
    const logFile = path.join(logDir, `${ticketKey}-${label}${providerTag}-${timestamp}.log`);
    fs.writeFileSync(logFile, logContent);
    log(`[${label}] Output saved to ${logFile}`);
  } catch {
    // non-critical
  }
}
