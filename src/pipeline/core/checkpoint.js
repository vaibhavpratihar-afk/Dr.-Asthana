import fs from 'fs';
import path from 'path';

const STATE_DIR = path.join(process.cwd(), '.pipeline-state');

export function getCheckpointPath(ticketKey) {
  return path.join(STATE_DIR, ticketKey);
}
