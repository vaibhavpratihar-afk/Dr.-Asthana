/**
 * Quality gate for debate output.
 *
 * Checks:
 * - Does the output contain specific file paths?
 * - Does it have code snippets for core changes?
 * - Does it reference real functions/variables/patterns?
 * - Is it structured as actionable steps (not a discussion)?
 * - Is it long enough to be substantive (not a hand-wave)?
 *
 * Spawns a lightweight AI session to judge and extract the cheatsheet.
 * All AI spawning goes through the AI Provider module via runAI().
 */

import { runAI } from '../ai-provider/index.js';
import { log, warn, debug } from '../utils/logger.js';

/**
 * Evaluate debate output and produce a cheatsheet.
 *
 * @param {string} debateOutput - Combined output from debate rounds
 * @param {string} ticketContext - Ticket context for reference
 * @param {object} config - Full config object
 * @param {object} [options]
 * @param {boolean} [options.force=false] - Force produce best-effort cheatsheet
 * @param {string} [options.ticketKey] - JIRA ticket key for log filenames
 * @returns {Promise<{passed: boolean, feedback: string, cheatsheet: string|null}>}
 */
export async function evaluate(debateOutput, ticketContext, config, options = {}) {
  const { force = false, ticketKey = 'eval' } = options;

  // First: structural checks (fast, no API calls)
  const structuralResult = structuralCheck(debateOutput);
  if (!force && !structuralResult.passed) {
    return { passed: false, feedback: structuralResult.feedback, cheatsheet: null };
  }

  // Second: use a lightweight AI call to extract/judge the cheatsheet
  const extractorPrompt = buildExtractorPrompt(debateOutput, ticketContext, force);

  try {
    const result = await runAI({
      prompt: extractorPrompt,
      workingDir: process.cwd(),
      mode: 'evaluate',
      label: force ? 'evaluator-force' : 'evaluator',
      logDir: config.agent.logDir,
      ticketKey,
      config,
    });

    const output = result.output || '';

    // Parse the evaluator's response
    if (output.includes('APPROVED')) {
      const cheatsheet = extractCheatsheet(output);
      if (cheatsheet && cheatsheet.length > 100) {
        return { passed: true, feedback: '', cheatsheet };
      }
      // Approved but no extractable cheatsheet — use raw debate output as cheatsheet
      return { passed: true, feedback: '', cheatsheet: debateOutput };
    }

    if (output.includes('REJECTED') && !force) {
      const feedback = extractFeedback(output);
      return { passed: false, feedback: feedback || 'Evaluator rejected without specific feedback', cheatsheet: null };
    }

    // Force mode or ambiguous response — extract best-effort cheatsheet
    if (force) {
      const cheatsheet = extractCheatsheet(output) || debateOutput;
      return { passed: true, feedback: 'Forced extraction', cheatsheet };
    }

    return { passed: false, feedback: 'Evaluator produced ambiguous response', cheatsheet: null };

  } catch (err) {
    warn(`Evaluator failed: ${err.message}`);
    if (force) {
      // Use raw debate output as fallback cheatsheet
      return { passed: true, feedback: 'Evaluator failed, using raw debate output', cheatsheet: debateOutput };
    }
    return { passed: false, feedback: `Evaluator error: ${err.message}`, cheatsheet: null };
  }
}

/**
 * Structural checks on debate output (no API calls).
 */
function structuralCheck(debateOutput) {
  if (!debateOutput || debateOutput.trim().length < 200) {
    return { passed: false, feedback: 'Debate output too short (< 200 chars)' };
  }

  // Check for file paths (at least 2)
  const filePathPattern = /[\w\-./]+\.(js|ts|jsx|tsx|json|yml|yaml|md|css|html|py|go|rs|sh)/g;
  const filePaths = debateOutput.match(filePathPattern) || [];
  if (filePaths.length < 2) {
    return { passed: false, feedback: 'Debate output mentions fewer than 2 file paths' };
  }

  // Check for actionable language
  const actionPatterns = /\b(create|modify|add|remove|update|change|replace|delete|implement|refactor)\b/gi;
  const actionCount = (debateOutput.match(actionPatterns) || []).length;
  if (actionCount < 3) {
    return { passed: false, feedback: 'Debate output lacks actionable language (fewer than 3 action verbs)' };
  }

  return { passed: true, feedback: '' };
}

function buildExtractorPrompt(debateOutput, ticketContext, force) {
  const modeInstruction = force
    ? 'You MUST produce a cheatsheet even if the debate output is imperfect. Do your best.'
    : 'Only approve if the debate output contains a clear, actionable implementation plan.';

  return `You are a quality evaluator for an AI code implementation debate.

## Ticket Context
${ticketContext}

## Debate Output
${debateOutput}

## Your Task
${modeInstruction}

Evaluate the debate output and either:
1. Write "APPROVED" followed by a clean, actionable cheatsheet extracted from the debate, OR
2. Write "REJECTED" followed by specific feedback about what's missing.

The cheatsheet must be:
- A step-by-step implementation guide
- Reference specific files and code changes
- Be self-contained (readable by someone who hasn't seen the debate)

Format your cheatsheet between === CHEATSHEET START === and === CHEATSHEET END === markers.
Format your feedback after === FEEDBACK === marker.`;
}

function extractCheatsheet(output) {
  const startMarker = '=== CHEATSHEET START ===';
  const endMarker = '=== CHEATSHEET END ===';
  const startIdx = output.indexOf(startMarker);
  const endIdx = output.indexOf(endMarker);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return output.substring(startIdx + startMarker.length, endIdx).trim();
  }

  // Fallback: try to extract everything after APPROVED
  const approvedIdx = output.indexOf('APPROVED');
  if (approvedIdx !== -1) {
    const afterApproved = output.substring(approvedIdx + 'APPROVED'.length).trim();
    if (afterApproved.length > 100) {
      return afterApproved;
    }
  }

  return null;
}

function extractFeedback(output) {
  const marker = '=== FEEDBACK ===';
  const idx = output.indexOf(marker);
  if (idx !== -1) {
    return output.substring(idx + marker.length).trim();
  }

  const rejectedIdx = output.indexOf('REJECTED');
  if (rejectedIdx !== -1) {
    return output.substring(rejectedIdx + 'REJECTED'.length).trim().substring(0, 500);
  }

  return null;
}
