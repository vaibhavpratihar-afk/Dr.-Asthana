/**
 * File: src/ai-provider/provider/event-parser.js
 * Module: ai-provider
 * Purpose: Stream event parser that extracts concise agent output summaries.
 * Key Exports: processOutputLine
 * Integration Points: Integrates with provider CLIs and pipeline prompt execution flow.
 * Data Flow: Keep side effects explicit; keep pure transformations isolated where possible.
 * Maintenance Notes: Header intentionally documents file intent for fast onboarding and review.
 */
import { log, debug } from '../../utils/logger.js';
function pushSummary(logSummaryLines, line) {
  if (!line) return;
  logSummaryLines.push(line);
}

/**
 * Parse one stdout line and update summaries/callbacks.
 *
 * @returns {boolean} true when line was valid JSON and counted as an event
 */
export function processOutputLine({ line, label, logSummaryLines }) {
  const trimmed = line.trim();
  if (!trimmed) return false;

  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return false;
  }

  appendSummaryForEvent(event, label, logSummaryLines);
  return true;
}

function appendSummaryForEvent(event, label, logSummaryLines) {
  switch (event.type) {
    case 'assistant':
      if (event.message?.content) {
        for (const block of event.message.content) {
          switch (block.type) {
            case 'text':
              debug(`[${label}] Response text: ${block.text.substring(0, 200)}...`);
              pushSummary(logSummaryLines, `[text] ${block.text}`);
              break;
            case 'tool_use':
              log(`[${label}] Tool: ${block.name}${block.input?.command ? ` — ${block.input.command.substring(0, 80)}` : ''}`);
              pushSummary(logSummaryLines, `[tool] ${block.name}${block.input?.command ? `: ${block.input.command.substring(0, 200)}` : ''}`);
              break;
          }
        }
      }
      break;
    case 'result':
      debug(`[${label}] Result event: cost=$${event.cost_usd ?? '?'}, duration=${event.duration_ms ?? '?'}ms, turns=${event.num_turns ?? '?'}`);
      pushSummary(logSummaryLines, `[result] cost=$${event.cost_usd ?? '?'}, duration=${event.duration_ms ?? '?'}ms, turns=${event.num_turns ?? '?'}`);
      break;
    case 'item.completed':
      if (event.item) {
        switch (event.item.type) {
          case 'reasoning':
            if (event.item.text) {
              debug(`[${label}] thinking: ${event.item.text}`);
              pushSummary(logSummaryLines, `[thinking] ${event.item.text}`);
            }
            break;
          case 'agent_message':
            if (event.item.text) {
              log(`[${label}] agent: ${event.item.text.substring(0, 200)}${event.item.text.length > 200 ? '...' : ''}`);
              pushSummary(logSummaryLines, `[agent] ${event.item.text}`);
            }
            break;
          case 'command_execution':
            if (event.item.command) {
              const cmd = event.item.command.replace(/^\/bin\/zsh -lc '(.+)'$/, '$1');
              log(`[${label}] exec: ${cmd.substring(0, 120)}${cmd.length > 120 ? '...' : ''}`);
              pushSummary(logSummaryLines, `[exec] ${cmd}`);
              if (event.item.aggregated_output) pushSummary(logSummaryLines, event.item.aggregated_output.substring(0, 1000));
            }
            break;
        }
      }
      break;
  }
}
