/**
 * Claude Code headless mode integration
 *
 * Two-pass approach:
 *   Pass 1 (Plan)      — explore codebase, produce implementation plan (~20 turns)
 *   Pass 2 (Implement) — execute the plan (full turns)
 *   Pass 3 (Validate)  — if Pass 2 didn't complete normally, review & fix (~30 turns)
 *
 * Prompt construction is delegated to prompt-builder.js (ticket context only).
 * Standing rules live in CLAUDE.md inside the working directory.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { log, warn, debug, logData } from '../logger.js';
import { buildPrompt } from './prompt-builder.js';
import { summariseText } from './summariser.js';

/**
 * Check if output contains a Claude API rate-limit message.
 */
function isRateLimited(text) {
  if (!text) return false;
  return text.includes("You've hit your limit") || text.includes('resets ');
}

/**
 * Check if output looks like a rate-limit or error message rather than real content.
 */
export function isGarbageOutput(text) {
  if (!text || text.trim().length === 0) return true;
  if (isRateLimited(text)) return true;
  if (text.trim().length < 50) return true; // Suspiciously short
  return false;
}

/**
 * Pick the best output from validation, implementation, and plan passes.
 * Prefers structured output (contains FILES CHANGED / SUMMARY / RISKS).
 * Skips garbage (rate limit errors, too-short responses).
 */
function pickBestOutput(validationOutput, implOutput, planOutput) {
  const candidates = [validationOutput, implOutput, planOutput];

  // First: prefer any candidate that has a structured summary
  for (const candidate of candidates) {
    if (candidate && /\*\*SUMMARY[:\*]/i.test(candidate)) {
      return candidate;
    }
  }

  // Second: pick the first non-garbage candidate
  for (const candidate of candidates) {
    if (!isGarbageOutput(candidate)) {
      return candidate;
    }
  }

  // Last resort: return whatever is available
  return validationOutput || implOutput || planOutput || '';
}

/**
 * Ensure logs directory exists
 */
