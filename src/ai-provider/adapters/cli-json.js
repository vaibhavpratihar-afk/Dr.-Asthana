/**
 * File: src/ai-provider/adapters/cli-json.js
 * Module: ai-provider
 * Purpose: Generic CLI adapter for JSON-line event based AI runtimes.
 * Key Exports: buildArgs, parseStreamOutput, getCommand
 * Integration Points: Integrates with provider CLIs and pipeline prompt execution flow.
 * Data Flow: Keep side effects explicit; keep pure transformations isolated where possible.
 * Maintenance Notes: Runtime command is configuration-driven; no provider literals live here.
 */
export function buildArgs(prompt, modeConfig) {
  const provider = modeConfig.provider || '';
  if (provider === 'claude') {
    return buildClaudeArgs(prompt, modeConfig);
  }
  return buildCodexArgs(prompt, modeConfig);
}

function buildClaudeArgs(prompt, modeConfig) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (modeConfig.model) args.push('--model', modeConfig.model);
  if (modeConfig.maxTurns) args.push('--max-turns', String(modeConfig.maxTurns));
  return { args };
}

function buildCodexArgs(prompt, modeConfig) {
  const flags = [
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
  ];
  if (modeConfig.model) flags.push('--model', modeConfig.model);
  return { args: ['exec', ...flags, prompt] };
}

export function parseStreamOutput(rawStdout, exitCode) {
  let sessionId = null;
  const textBlocks = [];
  let resultText = '';
  let hasStructuredEvents = false;

  const lines = (rawStdout || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    hasStructuredEvents = true;

    if (event.type === 'thread.started' && event.thread_id) {
      sessionId = event.thread_id;
    }

    // Claude Code stream-json: final result (contains last assistant text)
    if (event.type === 'result' && event.result) {
      resultText = event.result;
    }

    // Agentic mode: collect assistant text from every turn
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          textBlocks.push(block.text);
        }
      }
    }

    if (event.type === 'item.completed' && event.item) {
      const item = event.item;
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (block.type === 'output_text' || block.type === 'text') {
            const t = block.text || block.value || '';
            if (t) textBlocks.push(t);
          }
        }
      }
      if (item.type === 'agent_message' && item.text) {
        textBlocks.push(item.text);
      }
    }
  }

  // Combine all assistant text so PR URL / output markers can be found across turns
  const allText = textBlocks.join('\n');
  let output = resultText || allText || '';
  if (!output && !hasStructuredEvents) output = rawStdout || '';
  if (!output && exitCode !== 0) output = rawStdout || '';

  return { output, sessionId, fullText: allText };
}

export function getCommand(modeConfig) {
  const command = modeConfig.command;
  if (!command) {
    throw new Error('Provider command is required (aiProvider.execute.<provider>.command)');
  }
  return command;
}
