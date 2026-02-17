/**
 * Re-trigger Detection and Analysis
 *
 * Detects when a ticket has been re-triggered (done labels exist) and uses
 * a lightweight Claude call to determine which versions need rework.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { log, warn, debug } from '../logger.js';

/**
 * Ensure logs directory exists
 */
function ensureLogDir(logDir) {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

/**
 * Detect if a ticket is a re-trigger and determine which branches to process.
 *
 * Detection: checks for existing `dr-asthana-done-{version}` or bare `dr-asthana-done` labels.
 * If re-triggered, analyzes comments with a lightweight Claude call to determine which
 * versions need rework. Falls back to processing all versions on any failure.
 *
 * @param {object} config - Configuration object
 * @param {object} ticket - Parsed ticket object with labels, comments, targetBranches
 * @returns {Promise<{isRetrigger: boolean, filteredBranches: Array|null, completedVersions: string[]}>}
 */
export async function detectAndFilterRetrigger(config, ticket) {
  const donePrefix = config.JIRA_LABEL_PROCESSED;
  const bareDoneLabel = donePrefix;

  // Find done labels — versioned (e.g., dr-asthana-done-1.10.3) or bare (dr-asthana-done)
  const doneLabels = ticket.labels.filter(
    label => label === bareDoneLabel || label.startsWith(donePrefix + '-')
  );

  if (doneLabels.length === 0) {
    return { isRetrigger: false, filteredBranches: null, completedVersions: [] };
  }

  // Extract completed versions from done label suffixes
  const completedVersions = doneLabels
    .map(label => {
      if (label === bareDoneLabel) {
        // Bare label — for single-version tickets, the version is the only target
        if (ticket.targetBranches && ticket.targetBranches.length === 1) {
          return ticket.targetBranches[0].version;
        }
        return null;
      }
      return label.substring(donePrefix.length + 1); // strip "dr-asthana-done-"
    })
    .filter(Boolean);

  // All versions from target branches
  const allVersions = (ticket.targetBranches || []).map(tb => tb.version);

  // Identify new versions (no done label) — always include these
  const newVersions = allVersions.filter(v => !completedVersions.includes(v));

  // If no comments, can't determine intent — process all
  if (!ticket.comments || ticket.comments.length === 0) {
    log('Re-trigger detected but no comments — processing all versions');
    return { isRetrigger: true, filteredBranches: null, completedVersions };
  }

  // Run analysis
  const analysis = await analyzeRetrigger(
    config, ticket.key, ticket.comments, completedVersions, allVersions
  );

  // Fallback: analysis failed
  if (!analysis) {
    log('Re-trigger analysis failed — processing all versions (safe fallback)');
    return { isRetrigger: true, filteredBranches: null, completedVersions };
  }

  // Fallback: analysis returned empty
  if (analysis.versionsToProcess.length === 0) {
    log('Re-trigger analysis returned empty — processing all versions (safe fallback)');
    return { isRetrigger: true, filteredBranches: null, completedVersions };
  }

  // Merge analysis result with new versions (always include versions without done labels)
  const versionsToProcess = [...new Set([...analysis.versionsToProcess, ...newVersions])];

  // Map back to branch objects
  const filteredBranches = (ticket.targetBranches || []).filter(
    tb => versionsToProcess.includes(tb.version)
  );

  return {
    isRetrigger: true,
    filteredBranches,
    completedVersions,
    reasoning: analysis.reasoning,
    doneLabels,
  };
}

/**
 * Analyze a re-triggered ticket's comments to determine which versions need rework.
 *
 * Uses a lightweight Claude CLI call (1 turn, no tools, 60s timeout) to parse
 * natural-language comments and return the versions that should be re-processed.
 *
 * @param {object} config - Configuration object
 * @param {string} ticketKey - JIRA ticket key (e.g., JCP-9777)
 * @param {Array} comments - Array of { author, text } comment objects
 * @param {string[]} completedVersions - Versions with existing done labels (e.g., ['1.10.3', '1.10.6'])
 * @param {string[]} allVersions - All target versions on the ticket (e.g., ['1.10.3', '1.10.6'])
 * @returns {Promise<{versionsToProcess: string[], reasoning: string}|null>} Parsed result or null on failure
 */
export async function analyzeRetrigger(config, ticketKey, comments, completedVersions, allVersions) {
  const commentsText = comments
    .map((c, i) => `Comment ${i + 1} by ${c.author}:\n${c.text}`)
    .join('\n\n');

  const prompt = `You are analyzing a JIRA ticket (${ticketKey}) that was re-triggered for rework.

The bot previously processed these versions: ${completedVersions.join(', ')}
All versions on this ticket: ${allVersions.join(', ')}

The user re-added the bot's label to request rework. Read the comments below and determine which versions need to be re-processed.

IMPORTANT:
- Ignore any comments authored by "Dr. Asthana" — those are bot-generated.
- If the comments clearly indicate specific versions need rework, return only those.
- If the comments are unclear or don't mention specific versions, return ALL versions.
- Consider phrases like "looks good", "works fine", "approved" as NOT needing rework.
- Consider phrases like "failing", "needs fix", "rework", "issue with" as needing rework.

## Comments
${commentsText}

Respond with ONLY a JSON object in this exact format, no other text:
{"versionsToProcess": ["1.10.6"], "reasoning": "brief explanation"}

The versionsToProcess array must only contain values from this list: ${JSON.stringify(allVersions)}`;

  log(`Running re-trigger analysis for ${ticketKey}...`);
  log(`Prompt length: ${prompt.length} characters`);

  const args = [
    '-p', prompt,
    '--max-turns', '1',
    '--output-format', 'text',
    '--permission-mode', 'default',
    '--strict-mcp-config',
  ];

  const RETRIGGER_TIMEOUT = 60_000; // 60 seconds
  const startTime = Date.now();

  try {
    const result = await new Promise((resolve, reject) => {
      let rawOutput = '';

      const proc = spawn('claude', args, {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      proc.stdin.end();

      proc.stdout.on('data', (data) => {
        rawOutput += data.toString();
      });

      proc.stderr.on('data', (data) => {
        debug(`Re-trigger analysis stderr: ${data.toString().trim().substring(0, 200)}`);
      });

      const timeoutId = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error('Re-trigger analysis timed out after 60s'));
      }, RETRIGGER_TIMEOUT);

      proc.on('close', (code) => {
        clearTimeout(timeoutId);
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        log(`Re-trigger analysis finished: exit=${code}, duration=${elapsed}s`);

        if (code !== 0) {
          reject(new Error(`Re-trigger analysis exited with code ${code}`));
          return;
        }
        resolve(rawOutput);
      });

      proc.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to spawn Claude for re-trigger analysis: ${error.message}`));
      });
    });

    log(`Re-trigger analysis response: ${result.substring(0, 500)}`);

    // Save analysis to log file
    ensureLogDir(config.LOG_DIR);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(config.LOG_DIR, `retrigger-${ticketKey}-${timestamp}.log`);
    fs.writeFileSync(logFile, [
      `=== RE-TRIGGER ANALYSIS ===`,
      `Ticket: ${ticketKey}`,
      `Completed versions: ${completedVersions.join(', ')}`,
      `All versions: ${allVersions.join(', ')}`,
      `Timestamp: ${new Date().toISOString()}`,
      ``,
      `=== PROMPT ===`,
      prompt,
      ``,
      `=== RESPONSE ===`,
      result || '(empty)',
    ].join('\n'));
    log(`Re-trigger analysis log saved to ${logFile}`);

    // Parse response — strip markdown code fences, extract JSON
    let cleaned = result.trim();
    cleaned = cleaned.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      warn(`Re-trigger analysis: no JSON found in response`);
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (!Array.isArray(parsed.versionsToProcess)) {
      warn(`Re-trigger analysis: versionsToProcess is not an array`);
      return null;
    }

    // Validate all returned versions are in allVersions
    const validVersions = parsed.versionsToProcess.filter(v => allVersions.includes(v));
    if (validVersions.length !== parsed.versionsToProcess.length) {
      warn(`Re-trigger analysis: some versions not in allVersions, filtered ${parsed.versionsToProcess.length} → ${validVersions.length}`);
    }

    const finalResult = {
      versionsToProcess: validVersions,
      reasoning: parsed.reasoning || '',
    };

    log(`Re-trigger analysis result: ${JSON.stringify(finalResult)}`);
    return finalResult;

  } catch (error) {
    warn(`Re-trigger analysis failed: ${error.message}`);
    return null;
  }
}