function ensureLogDir(logDir) {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

/**
 * Low-level: spawn Claude Code, stream events, return structured result.
 *
 * @param {object}  opts
 * @param {string}  opts.tmpDir   - Working directory (cloned repo)
 * @param {string}  opts.prompt   - Full prompt text
 * @param {number}  opts.maxTurns - Max agentic turns
 * @param {number}  opts.timeout  - Timeout in milliseconds
 * @param {string}  opts.label    - Human-readable label for logging (e.g. "plan", "implement")
 * @param {string}  opts.logDir   - Directory for log files
 * @param {string}  opts.ticketKey - JIRA ticket key for log filenames
 * @param {string}  [opts.nvmBinDir] - nvm bin directory to prepend to PATH (for target Node version)
 * @returns {Promise<{output: string, completedNormally: boolean, maxTurnsReached: boolean, numTurns: number|null, exitCode: number}>}
 */
export function spawnClaude({ tmpDir, prompt, maxTurns, timeout, label, logDir, ticketKey, nvmBinDir, cliCommand = 'claude', providerLabel = 'Claude' }) {
  log(`[${label}] Running ${providerLabel} Code (maxTurns=${maxTurns}, timeout=${timeout / 60000}min)...`);
  log(`[${label}] Prompt length: ${prompt.length} characters`);
  debug(`[${label}] Working directory: ${tmpDir}`);
  logData(`${providerLabel} prompt (${label})`, prompt);

  const args = [
    '-p', prompt,
    '--max-turns', String(maxTurns),
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  const startTime = Date.now();
  let eventCount = 0;

  // Heartbeat every 30s
  const heartbeat = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    log(`[${label}] heartbeat: ${elapsed}s elapsed, ${eventCount} events`);
  }, 30000);

  return new Promise((resolve, reject) => {
    let lastAssistantText = '';
    let resultEventText = '';
    let stdoutBuffer = '';
    let resultEventReceived = false;
    let numTurns = null;

    const spawnEnv = { ...process.env };
    if (nvmBinDir) {
      spawnEnv.PATH = `${nvmBinDir}:${spawnEnv.PATH}`;
      log(`[${label}] PATH prepended with nvm bin: ${nvmBinDir}`);
    }

    log(`[${label}] Spawning ${providerLabel} process (${cliCommand})...`);
    const proc = spawn(cliCommand, args, {
      cwd: tmpDir,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Close stdin immediately — headless mode doesn't need it
    proc.stdin.end();

    log(`[${label}] ${providerLabel} process spawned (PID: ${proc.pid})`);

    // Parse stream-json events from stdout (newline-delimited JSON)
    proc.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }
        eventCount++;

        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              lastAssistantText = block.text;
              debug(`[${label}] Response text: ${block.text.substring(0, 200)}...`);
            } else if (block.type === 'tool_use') {
              log(`[${label}] Tool: ${block.name}${block.input?.command ? ` — ${block.input.command.substring(0, 80)}` : ''}`);
            }
          }
        } else if (event.type === 'result') {
          resultEventReceived = true;
          if (event.result) {
            resultEventText = event.result;
          }
          numTurns = event.num_turns ?? null;
          debug(`[${label}] Result event: cost=$${event.cost_usd ?? '?'}, duration=${event.duration_ms ?? '?'}ms, turns=${event.num_turns ?? '?'}`);
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString().trim();
      if (chunk) {
        debug(`[${label}:stderr] ${chunk.substring(0, 300)}`);
      }
    });

    const timeoutId = setTimeout(() => {
      clearInterval(heartbeat);
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      log(`[${label}] ${providerLabel} timed out after ${elapsed}s (${eventCount} events)`);
      proc.kill('SIGTERM');
      reject(new Error(`${providerLabel} (${label}) timed out after ${elapsed}s`));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      clearInterval(heartbeat);

      // Process any remaining buffered data
      if (stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer.trim());
          if (event.type === 'result') {
            resultEventReceived = true;
            if (event.result) {
              resultEventText = event.result;
            }
            numTurns = event.num_turns ?? numTurns;
          }
        } catch { /* ignore incomplete JSON */ }
      }

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      log(`[${label}] ${providerLabel} finished: exit=${code}, duration=${elapsed}s, events=${eventCount}`);

      // Authoritative output: result event text wins, fall back to last assistant text
      const output = resultEventText || lastAssistantText || '';

      // Save full output to log file
      ensureLogDir(logDir);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logDir, `${ticketKey}-${label}-${timestamp}.log`);
      const logContent = [
        `=== RUN INFO ===`,
        `Ticket: ${ticketKey}`,
        `Pass: ${label}`,
        `Exit Code: ${code}`,
        `Duration: ${elapsed}s`,
        `Events: ${eventCount}`,
        `Turns: ${numTurns ?? 'unknown'}`,
        `Timestamp: ${new Date().toISOString()}`,
        ``,
        `=== PROMPT ===`,
        prompt,
        ``,
        `=== ${providerLabel.toUpperCase()} OUTPUT ===`,
        output || '(empty)',
        ``,
        `=== EXIT CODE ===`,
        String(code),
      ].join('\n');
      fs.writeFileSync(logFile, logContent);
      log(`[${label}] Output saved to ${logFile}`);

      if (code !== 0) {
        warn(`[${label}] ${providerLabel} exited with code ${code}`);
      }

      const maxTurnsReached = numTurns !== null && numTurns >= maxTurns;
      const completedNormally = code === 0 && resultEventReceived && resultEventText.length > 0;
      const rateLimited = isRateLimited(output);

      if (rateLimited) {
        warn(`[${label}] ${providerLabel} hit API rate limit: "${output.substring(0, 100)}"`);
      }

      resolve({
        output,
        completedNormally,
        maxTurnsReached,
        rateLimited,
        numTurns,
        exitCode: code,
      });
    });

    proc.on('error', (error) => {
      clearTimeout(timeoutId);
      clearInterval(heartbeat);
      log(`[${label}] ${providerLabel} spawn error: ${error.message}`);
      reject(new Error(`Failed to spawn ${providerLabel} (${label}): ${error.message}`));
    });
  });
}

/**
 * Parse plan output into phases using regex.
 * Looks for `### PHASE N: <title>` headers.
 *
 * @param {string} planOutput
 * @returns {Array<{title: string, description: string, files: string[]}>|null}
 */
