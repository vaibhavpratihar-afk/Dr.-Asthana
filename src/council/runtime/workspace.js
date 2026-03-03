/**
 * Council Workspace - file-backed observability and human feedback bridge.
 *
 * Responsibility:
 * - Persist stage artifacts per round for auditability.
 * - Maintain status.md as live run heartbeat.
 * - Support one-shot human steering through human-feedback.md.
 *
 * Contract:
 * - Workspace IO is best-effort and must never crash pipeline execution.
 * - Public helpers are side-effect utilities; they return null/no-op on IO failure.
 */

import fs from 'fs';
import path from 'path';
import { log, warn, debug } from '../../utils/logger.js';

const STATUS_FILENAME = 'status.md';
const HUMAN_FEEDBACK_FILENAME = 'human-feedback.md';

const tryWorkspaceOp = (fn, onError) => {
  try {
    return fn();
  } catch {
    // Workspace writes are observability helpers; never crash the pipeline on IO issues.
    if (onError) onError();
    return null;
  }
};

const writeWorkspaceFile = (workspace, relativePath, content) => {
  const filePath = path.join(workspace, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
};

/**
 * Initialize the council workspace directory with an initial status file.
 * Returns the workspace path, or null if checkpointDir is not provided.
 */
export function initWorkspace(checkpointDir, label, maxRounds) {
  if (!checkpointDir) return null;
  return tryWorkspaceOp(() => {
    const workspace = path.join(checkpointDir, 'council');
    fs.mkdirSync(workspace, { recursive: true });
    const status = buildStatusMarkdown({ label, maxRounds, round: 0, phase: 'starting', includeStarted: true });
    writeWorkspaceFile(workspace, STATUS_FILENAME, status);
    debug(`Initialized council workspace at ${workspace}`);
    return workspace;
  }, () => warn('Failed to initialize council workspace'));
}

/**
 * Overwrite status.md with the current council state.
 */
export function updateStatus(workspace, label, maxRounds, round, phase, extra = {}) {
  if (!workspace) return;
  tryWorkspaceOp(() => {
    const status = buildStatusMarkdown({ label, maxRounds, round, phase, extra, includeStarted: false });
    writeWorkspaceFile(workspace, STATUS_FILENAME, status);
  });
}

/**
 * Check for a human-feedback.md file in the workspace.
 * If found, reads content, deletes the file, and returns the content.
 * This enables human-in-the-loop steering mid-council.
 */
export function checkHumanFeedback(workspace) {
  if (!workspace) return null;
  return tryWorkspaceOp(() => {
    const feedbackPath = path.join(workspace, HUMAN_FEEDBACK_FILENAME);
    if (!fs.existsSync(feedbackPath)) return null;
    const content = fs.readFileSync(feedbackPath, 'utf-8').trim();
    // Feedback is single-use by design to avoid replaying stale instructions.
    fs.unlinkSync(feedbackPath);
    if (content) {
      log('Human feedback detected and consumed from council workspace');
      return content;
    }
    return null;
  });
}

const buildStatusMarkdown = ({ label, maxRounds, round, phase, extra = {}, includeStarted }) => {
  const lines = [
    '# Council Status',
    '',
    `**Label:** ${label}`,
    `**Max Rounds:** ${maxRounds}`,
  ];

  lines.push(`**${includeStarted ? 'Started' : 'Updated'}:** ${new Date().toISOString()}`);
  lines.push(`**Phase:** ${phase}`);
  lines.push(`**Round:** ${round}/${maxRounds}`);

  if (extra.agreed !== undefined) lines.push(`**Agreed:** ${extra.agreed ? 'Yes' : 'No'}`);
  if (extra.result) lines.push(`**Result:** ${extra.result}`);

  return lines.join('\n');
};
