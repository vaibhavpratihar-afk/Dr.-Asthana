/**
 * Codex CLI adapter.
 */

export function buildArgs(prompt, modeConfig) {
  const timeoutMinutes = modeConfig.timeoutMinutes || 15;
  const model = modeConfig.model || null;
  const additionalWritableDirs = modeConfig.additionalWritableDirs || [];

  const flags = ['--json', '--full-auto'];
  if (model) flags.push('--model', model);

  for (const dir of additionalWritableDirs) {
    if (dir) flags.push('--add-dir', dir);
  }

  return {
    args: ['exec', ...flags, prompt],
    timeout: timeoutMinutes * 60 * 1000,
  };
}

export function parseStreamOutput(rawStdout, exitCode) {
  let sessionId = null;
  let lastItemText = '';
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

    if (event.type === 'item.completed' && event.item) {
      const item = event.item;
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (block.type === 'output_text' || block.type === 'text') {
            lastItemText = block.text || block.value || lastItemText;
          }
        }
      }
      if (item.type === 'agent_message' && item.text) {
        lastItemText = item.text;
      }
    }
  }

  const output = hasStructuredEvents ? lastItemText : (rawStdout || '');
  return { output, sessionId };
}

export function getCommand() {
  return 'codex';
}