function parsePhases(planOutput) {
  if (!planOutput) return null;

  const phaseRegex = /### PHASE\s+(\d+):\s*(.+)/gi;
  const matches = [...planOutput.matchAll(phaseRegex)];

  if (matches.length < 2) return null; // Need at least 2 phases to justify splitting

  const phases = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const title = match[2].trim();
    const startIdx = match.index + match[0].length;
    const endIdx = i + 1 < matches.length ? matches[i + 1].index : planOutput.length;
    const body = planOutput.substring(startIdx, endIdx).trim();

    // Extract files list if present (e.g., "Files: foo.js, bar.js")
    const filesMatch = body.match(/Files?:\s*(.+)/i);
    const files = filesMatch
      ? filesMatch[1].split(',').map((f) => f.trim()).filter(Boolean)
      : [];

    phases.push({ title, description: body, files });
  }

  return phases.length >= 2 ? phases : null;
}

/**
 * Parse a multi-branch master plan into per-branch sections.
 * Looks for `### BRANCH: <name>` headers and extracts text between them.
 *
 * @param {string} planOutput - Raw master plan text
 * @returns {Map<string, string>|null} Map of branch name → plan text, or null if < 2 sections found
 */
export function parseMultiBranchPlan(planOutput) {
  if (!planOutput) return null;

  const headerRegex = /###\s*BRANCH:\s*(.+)/gi;
  const matches = [...planOutput.matchAll(headerRegex)];

  if (matches.length < 2) return null;

  const branchPlans = new Map();
  for (let i = 0; i < matches.length; i++) {
    const branchName = matches[i][1].trim();
    const startIdx = matches[i].index + matches[i][0].length;
    const endIdx = i + 1 < matches.length ? matches[i + 1].index : planOutput.length;
    const planText = planOutput.substring(startIdx, endIdx).trim();

    if (planText.length > 0) {
      branchPlans.set(branchName, planText);
    }
  }

  return branchPlans.size >= 2 ? branchPlans : null;
}

/**
 * Fallback: use a lightweight Claude call to parse plan into phases.
 *
 * @param {object} commonOpts - Common spawn options (tmpDir, logDir, ticketKey)
 * @param {string} planOutput - Raw plan text
 * @returns {Array<{title: string, description: string, files: string[]}>|null}
 */
