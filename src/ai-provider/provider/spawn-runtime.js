import { spawn as nodeSpawn } from 'child_process';
import { log, warn, debug } from '../../utils/logger.js';
import { processOutputLine } from './event-parser.js';
import { writePromptFile, writeLogFile } from './log-writer.js';

export function spawnRuntime({ command, args, workingDir, label, logDir, ticketKey, provider, prompt, artifactDir }) {
  log(`[${label}] Spawning ${command}...`);
  writePromptFile(artifactDir, label, prompt);

  const startTime = Date.now();
  let eventCount = 0;
  const logSummaryLines = [];

  return new Promise((resolve, reject) => {
    let stdoutBuffer = '';
    let rawStdout = '';
    let rawStderr = '';

    const heartbeat = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      log(`[${label}] heartbeat: ${elapsed}s elapsed, ${eventCount} events`);
    }, 30_000);

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

      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        if (processOutputLine({ line, label, logSummaryLines })) eventCount++;
      }
    });

    proc.stderr.on('data', (data) => {
      rawStderr += data.toString();
      const trimmed = data.toString().trim();
      if (trimmed) debug(`[${label}:stderr] ${trimmed.substring(0, 300)}`);
    });

    proc.on('close', (code) => {
      clearInterval(heartbeat);
      const duration = Date.now() - startTime;
      log(`[${label}] Finished: exit=${code}, duration=${Math.floor(duration / 1000)}s, events=${eventCount}`);
      if (code !== 0) warn(`[${label}] Exited with code ${code}`);

      if (stdoutBuffer.trim()) {
        if (processOutputLine({ line: stdoutBuffer, label, logSummaryLines })) eventCount++;
      }

      if (logDir && ticketKey) {
        writeLogFile({ logDir, ticketKey, provider, label, code, elapsed: Math.floor(duration / 1000), eventCount, prompt, logSummaryLines, artifactDir });
      }

      resolve({ stdout: rawStdout, stderr: rawStderr, exitCode: code, duration });
    });

    proc.on('error', (error) => {
      clearInterval(heartbeat);
      reject(new Error(`Failed to spawn ${command} (${label}): ${error.message}`));
    });
  });
}
