/**
 * Checkpoint persistence.
 *
 * Storage: .pipeline-state/<ticketKey>/state.json
 */

import fs from 'fs';
import path from 'path';
import { log, debug } from '../utils/logger.js';

const STATE_DIR = path.join(process.cwd(), '.pipeline-state');

function getCheckpointDir(ticketKey) {
  return path.join(STATE_DIR, ticketKey);
}

/**
 * Save checkpoint for a ticket at a given step.
 *
 * @param {string} ticketKey
 * @param {string} step - Step name (e.g., 'FETCH_TICKET', 'BUILD_CHEATSHEET')
 * @param {object} data - Arbitrary data to persist
 */
export function saveCheckpoint(ticketKey, step, data) {
  const dir = getCheckpointDir(ticketKey);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const state = {
    currentStep: step,
    timestamp: new Date().toISOString(),
    ...data,
  };

  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  debug(`Checkpoint saved: ${ticketKey} @ ${step}`);
}

/**
 * Clear checkpoint for a ticket.
 */
export function clearCheckpoint(ticketKey) {
  const dir = getCheckpointDir(ticketKey);
  const statePath = path.join(dir, 'state.json');

  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
    log(`Checkpoint cleared: ${ticketKey}`);
  }
}

/**
 * Get the checkpoint directory path for a ticket.
 */
export function getCheckpointPath(ticketKey) {
  return getCheckpointDir(ticketKey);
}