async function parsePhasesWithClaude(commonOpts, planOutput) {
  try {
    const compressedPlan = summariseText(planOutput || '', {
      mode: 'custom',
      maxChars: 8000,
      style: 'detailed',
      extra: 'Preserve phase headers, file paths, ordered steps, and explicit dependencies.',
      label: 'phase-parse-plan',
    });

    const parsePrompt =
      'Parse the following implementation plan into ordered phases. ' +
      'Return ONLY valid JSON, no other text: [{\"title\": \"...\", \"description\": \"...\", \"files\": [\"...\"]}]\n\n' +
      compressedPlan;

    const result = await spawnClaude({
      ...commonOpts,
      prompt: parsePrompt,
      maxTurns: 1,
      timeout: 60 * 1000,
      label: 'parse-phases',
    });

    if (!result.output) return null;

    // Extract JSON from output (may be wrapped in markdown code block)
    const jsonMatch = result.output.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed) || parsed.length < 2) return null;

    // Validate structure
    for (const phase of parsed) {
      if (!phase.title || !phase.description) return null;
      if (!phase.files) phase.files = [];
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Run a continuation pass — picks up where a previous pass left off.
 *
 * @param {object} config
 * @param {object} commonOpts
 * @param {string} basePrompt
 * @param {object} previousResult - Result from the previous pass
 * @param {string} label - Label for logging
 * @returns {Promise<object|null>}
 */
async function runContinuation(config, commonOpts, basePrompt, previousResult, label) {
  const continuationTurns = config.CLAUDE_CONTINUATION_TURNS || config.CLAUDE_MAX_TURNS;
  const continuationTimeout = (config.CLAUDE_CONTINUATION_TIMEOUT_MINUTES || config.CLAUDE_TIMEOUT_MINUTES || 30) * 60 * 1000;
  const continuationSummary = previousResult.output
    ? summariseText(previousResult.output, {
        mode: 'custom',
        maxChars: 2000,
        style: 'detailed',
        extra: 'Preserve completed work, pending tasks, explicit blockers, and test failures.',
        label: `continuation-summary:${label}`,
      })
    : '';

  const continuationPrompt = basePrompt +
    '\n\nA previous implementation pass ran out of turns. ' +
    'Review current state (git diff, modified files), then CONTINUE implementing remaining changes. ' +
    'Do NOT redo completed work.' +
    (continuationSummary ? '\n\n## Last Pass Summary\n' + continuationSummary : '');

  try {
    const result = await spawnClaude({
      ...commonOpts,
      prompt: continuationPrompt,
      maxTurns: continuationTurns,
      timeout: continuationTimeout,
      label,
    });
    return result;
  } catch (err) {
    warn(`Continuation pass (${label}) failed: ${err.message}`);
    return null;
  }
}

/**
 * Run the validation pass — reviews current state and fixes issues.
 */
async function runValidation(config, commonOpts, basePrompt, lastOutput, planOutput) {
  log('═══ Validate ═══');

  const validationPrompt = basePrompt +
    '\n\n## Previous Attempt Output\n' + (lastOutput || '(no output)') +
    '\n\nA previous implementation attempt did not complete successfully. ' +
    'Review the current state of the code, identify any issues, fix them, and run tests to verify.' +
    '\n\nWhen finished, you MUST end with this exact format:\n' +
    '**FILES CHANGED:** list of files\n' +
    '**SUMMARY:** what was done (2-3 sentences)\n' +
    '**RISKS:** what reviewer should check';

  try {
    const validationResult = await spawnClaude({
      ...commonOpts,
      prompt: validationPrompt,
      maxTurns: config.CLAUDE_VALIDATION_TURNS,
      timeout: 15 * 60 * 1000,
      label: 'validate',
    });

    if (validationResult.rateLimited) {
      warn('Rate limited during validate pass.');
    } else if (isGarbageOutput(validationResult.output)) {
      warn(`Validate pass produced garbage output: "${(validationResult.output || '').substring(0, 100)}"`);
    }

    return validationResult;
  } catch (validationError) {
    warn(`Validation pass failed: ${validationError.message}.`);
    return null;
  }
}

/**
 * Run Claude Code with multi-pass approach:
 *   Plan → [Phase execution | Single implement + continuations] → Validate
 *
 * For complex tickets (CLAUDE_ENABLE_PHASES=true), the plan is parsed into phases
 * and each phase runs as a separate Claude session. Falls back to single implement
 * with continuation passes if phase parsing fails.
 *
 * For simple tickets, the existing two-pass behavior is preserved.
 *
 * @param {object} config - Configuration object (may include effectiveConfig overrides)
 * @param {string} tmpDir - Temporary directory with cloned repo
 * @param {string} ticketKey - JIRA ticket key (e.g., JCP-1234)
 * @param {string} ticketSummary - Ticket title/summary
 * @param {string} ticketDescription - Ticket description text
 * @param {Array}  ticketComments - Array of { author, text } comment objects
 */
export async function runClaude(config, tmpDir, ticketKey, ticketSummary, ticketDescription, ticketComments = [], options = {}) {
  const basePrompt = buildPrompt(ticketKey, ticketSummary, ticketDescription, ticketComments);
  const { nvmBinDir, cliCommand = 'claude', providerLabel = 'Claude', externalPlan = null } = options;
  const commonOpts = { tmpDir, logDir: config.LOG_DIR, ticketKey, nvmBinDir, cliCommand, providerLabel };
  const enablePhases = config.CLAUDE_ENABLE_PHASES || false;
  const maxContinuations = config.CLAUDE_MAX_CONTINUATIONS || 0;

  // ── Pass 1: Plan ──────────────────────────────────────────────────
  let planOutput = '';
  let planOk = false;

  if (externalPlan) {
    log('═══ Pass 1: Plan (EXTERNAL — skipped) ═══');
    planOutput = externalPlan;
    planOk = true;
    log(`Using external plan (${externalPlan.length} chars). Skipping plan pass.`);
  } else {

  log('═══ Pass 1: Plan ═══');
  try {
    let planPrompt = basePrompt +
      '\n\nYour task: explore the codebase and produce a detailed implementation plan for the ticket above. Do NOT make any code changes.' +
      '\n\nIMPORTANT: Your entire output will be passed to a SEPARATE Claude session that has NO memory of your exploration. ' +
      'That session will only see the text you write here. So you MUST write out the full plan explicitly — ' +
      'every file to modify, every change to make, in order. Do not say "as discussed" or "the plan is ready" — write the actual plan.';

    // For complex tickets, instruct Claude to output phases
    if (enablePhases) {
      planPrompt += '\n\nWhen writing your plan, organize it into PHASES using this exact format:' +
        '\n\n### PHASE 1: <title>' +
        '\n<description of what to create/modify in this phase>' +
        '\nFiles: <comma-separated list of files>' +
        '\n\n### PHASE 2: <title>' +
        '\n...' +
        '\n\nRules for phases:' +
        '\n- Each phase should be completable in ~50-75 Claude turns' +
        '\n- Earlier phases should not depend on later phases' +
        '\n- Group related file creation together' +
        '\n- Put tests and documentation in the final phase';
    }

    const planResult = await spawnClaude({
      ...commonOpts,
      prompt: planPrompt,
      maxTurns: config.CLAUDE_PLAN_TURNS,
      timeout: (config.CLAUDE_PLAN_TIMEOUT_MINUTES || 10) * 60 * 1000,
      label: 'plan',
    });

    planOutput = planResult.output;

    // Rate limit on plan pass — skip all subsequent passes
    if (planResult.rateLimited) {
      warn('Rate limited during plan pass. Aborting — no code changes made.');
      return { output: '', completedNormally: false, maxTurnsReached: false, rateLimited: true, numTurns: planResult.numTurns, exitCode: planResult.exitCode, planOutput };
    }

    // Validate plan quality — reject suspiciously short or generic plans
    const uselessPlanPatterns = /plan is (complete|ready)|ready to proceed|no changes needed/i;
    const planTooShort = (planOutput || '').trim().length < 200;
    const planIsGeneric = uselessPlanPatterns.test(planOutput || '');

    planOk = planResult.completedNormally && !planTooShort && !planIsGeneric;

    if (planOk) {
      log(`Plan pass completed (${planResult.numTurns} turns). Plan length: ${planOutput.length} chars`);
    } else {
      const reason = planTooShort ? `too short (${(planOutput || '').trim().length} chars)` :
                     planIsGeneric ? 'generic/useless output' :
                     `did not complete normally (exit=${planResult.exitCode}, turns=${planResult.numTurns})`;
      warn(`Plan pass rejected: ${reason}. Proceeding with ticket context only.`);
    }
  } catch (planError) {
    warn(`Plan pass failed: ${planError.message}. Proceeding with ticket context only.`);
  }

  } // end externalPlan else

  // ── Phase execution (complex tickets with good plan) ──────────────
  if (enablePhases && planOk) {
    log('Attempting phase-based execution...');

    // Try regex parsing first, fall back to Claude parsing
    let phases = parsePhases(planOutput);
    if (phases) {
      log(`Parsed ${phases.length} phases via regex`);
    } else {
      log('Regex phase parsing failed, trying Claude fallback...');
      phases = await parsePhasesWithClaude(commonOpts, planOutput);
      if (phases) {
        log(`Parsed ${phases.length} phases via Claude fallback`);
      }
    }

    if (phases) {
      let lastResult = null;
      let totalTurns = 0;
      let anyRateLimited = false;

      for (let i = 0; i < phases.length; i++) {
        const phase = phases[i];
        log(`\n═══ Phase ${i + 1} of ${phases.length}: ${phase.title} ═══`);

        const phasePrompt = basePrompt +
          '\n\n## Implementation Plan (full)\n' + planOutput +
          '\n\n## Current Phase\n' +
          `You are executing Phase ${i + 1}: ${phase.title}\n\n` +
          phase.description +
          '\n\nFocus ONLY on this phase. Files from previous phases are already in place.' +
          '\n\nDo NOT work on later phases.';

        const phaseResult = await spawnClaude({
          ...commonOpts,
          prompt: phasePrompt,
          maxTurns: config.CLAUDE_MAX_TURNS,
          timeout: (config.CLAUDE_TIMEOUT_MINUTES || 30) * 60 * 1000,
          label: `phase-${i + 1}`,
        });

        totalTurns += phaseResult.numTurns || 0;
        lastResult = phaseResult;

        // If phase didn't complete, try one continuation within this phase
        if (!phaseResult.completedNormally || phaseResult.maxTurnsReached) {
          log(`Phase ${i + 1} incomplete — running continuation...`);
          const contResult = await runContinuation(config, commonOpts, basePrompt, phaseResult, `phase-${i + 1}-cont`);
          if (contResult) {
            totalTurns += contResult.numTurns || 0;
            lastResult = contResult;
          }
        }

        // If rate limited, stop all phases
        if (phaseResult.rateLimited) {
          warn(`Rate limited during phase ${i + 1}. Stopping phase execution.`);
          anyRateLimited = true;
          break;
        }
      }

      // Run validate if last phase didn't complete normally
      if (lastResult && (!lastResult.completedNormally || lastResult.maxTurnsReached) && !anyRateLimited) {
        const validationResult = await runValidation(config, commonOpts, basePrompt, lastResult.output, planOutput);
        if (validationResult) {
          const bestOutput = pickBestOutput(validationResult.output, lastResult.output, planOutput);
          return {
            output: bestOutput,
            completedNormally: validationResult.completedNormally,
            maxTurnsReached: validationResult.maxTurnsReached,
            rateLimited: validationResult.rateLimited || false,
            numTurns: totalTurns + (validationResult.numTurns || 0),
            exitCode: validationResult.exitCode,
            planOutput,
          };
        }
      }

      const bestOutput = pickBestOutput(null, lastResult?.output, planOutput);
      return {
        output: bestOutput,
        completedNormally: lastResult?.completedNormally || false,
        maxTurnsReached: lastResult?.maxTurnsReached || false,
        rateLimited: anyRateLimited,
        numTurns: totalTurns,
        exitCode: lastResult?.exitCode ?? 1,
        planOutput,
      };
    }

    // Phase parsing failed — fall through to standard implement path
    log('Phase parsing failed (both regex and Claude). Falling back to standard implementation.');
  }

  // ── Standard implement path (simple tickets or phase parsing failure) ──
  log('═══ Pass 2: Implement ═══');
  let implPrompt;
  if (planOk) {
    implPrompt = basePrompt +
      '\n\n## Implementation Plan (from analysis pass)\n' + planOutput +
      '\n\nImplement this plan now.';
  } else {
    // Graceful degradation — just the ticket context
    implPrompt = basePrompt +
      '\n\nExplore the codebase, understand the relevant files and patterns, then implement the required changes.';
  }

  const implResult = await spawnClaude({
    ...commonOpts,
    prompt: implPrompt,
    maxTurns: config.CLAUDE_MAX_TURNS,
    timeout: (config.CLAUDE_TIMEOUT_MINUTES || 30) * 60 * 1000,
    label: 'implement',
  });

  // Rate limit on implement pass — return best available output, skip everything
  if (implResult.rateLimited) {
    warn('Rate limited during implement pass. Skipping validation.');
    const bestOutput = pickBestOutput(null, implResult.output, planOutput);
    return { output: bestOutput, completedNormally: false, maxTurnsReached: false, rateLimited: true, numTurns: implResult.numTurns, exitCode: implResult.exitCode, planOutput };
  }

  // ── Continuation passes (if implement didn't complete and continuations enabled) ──
  let lastResult = implResult;
  let totalTurns = implResult.numTurns || 0;

  if (maxContinuations > 0 && (!implResult.completedNormally || implResult.maxTurnsReached)) {
    for (let i = 0; i < maxContinuations; i++) {
      log(`═══ Continuation ${i + 1} of ${maxContinuations} ═══`);
      const contResult = await runContinuation(config, commonOpts, basePrompt, lastResult, `continuation-${i + 1}`);

      if (!contResult) break;
      totalTurns += contResult.numTurns || 0;
      lastResult = contResult;

      if (contResult.rateLimited) {
        warn(`Rate limited during continuation ${i + 1}. Stopping.`);
        break;
      }

      // If this continuation completed normally, no need for more
      if (contResult.completedNormally && !contResult.maxTurnsReached) {
        log(`Continuation ${i + 1} completed normally. No more continuations needed.`);
        break;
      }
    }
  }

  // ── Validate (if last pass didn't complete normally) ────
  if (!lastResult.completedNormally || lastResult.maxTurnsReached) {
    const validationResult = await runValidation(config, commonOpts, basePrompt, lastResult.output, planOutput);
    if (validationResult) {
      const bestOutput = pickBestOutput(validationResult.output, lastResult.output, planOutput);
      return {
        output: bestOutput,
        completedNormally: validationResult.completedNormally,
        maxTurnsReached: validationResult.maxTurnsReached,
        rateLimited: validationResult.rateLimited || false,
        numTurns: totalTurns + (validationResult.numTurns || 0),
        exitCode: validationResult.exitCode,
        planOutput,
      };
    }
  }

  return {
    ...lastResult,
    numTurns: totalTurns,
    planOutput,
  };
}

export default { runClaude, spawnClaude, isGarbageOutput, parseMultiBranchPlan };
